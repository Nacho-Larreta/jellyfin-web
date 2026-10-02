import { CancelledError } from '@tanstack/react-query';

import cardBuilder from 'components/cardbuilder/cardBuilder';
import { getFavoriteCardImage } from 'components/favorites/favoriteCardImage';
import { getFavoriteSections } from 'components/favorites/favoriteSections';
import { readFavoriteSection } from 'components/favorites/favoriteSectionRead';
import { createHomeImageScope } from 'components/homesections/homeImageScope';
import focusManager from 'components/focusManager';
import layoutManager from 'components/layoutManager';
import { appRouter } from 'components/router/appRouter';
import itemShortcuts from 'components/shortcuts';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import serverNotifications from 'scripts/serverNotifications';
import Events from 'utils/events';
import { createSessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';
import { createSessionScopedReadApi, SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';

import 'elements/emby-scroller/emby-scroller';
import 'components/favorites/favorites.scss';

const FAVORITES_READ_TIMEOUT_MS = 12000;

function getRouteUrl(section, serverId) {
    return appRouter.getRouteUrl('list', {
        serverId: serverId,
        itemTypes: section.types,
        isFavorite: true
    });
}

function renderCards(section, items, serverId) {
    const cardLayout = false;
    const leadingButtons = layoutManager.tv ? [{
        name: globalize.translate('All'),
        id: 'more',
        icon: 'favorite',
        routeUrl: getRouteUrl(section, serverId)
    }] : null;
    let lines = 0;

    if (section.showTitle) {
        lines++;
    }

    if (section.showYear) {
        lines++;
    }

    if (section.showParentTitle) {
        lines++;
    }

    const descriptors = new Map();
    const html = cardBuilder.getCardsHtml({
        items: items,
        serverId: serverId,
        imagePresentation: (item, shape, index) => {
            const presentation = getFavoriteCardImage(item, shape, section);
            if (presentation.descriptor) descriptors.set(index, presentation.descriptor);
            return presentation;
        },
        preferThumb: section.preferThumb,
        shape: section.shape,
        centerText: section.centerText && !cardLayout,
        overlayText: section.overlayText !== false,
        showTitle: section.showTitle,
        showYear: section.showYear,
        showParentTitle: section.showParentTitle,
        scalable: true,
        coverImage: section.coverImage,
        overlayPlayButton: section.overlayPlayButton,
        overlayMoreButton: section.overlayMoreButton && !cardLayout,
        action: section.action,
        allowBottomPadding: false,
        cardLayout: cardLayout,
        leadingButtons: leadingButtons,
        lines: lines
    });
    return { html, descriptors };
}

function createSections(elem, serverId) {
    const sections = getFavoriteSections();
    let html = '';

    for (const section of sections) {
        let sectionClass = 'verticalSection';

        if (!section.showTitle) {
            sectionClass += ' verticalSection-extrabottompadding';
        }

        html += '<div class="' + sectionClass + ' hide">';
        html += '<div class="sectionTitleContainer sectionTitleContainer-cards padded-left">';

        if (layoutManager.tv) {
            html += '<h2 class="sectionTitle sectionTitle-cards">' + globalize.translate(section.name) + '</h2>';
        } else {
            html += '<a is="emby-linkbutton" href="' + getRouteUrl(section, serverId) + '" class="more button-flat button-flat-mini sectionTitleTextButton">';
            html += '<h2 class="sectionTitle sectionTitle-cards">';
            html += globalize.translate(section.name);
            html += '</h2>';
            html += '<span class="material-icons chevron_right" aria-hidden="true"></span>';
            html += '</a>';
        }

        html += '</div>';
        html += '<div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true"><div class="itemsContainer scrollSlider focuscontainer-x"></div></div>';
        html += '</div>';
    }

    elem.innerHTML = html;
    window.CustomElements.upgradeSubtree(elem);

    return Array.from(elem.querySelectorAll('.verticalSection')).map((element, index) => ({
        section: sections[index],
        element,
        items: element.querySelector('.itemsContainer')
    }));
}

class FavoritesTab {
    constructor(view) {
        this.view = view;
        this.sectionsContainer = view.querySelector('.sections');
        this.generation = 0;
        this.refreshGeneration = 0;
        this.paused = true;
        this.sections = [];
        this.read = null;
        this.assertCurrent = null;
        this.client = null;
        this.port = null;
        this.imageScope = null;
        this.abortController = null;
        this.refreshTimer = null;
        this.unsubscribeAuthority = null;
        this.authorityHandler = null;
        this.notificationHandler = null;
        this.clickHandler = null;
        this.commandGuard = null;
    }

    onResume(options = {}) {
        this.onPause();
        const generation = ++this.generation;
        this.paused = false;
        const client = ServerConnections.currentApiClient();
        let port;
        try {
            port = client && getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(client);
        } catch {
            port = null;
        }
        if (!client || !port) {
            this.setStatus('ErrorDefault');
            return Promise.resolve();
        }

        let read;
        try {
            read = createSessionScopedReadApi(client, port);
        } catch {
            this.onPause();
            this.setStatus('ErrorDefault');
            return Promise.resolve();
        }
        this.read = read;
        this.client = client;
        this.port = port;
        const assertCurrent = () => {
            if (this.paused || this.generation !== generation || !this.view?.isConnected
                || !this.view.contains(this.sectionsContainer) || this.read !== read) {
                throw new SessionReadCancelledError();
            }
            read.assertCurrent();
        };
        this.assertCurrent = assertCurrent;
        const verifyAuthority = () => {
            try {
                assertCurrent();
            } catch {
                if (this.generation === generation) this.onPause();
            }
        };
        this.unsubscribeAuthority = ServerConnections.subscribeSessionSwitchEnvelope(read.identity.serverId, verifyAuthority);
        this.authorityHandler = verifyAuthority;
        for (const event of ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted']) {
            Events.on(ServerConnections, event, verifyAuthority);
        }
        this.notificationHandler = (_event, eventClient) => {
            if (eventClient !== client) return;
            try {
                assertCurrent();
                this.scheduleRefresh(generation);
            } catch {
                verifyAuthority();
            }
        };
        Events.on(serverNotifications, 'UserDataChanged', this.notificationHandler);
        try {
            assertCurrent();
        } catch {
            this.onPause();
            return Promise.resolve();
        }
        this.setStatus('MessagePleaseWait');
        const userController = new window['AbortController']();
        this.abortController = userController;
        let userTimeout;
        const userRead = Promise.race([
            read.getCurrentUser(userController.signal),
            new Promise((_, reject) => {
                userTimeout = setTimeout(() => {
                    userController.abort();
                    reject(new Error('Favorites user read timed out'));
                }, FAVORITES_READ_TIMEOUT_MS);
            })
        ]).finally(() => clearTimeout(userTimeout));
        return userRead.then(user => {
            assertCurrent();
            if (!user?.Id || user.Id !== read.identity.profileUserId) {
                this.onPause();
                throw new SessionReadCancelledError();
            }
            const sections = createSections(this.sectionsContainer, read.identity.serverId);
            assertCurrent();
            this.sections = sections;
            this.clickHandler = event => {
                try {
                    assertCurrent();
                    const container = event.currentTarget;
                    if (container.contains(event.target)) itemShortcuts.onClick.call(container, event);
                } catch {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    verifyAuthority();
                }
            };
            this.commandGuard = event => {
                try {
                    assertCurrent();
                } catch {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    verifyAuthority();
                }
            };
            for (const { items } of this.sections) {
                items.addEventListener('click', this.clickHandler, true);
                items.addEventListener('command', this.commandGuard, true);
                itemShortcuts.on(items, { click: false });
            }
            return this.refresh(generation, assertCurrent, client, port).then(() => {
                assertCurrent();
                if (options.autoFocus) focusManager.autoFocus(this.view);
            });
        }).catch(error => {
            if (this.generation !== generation || this.read !== read) return;
            this.onPause();
            if (!(error instanceof CancelledError)) this.setStatus('ErrorDefault');
        });
    }

    onPause() {
        this.generation++;
        this.refreshGeneration++;
        this.paused = true;
        this.abortController?.abort();
        this.abortController = null;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.unsubscribeAuthority?.();
        this.unsubscribeAuthority = null;
        if (this.authorityHandler) {
            for (const event of ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted']) {
                Events.off(ServerConnections, event, this.authorityHandler);
            }
            this.authorityHandler = null;
        }
        if (this.notificationHandler) Events.off(serverNotifications, 'UserDataChanged', this.notificationHandler);
        this.notificationHandler = null;
        for (const { items } of this.sections) {
            if (this.clickHandler) items.removeEventListener('click', this.clickHandler, true);
            if (this.commandGuard) items.removeEventListener('command', this.commandGuard, true);
            itemShortcuts.off(items, { click: false });
        }
        this.clickHandler = null;
        this.commandGuard = null;
        this.sections = [];
        this.imageScope?.dispose();
        this.imageScope = null;
        this.read = null;
        this.assertCurrent = null;
        this.client = null;
        this.port = null;
        this.sectionsContainer?.replaceChildren();
    }

    destroy() {
        this.onPause();
        this.sectionsContainer = null;
        this.view = null;
    }

    setStatus(key) {
        if (!this.view?.isConnected || !this.view.contains(this.sectionsContainer)) return;
        this.sectionsContainer.querySelector('.favoriteSectionsStatus')?.remove();
        const status = document.createElement('p');
        status.className = 'favoriteSectionsStatus padded-left';
        status.setAttribute('role', 'status');
        status.textContent = globalize.translate(key);
        if (!this.sections.length) this.sectionsContainer.replaceChildren(status);
        else this.sectionsContainer.appendChild(status);
    }

    scheduleRefresh(generation) {
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this.paused || this.generation !== generation || !this.read || !this.assertCurrent) return;
            const client = this.client;
            const port = this.port;
            if (!client || !port || client !== ServerConnections.currentApiClient()) {
                this.onPause();
                return;
            }
            const assertCurrent = this.assertCurrent;
            void this.refresh(generation, assertCurrent, client, port).catch(() => {
                if (this.generation === generation) this.onPause();
            });
        }, 100);
    }

    async refresh(generation, assertCurrent, client, port) {
        assertCurrent();
        this.abortController?.abort();
        this.imageScope?.dispose();
        const refreshGeneration = ++this.refreshGeneration;
        const controller = new window['AbortController']();
        this.abortController = controller;
        const imageScope = createHomeImageScope(this.sectionsContainer, createSessionImageRead(client, port));
        this.imageScope = imageScope;
        this.sectionsContainer.querySelector('.favoriteSectionsStatus')?.remove();
        const focusedId = this.view.contains(document.activeElement) ?
            document.activeElement.closest('[data-id]')?.getAttribute('data-id') : null;
        const results = this.sections.map(() => ({ status: 'rejected' }));
        const reads = this.sections.map(async ({ section }, index) => {
            try {
                const value = await readFavoriteSection(this.read, section.types, controller.signal);
                results[index] = { status: 'fulfilled', value };
            } catch {
                results[index] = { status: 'rejected' };
            }
        });
        let timeoutId;
        let timedOut = false;
        await Promise.race([
            Promise.all(reads),
            new Promise(resolve => {
                timeoutId = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    resolve();
                }, FAVORITES_READ_TIMEOUT_MS);
            })
        ]);
        clearTimeout(timeoutId);
        if (controller.signal.aborted && !timedOut || this.refreshGeneration !== refreshGeneration || this.generation !== generation) return;
        assertCurrent();
        let failed = 0;
        let visible = 0;
        for (const [index, result] of results.entries()) {
            const { section, element, items } = this.sections[index];
            if (result.status === 'rejected') {
                failed++;
                element.classList.add('hide');
                items.replaceChildren();
                continue;
            }
            if (!result.value.length) {
                element.classList.add('hide');
                items.replaceChildren();
                continue;
            }
            const serverId = this.read.identity.serverId;
            const itemsForServer = result.value.map(item => ({ ...item, ServerId: serverId }));
            const { html, descriptors } = renderCards(section, itemsForServer, serverId);
            assertCurrent();
            items.innerHTML = html;
            assertCurrent();
            element.classList.remove('hide');
            visible++;
            for (const image of items.querySelectorAll('img[data-session-image-slot]')) {
                assertCurrent();
                const descriptor = descriptors.get(Number(image.dataset.sessionImageSlot));
                if (descriptor) imageScope.add(image, descriptor, () => image.remove());
            }
        }
        assertCurrent();
        if (failed) this.setStatus('ErrorDefault');
        else if (!visible) this.setStatus('MessageNoFavoritesAvailable');
        if (focusedId) {
            const matching = Array.from(this.sectionsContainer.querySelectorAll('[data-id]'))
                .find(element => element.getAttribute('data-id') === focusedId);
            if (matching) focusManager.focus(matching);
            else if (visible) focusManager.autoFocus(this.sectionsContainer);
        }
    }
}

export default FavoritesTab;
