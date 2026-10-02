import { ServerConnections } from 'lib/jellyfin-apiclient';
import browser from '../../scripts/browser';
import { playbackManager } from '../playback/playbackmanager';
import dom from '../../utils/dom';
import * as userSettings from '../../scripts/settings/userSettings';

import './backdrop.scss';

function enableAnimation() {
    return !browser.slow;
}

function enableRotation() {
    return !browser.tv;
}

let backdropContainer;
function getBackdropContainer() {
    if (!backdropContainer?.isConnected) {
        backdropContainer = document.querySelector('.backdropContainer');
    }

    if (!backdropContainer) {
        backdropContainer = document.createElement('div');
        backdropContainer.classList.add('backdropContainer');
        document.body.insertBefore(backdropContainer, document.body.firstChild);
    }

    return backdropContainer;
}

let backgroundContainer;
function getBackgroundContainer() {
    if (!backgroundContainer?.isConnected) {
        backgroundContainer = document.querySelector('.backgroundContainer');
    }
    return backgroundContainer;
}

function setBackgroundContainerBackgroundEnabled() {
    const container = getBackgroundContainer();
    if (!container) return;

    if (hasInternalBackdrop || hasExternalBackdrop) {
        container.classList.add('withBackdrop');
    } else {
        container.classList.remove('withBackdrop');
    }
}

let hasInternalBackdrop;
function internalBackdrop(isEnabled) {
    hasInternalBackdrop = isEnabled;
    setBackgroundContainerBackgroundEnabled();
}

let hasExternalBackdrop;
export function externalBackdrop(isEnabled) {
    hasExternalBackdrop = isEnabled;
    setBackgroundContainerBackgroundEnabled();
}

function getItemImageUrls(item, imageOptions) {
    imageOptions = imageOptions || {};

    const apiClient = ServerConnections.getApiClient(item.ServerId);
    if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
        return item.BackdropImageTags.map((imgTag, index) => {
            return apiClient.getScaledImageUrl(item.BackdropItemId || item.Id, Object.assign(imageOptions, {
                type: 'Backdrop',
                tag: imgTag,
                maxWidth: dom.getScreenWidth(),
                index: index
            }));
        });
    }

    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
        return item.ParentBackdropImageTags.map((imgTag, index) => {
            return apiClient.getScaledImageUrl(item.ParentBackdropItemId, Object.assign(imageOptions, {
                type: 'Backdrop',
                tag: imgTag,
                maxWidth: dom.getScreenWidth(),
                index: index
            }));
        });
    }

    return [];
}

function getImageUrls(items, imageOptions) {
    const list = [];
    const onImg = img => {
        list.push(img);
    };

    for (let i = 0, length = items.length; i < length; i++) {
        const itemImages = getItemImageUrls(items[i], imageOptions);
        itemImages.forEach(onImg);
    }

    return list;
}

function enabled() {
    return userSettings.enableBackdrops();
}

let activeOwner;

function current(owner, render = owner.render) {
    return owner.valid && activeOwner === owner && render === owner.render;
}

function clearRender(owner) {
    const render = owner.render;
    if (!render) return;

    owner.render = null;
    if (render.interval) clearInterval(render.interval);
    if (render.removalTimer) clearTimeout(render.removalTimer);
    for (const image of render.pending) {
        image.onload = null;
        image.onerror = null;
        image.src = '';
    }
    render.pending.clear();
    for (const element of render.elements) element.remove();
    render.elements.clear();
    for (const url of render.ownedUrls) URL.revokeObjectURL(url);
    render.ownedUrls.clear();
}

function invalidate(owner) {
    if (!owner.valid) return;
    owner.valid = false;
    if (activeOwner === owner) activeOwner = null;
    clearRender(owner);
    if (!activeOwner) internalBackdrop(false);
    owner.onInvalidate?.();
}

function claimOwner(assertCurrent = () => true, onInvalidate) {
    const previous = activeOwner;
    const owner = { valid: true, render: null, assertCurrent, onInvalidate };
    activeOwner = owner;
    if (previous) invalidate(previous);
    if (activeOwner === owner) {
        getBackdropContainer().replaceChildren();
        internalBackdrop(false);
    }
    return owner;
}

function validOwner(owner) {
    if (!current(owner)) return false;
    try {
        if (owner.assertCurrent() === false) throw new Error('Backdrop owner expired');
        return true;
    } catch {
        invalidate(owner);
        return false;
    }
}

function loadImage(owner, render, url) {
    if (!validOwner(owner) || !current(owner, render)) return;
    const imageGeneration = ++render.imageGeneration;
    const image = new Image();
    render.pending.add(image);
    image.onload = () => {
        render.pending.delete(image);
        if (!validOwner(owner) || !current(owner, render)
            || imageGeneration !== render.imageGeneration) return;

        const container = getBackdropContainer();
        const existing = Array.from(render.elements).find(element => element.getAttribute('data-url') === url);
        if (existing) return;

        const element = document.createElement('div');
        element.classList.add('backdropImage', 'displayingBackdropImage');
        if (enableAnimation()) element.classList.add('backdropImageFadeIn');
        element.style.backgroundImage = `url('${url}')`;
        element.setAttribute('data-url', url);
        container.appendChild(element);
        render.elements.add(element);
        internalBackdrop(true);

        if (render.removalTimer) clearTimeout(render.removalTimer);
        const oldElements = Array.from(render.elements).filter(candidate => candidate !== element);
        render.removalTimer = setTimeout(() => {
            render.removalTimer = null;
            if (!validOwner(owner) || !current(owner, render)
                || imageGeneration !== render.imageGeneration) return;
            for (const old of oldElements) {
                old.remove();
                render.elements.delete(old);
            }
        }, 1600);
    };
    image.onerror = () => {
        render.pending.delete(image);
    };
    image.src = url;
}

function rotate(owner, render) {
    if (!validOwner(owner) || !current(owner, render)
        || render.pauseForVideo && playbackManager.isPlayingLocally(['Video'])) return;
    render.index = (render.index + 1) % render.images.length;
    loadImage(owner, render, render.images[render.index]);
}

function renderImages(owner, images, ownedUrls = [], pauseForVideo = true) {
    if (!validOwner(owner)) return false;
    clearRender(owner);
    getBackdropContainer().replaceChildren();
    internalBackdrop(false);
    const list = Array.isArray(images) ? images.filter(url => typeof url === 'string' && url.length) : [];
    const render = {
        images: list,
        index: -1,
        imageGeneration: 0,
        pauseForVideo,
        interval: null,
        removalTimer: null,
        pending: new Set(),
        elements: new Set(),
        ownedUrls: new Set(ownedUrls)
    };
    owner.render = render;
    if (!list.length) return true;
    if (list.length > 1 && enableRotation()) {
        render.interval = setInterval(() => rotate(owner, render), 10000);
    }
    rotate(owner, render);
    return true;
}

export function acquireBackdropOwner(assertCurrent, onInvalidate) {
    const owner = claimOwner(assertCurrent, onInvalidate);
    return Object.freeze({
        isCurrent: () => validOwner(owner),
        setImages: (images, ownedUrls) => renderImages(owner, images, ownedUrls),
        clear: () => renderImages(owner, []),
        dispose: () => invalidate(owner)
    });
}

export function clearBackdrop(clearAll) {
    const owner = claimOwner();
    if (!current(owner)) return;
    if (clearAll) hasExternalBackdrop = false;
    internalBackdrop(false);
}

export function setBackdrops(items, imageOptions, isEnabled = false) {
    if (isEnabled || enabled()) {
        const images = getImageUrls(items, imageOptions);

        if (images.length) {
            setBackdropImages(images);
        } else {
            clearBackdrop();
        }
    }
}

export function setBackdropImages(images) {
    renderImages(claimOwner(), images);
}

export function setBackdrop(url, imageOptions) {
    if (url && typeof url !== 'string') {
        url = getImageUrls([url], imageOptions)[0];
    }

    if (url) {
        renderImages(claimOwner(), [url], [], false);
    } else {
        clearBackdrop();
    }
}

/**
 * @enum TransparencyLevel
 */
export const TRANSPARENCY_LEVEL = {
    Full: 'full',
    Backdrop: 'backdrop',
    None: 'none'
};

/**
 * Sets the backdrop, background, and document transparency
 * @param {TransparencyLevel} level The level of transparency
 */
export function setBackdropTransparency(level) {
    const backdropElem = getBackdropContainer();
    const backgroundElem = getBackgroundContainer();

    if (level === TRANSPARENCY_LEVEL.Full || level === 2) {
        clearBackdrop(true);
        document.documentElement.classList.add('transparentDocument');
        backgroundElem.classList.add('backgroundContainer-transparent');
        backdropElem.classList.add('hide');
    } else if (level === TRANSPARENCY_LEVEL.Backdrop || level === 1) {
        externalBackdrop(true);
        document.documentElement.classList.add('transparentDocument');
        backgroundElem.classList.add('backgroundContainer-transparent');
        backdropElem.classList.add('hide');
    } else {
        externalBackdrop(false);
        document.documentElement.classList.remove('transparentDocument');
        backgroundElem.classList.remove('backgroundContainer-transparent');
        backdropElem.classList.remove('hide');
    }
}
