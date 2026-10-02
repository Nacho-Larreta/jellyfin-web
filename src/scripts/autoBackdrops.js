import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';

import { acquireBackdropOwner, clearBackdrop } from '../components/backdrop/backdrop';
import viewManager from '../components/viewManager/viewManager';
import * as userSettings from './settings/userSettings';
import libraryMenu from './libraryMenu';
import { pageClassOn } from '../utils/dashboard';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { createSessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';
import Events from 'utils/events';
import { readPublicSplashscreen } from './autoBackdropBranding';

const MAX_IMAGES = 20;
const MAX_CONCURRENT_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_BYTES = 48 * 1024 * 1024;
const AUTHORITY_EVENTS = ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted'];

let activation;
let shownPage;

function currentPage(page) {
    return page.isConnected && (shownPage === page
        || !shownPage && viewManager.currentView() === page);
}

document.addEventListener('viewshow', event => {
    const page = event.target;
    if (!page.classList?.contains('page') || !page.isConnected) return;
    shownPage = page;
    if (activation && activation.page !== page) retire(activation);
});

document.addEventListener('viewhide', event => {
    if (shownPage === event.target) shownPage = null;
});

function retire(current) {
    if (!current || current.retired) return;
    current.retired = true;
    if (activation === current) activation = null;
    current.controller.abort();
    current.page.removeEventListener('viewhide', current.retire);
    current.page.removeEventListener('pagehide', current.retire);
    current.page.removeEventListener('viewdestroy', current.retire);
    current.disconnectObserver?.disconnect();
    current.unsubscribeAuthority?.();
    current.unsubscribeAdmission?.();
    for (const event of AUTHORITY_EVENTS) Events.off(ServerConnections, event, current.retire);
    current.owner?.dispose();
    for (const url of current.pendingUrls) URL.revokeObjectURL(url);
    current.pendingUrls.clear();
}

function start(page, client, privateRead) {
    retire(activation);
    const current = {
        page,
        client,
        serverId: client?.serverId(),
        serverAddress: client?.serverAddress(),
        controller: new window['AbortController'](),
        pendingUrls: new Set(),
        retired: false,
        owner: null,
        unsubscribeAuthority: null,
        unsubscribeAdmission: null,
        application: null,
        disconnectObserver: null,
        assertSession: null
    };
    current.retire = () => retire(current);
    current.assertCurrent = () => {
        if (current.retired || activation !== current || current.controller.signal.aborted
            || !currentPage(page)
            || page.classList.contains('selfBackdropPage')
            || !client || ServerConnections.currentApiClient() !== client
            || ServerConnections.getApiClient(current.serverId) !== client
            || client.serverId() !== current.serverId
            || client.serverAddress() !== current.serverAddress) {
            throw new Error('Automatic backdrop activation expired');
        }
        current.assertSession?.();
    };
    current.inspect = () => {
        try {
            current.assertCurrent();
        } catch {
            retire(current);
        }
    };
    activation = current;
    page.addEventListener('viewhide', current.retire);
    page.addEventListener('pagehide', current.retire);
    page.addEventListener('viewdestroy', current.retire);
    current.disconnectObserver = new window['MutationObserver'](() => {
        if (!page.isConnected) retire(current);
    });
    current.disconnectObserver.observe(document.body, { childList: true, subtree: true });
    for (const event of AUTHORITY_EVENTS) Events.on(ServerConnections, event, current.retire);
    if (current.serverId) {
        current.unsubscribeAuthority = ServerConnections.subscribeSessionSwitchEnvelope(
            current.serverId, current.inspect);
        if (privateRead) {
            try {
                current.application = getWebSessionSwitchApplication(ServerConnections);
                current.unsubscribeAdmission = current.application.subscribeSessionAdmission(
                    current.serverId, current.inspect);
            } catch {
                retire(current);
            }
        }
    }
    return current;
}

function claim(current) {
    current.assertCurrent();
    current.owner = acquireBackdropOwner(current.assertCurrent, current.retire);
    current.assertCurrent();
}

function backdropItems(read, type, parentId) {
    return read.getItems({
        userId: read.identity.profileUserId,
        sortBy: [ItemSortBy.IsFavoriteOrLiked, ItemSortBy.Random],
        limit: MAX_IMAGES,
        recursive: true,
        includeItemTypes: type ? type.split(',') : undefined,
        imageTypes: [ImageType.Backdrop],
        parentId: parentId || undefined,
        enableTotalRecordCount: false,
        maxOfficialRating: parentId ? '' : 'PG-13'
    });
}

function imageDescriptors(result, serverId) {
    if (!Array.isArray(result?.Items)) return [];
    return result.Items.slice(0, MAX_IMAGES).flatMap(item => {
        if (item?.ServerId && item.ServerId !== serverId) return [];
        const tag = item?.BackdropImageTags?.[0];
        if (typeof item?.Id !== 'string' || typeof tag !== 'string') return [];
        return [{ itemId: item.Id, type: ImageType.Backdrop, index: 0, tag,
            maxWidth: Math.max(1, Math.min(3840, Math.floor(window.innerWidth))) }];
    });
}

async function loadPrivateImages(current, descriptors, images) {
    const urls = [];
    let next = 0;
    let retainedBytes = 0;
    async function worker() {
        while (next < descriptors.length) {
            current.assertCurrent();
            const index = next++;
            const descriptor = descriptors[index];
            const remaining = MAX_RETAINED_BYTES - retainedBytes;
            if (remaining <= 0) return;
            try {
                const blob = await images.fetchImage(descriptor, current.controller.signal,
                    Math.min(MAX_IMAGE_BYTES, remaining));
                current.assertCurrent();
                if (blob.size > MAX_RETAINED_BYTES - retainedBytes) continue;
                const url = URL.createObjectURL(blob);
                current.pendingUrls.add(url);
                current.assertCurrent();
                retainedBytes += blob.size;
                urls[index] = url;
            } catch {
                current.assertCurrent();
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_IMAGES, descriptors.length) }, worker));
    current.assertCurrent();
    const available = urls.filter(Boolean);
    if (current.owner.setImages(available, available)) current.pendingUrls.clear();
}

async function showPrivate(current, type, parentId) {
    const client = current.client;
    let port;
    try {
        port = current.application?.captureBoundSessionRead(client);
    } catch {
        return;
    }
    if (!port) return;
    const read = createSessionScopedReadApi(client, port);
    current.assertSession = read.assertCurrent;
    try {
        claim(current);
        const result = await backdropItems(read, type, parentId);
        current.assertCurrent();
        const descriptors = imageDescriptors(result, read.identity.serverId);
        if (!descriptors.length) {
            current.owner.clear();
            return;
        }
        await loadPrivateImages(current, descriptors, createSessionImageRead(client, port));
    } catch {
        current.inspect();
        if (!current.retired) current.owner?.clear();
    }
}

async function showPublicBranding(current) {
    try {
        claim(current);
        const blob = await readPublicSplashscreen(
            current.serverAddress, current.controller.signal, current.assertCurrent);
        current.assertCurrent();
        if (!blob) {
            current.owner.clear();
            return;
        }
        const url = URL.createObjectURL(blob);
        current.pendingUrls.add(url);
        current.assertCurrent();
        if (current.owner.setImages([url], [url])) current.pendingUrls.clear();
    } catch {
        current.inspect();
        if (!current.retired) current.owner?.clear();
    }
}

pageClassOn('pageshow', 'page', function () {
    const page = this;
    if (!currentPage(page)) return;
    retire(activation);
    if (page.classList.contains('selfBackdropPage')) return;
    if (!page.classList.contains('backdropPage')) {
        clearBackdrop();
        return;
    }
    const type = page.getAttribute('data-backdroptype');
    if (type !== 'splashscreen' && !userSettings.enableBackdrops()) {
        page.classList.remove('backdropPage');
        clearBackdrop();
        return;
    }
    clearBackdrop();
    const current = start(page, ServerConnections.currentApiClient(), type !== 'splashscreen');
    if (type === 'splashscreen') {
        void showPublicBranding(current);
    } else {
        const parentId = page.classList.contains('globalBackdropPage') ? '' : libraryMenu.getTopParentId();
        void showPrivate(current, type, parentId);
    }
});
