import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { createSessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';
import Events from 'utils/events';

const AUTHORITY_EVENTS = ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted'];
const MAX_ARTWORK_BYTES = 512 * 1024;
const OWNER_VERSION = 1;

function opaqueId() {
    const bytes = new Uint8Array(16);
    window['crypto'].getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function closeNative(notification) {
    try {
        if (typeof notification.close === 'function') await notification.close();
        else if (typeof notification.cancel === 'function') await notification.cancel();
        else return false;
        return true;
    } catch {
        return false;
    }
}

export function createNotificationScope(client, getRegistration, notificationType, fallbackIcon) {
    const application = getWebSessionSwitchApplication(ServerConnections);
    const controller = new window['AbortController']();
    const ownerId = opaqueId();
    const publications = new Map();
    const latestConfirmedByTag = new Map();
    const latestIntentByTag = new Map();
    const nativeQueueTails = new Map();
    let retired = false;
    let nextPublicationOrder = 0;
    let cleanupFailureReported = false;
    let port;
    let unsubscribeAdmission;
    let unsubscribeEnvelope;
    let retirement;

    function assertCurrent() {
        if (retired || controller.signal.aborted
            || ServerConnections.currentApiClient() !== client
            || ServerConnections.getApiClient(client.serverId()) !== client) {
            throw new Error('Notification owner expired');
        }
        port?.assertCurrent();
    }

    function isCurrent(delivery) {
        try {
            assertCurrent();
        } catch {
            if (!retired) void retire();
            return false;
        }
        try {
            return !delivery || delivery.isCurrent() === true;
        } catch {
            return false;
        }
    }

    function reserve(category, delivery) {
        if (typeof category !== 'string' || !category || !isCurrent(delivery)) return null;
        const tag = `${ownerId}:${category}`;
        const reservation = Object.freeze({ tag, order: ++nextPublicationOrder });
        latestIntentByTag.set(tag, reservation);
        return reservation;
    }

    function isLatestIntent(reservation) {
        return latestIntentByTag.get(reservation.tag) === reservation;
    }

    function cancelReservation(reservation) {
        if (reservation && isLatestIntent(reservation)) {
            latestIntentByTag.delete(reservation.tag);
        }
    }

    async function runNativeInOrder(tag, operation) {
        const preceding = nativeQueueTails.get(tag);
        let release;
        const tail = new Promise(resolve => {
            release = resolve;
        });
        nativeQueueTails.set(tag, tail);
        if (preceding) await preceding;
        try {
            return await operation();
        } finally {
            release();
            if (nativeQueueTails.get(tag) === tail) nativeQueueTails.delete(tag);
        }
    }

    async function closePersistent(publication) {
        const registration = publication.registration;
        if (typeof registration?.getNotifications !== 'function') return false;
        try {
            const notifications = await registration.getNotifications({ tag: publication.tag });
            if (!Array.isArray(notifications)) return false;
            let closed = true;
            for (const notification of notifications) {
                const data = notification.data;
                if (data?.notificationOwnerVersion !== OWNER_VERSION
                    || data.notificationOwnerId !== ownerId
                    || data.notificationPublicationId !== publication.id) continue;
                closed = await closeNative(notification) && closed;
            }
            return closed;
        } catch {
            return false;
        }
    }

    function releaseArtwork(publication) {
        if (!publication.artwork) return;
        URL.revokeObjectURL(publication.artwork);
        publication.artwork = null;
    }

    async function closePublication(publication) {
        const pendingAtStart = publication.pending;
        if (publication.timer) {
            clearTimeout(publication.timer);
            publication.timer = null;
        }
        const closed = publication.registration ?
            await closePersistent(publication) :
            !publication.handle || await closeNative(publication.handle);
        if (pendingAtStart) return 'Pending';
        releaseArtwork(publication);
        if (!closed) return 'Failed';
        publications.delete(publication.id);
        if (latestConfirmedByTag.get(publication.tag) === publication) {
            latestConfirmedByTag.delete(publication.tag);
        }
        cancelReservation(publication.reservation);
        return 'Closed';
    }

    async function cleanupPublication(publication) {
        try {
            const outcome = await closePublication(publication);
            return outcome === 'Failed' ? await closePublication(publication) : outcome;
        } catch {
            return 'Failed';
        }
    }

    function reportCleanupFailure() {
        if (cleanupFailureReported) return;
        cleanupFailureReported = true;
        console.warn('[notifications] NativeCleanupFailed');
    }

    async function discardReplacedPublications(current) {
        for (const previous of publications.values()) {
            if (previous === current || previous.tag !== current.tag
                || previous.pending || previous.order >= current.order) continue;
            if (previous.registration && previous.registration === current.registration) {
                if (previous.timer) clearTimeout(previous.timer);
                releaseArtwork(previous);
                publications.delete(previous.id);
                continue;
            }
            if (await cleanupPublication(previous) === 'Failed') reportCleanupFailure();
        }
    }

    async function acceptShown(publication) {
        const latest = latestConfirmedByTag.get(publication.tag);
        if (!isLatestIntent(publication.reservation) || latest && latest.order > publication.order) {
            const cleanup = await cleanupPublication(publication);
            if (cleanup === 'Failed') {
                reportCleanupFailure();
                return 'CleanupFailed';
            }
            return 'Superseded';
        }
        latestConfirmedByTag.set(publication.tag, publication);
        await discardReplacedPublications(publication);
        return 'Shown';
    }

    function retire() {
        if (!retired) {
            retired = true;
            controller.abort();
            latestIntentByTag.clear();
            window.removeEventListener('pagehide', retire);
            unsubscribeEnvelope?.();
            unsubscribeAdmission?.();
            for (const event of AUTHORITY_EVENTS) Events.off(ServerConnections, event, retire);
        }
        if (retirement) return retirement;
        retirement = Promise.all(Array.from(publications.values(), cleanupPublication))
            .then(outcomes => {
                if (outcomes.includes('Failed')) reportCleanupFailure();
                return outcomes.every(outcome => outcome === 'Closed');
            }).finally(() => {
                retirement = null;
            });
        return retirement;
    }

    function inspect() {
        if (!isCurrent()) void retire();
    }

    function captureEvent(delivery) {
        if (!isCurrent(delivery)) return null;
        let eventPort;
        try {
            eventPort = application.captureBoundSessionRead(client);
            if (!eventPort || !isCurrent(delivery)) return null;
            eventPort.assertCurrent();
            return {
                read: createSessionScopedReadApi(client, eventPort),
                image: createSessionImageRead(client, eventPort)
            };
        } catch {
            inspect();
            return null;
        }
    }

    async function artworkUrl(item, image, delivery) {
        const tag = item?.ImageTags?.Primary;
        if (typeof tag !== 'string' || typeof item?.Id !== 'string') return null;
        try {
            const blob = await image.fetchImage({
                itemId: item.Id, type: ImageType.Primary, tag, maxWidth: 80
            }, controller.signal, MAX_ARTWORK_BYTES);
            if (!isCurrent(delivery)) return null;
            const url = URL.createObjectURL(blob);
            if (!isCurrent(delivery)) {
                URL.revokeObjectURL(url);
                return null;
            }
            return url;
        } catch {
            return null;
        }
    }

    async function showNonPersistent(title, options, publication) {
        const NativeNotification = notificationType;
        const nativeOptions = { ...options };
        delete nativeOptions.actions;
        let handle;
        try {
            handle = new NativeNotification(title, nativeOptions);
        } catch {
            return 'NativeDisplayFailed';
        }
        publication.handle = handle;
        if (typeof handle.addEventListener === 'function') {
            for (const event of ['show', 'error', 'close']) {
                handle.addEventListener(event, () => {
                    releaseArtwork(publication);
                    if (event === 'close') {
                        if (publication.timer) clearTimeout(publication.timer);
                        publications.delete(publication.id);
                        if (latestConfirmedByTag.get(publication.tag) === publication) {
                            latestConfirmedByTag.delete(publication.tag);
                        }
                        cancelReservation(publication.reservation);
                    }
                }, { once: true });
            }
        }
        publication.pending = true;
        try {
            await handle.show?.();
        } catch {
            return 'NativeDisplayFailed';
        } finally {
            publication.pending = false;
        }
        return 'Shown';
    }

    async function publish(options, timeoutMs, delivery, item, image, providedReservation) {
        if (!isCurrent(delivery) || notificationType?.permission !== 'granted') {
            cancelReservation(providedReservation);
            return 'Skipped';
        }
        const reservation = providedReservation || reserve(options.tag || opaqueId(), delivery);
        if (!reservation || !isLatestIntent(reservation)
            || options.tag && reservation.tag !== `${ownerId}:${options.tag}`) return 'Skipped';
        const artwork = item && image ? await artworkUrl(item, image, delivery) : null;
        if (!isCurrent(delivery) || !isLatestIntent(reservation)
            || notificationType?.permission !== 'granted') {
            if (artwork) URL.revokeObjectURL(artwork);
            cancelReservation(reservation);
            return 'Skipped';
        }
        const id = opaqueId();
        const tag = reservation.tag;
        const data = {
            ...options.data,
            serverId: port.identity.serverId,
            notificationOwnerVersion: OWNER_VERSION,
            notificationOwnerId: ownerId,
            notificationPublicationId: id
        };
        const prepared = {
            ...options,
            tag,
            data,
            icon: artwork || options.icon || fallbackIcon,
            badge: options.badge || fallbackIcon
        };
        let registration;
        try {
            registration = getRegistration();
        } catch {
            if (artwork) URL.revokeObjectURL(artwork);
            cancelReservation(reservation);
            return 'NativeDisplayFailed';
        }
        const publication = { id, tag, registration, artwork, handle: null, timer: null,
            pending: false, order: reservation.order, reservation };
        publications.set(id, publication);
        if (!isCurrent(delivery) || !isLatestIntent(reservation)
            || notificationType?.permission !== 'granted') {
            releaseArtwork(publication);
            publications.delete(id);
            cancelReservation(reservation);
            return 'Skipped';
        }
        const outcome = await runNativeInOrder(tag, async () => {
            if (!isCurrent(delivery) || !isLatestIntent(reservation)
                || notificationType?.permission !== 'granted') return 'Skipped';
            if (!registration) return showNonPersistent(prepared.title, prepared, publication);
            publication.pending = true;
            try {
                await registration.showNotification(prepared.title, prepared);
                return 'Shown';
            } catch {
                return 'NativeDisplayFailed';
            } finally {
                publication.pending = false;
            }
        });
        if (registration) releaseArtwork(publication);
        if (outcome !== 'Shown') {
            if (outcome === 'Skipped') {
                releaseArtwork(publication);
                publications.delete(id);
                cancelReservation(reservation);
                return 'Skipped';
            }
            const cleanup = await cleanupPublication(publication);
            if (cleanup === 'Failed') reportCleanupFailure();
            return cleanup === 'Closed' ? 'NativeDisplayFailed' : 'CleanupFailed';
        }
        if (!isCurrent()) {
            const cleanup = await cleanupPublication(publication);
            if (cleanup === 'Failed') {
                reportCleanupFailure();
                return 'CleanupFailed';
            }
            return cleanup === 'Closed' ? 'Retired' : 'CleanupFailed';
        }
        const accepted = await acceptShown(publication);
        if (accepted !== 'Shown') return accepted;
        if (timeoutMs) {
            publication.timer = setTimeout(() => {
                void cleanupPublication(publication).then(cleanup => {
                    if (cleanup === 'Failed') reportCleanupFailure();
                });
            }, timeoutMs);
        }
        return 'Shown';
    }

    try {
        window.addEventListener('pagehide', retire);
        for (const event of AUTHORITY_EVENTS) Events.on(ServerConnections, event, retire);
        const serverId = client.serverId();
        if (serverId) {
            unsubscribeEnvelope = ServerConnections.subscribeSessionSwitchEnvelope(serverId, inspect);
            unsubscribeAdmission = application.subscribeSessionAdmission(serverId, inspect);
        }
        port = application.captureBoundSessionRead(client);
        if (!port) throw new Error('Notification owner has no session read authority');
        assertCurrent();
    } catch {
        void retire();
        return null;
    }
    return { client, captureEvent, isCurrent, publish, reserve, cancelReservation, retire };
}
