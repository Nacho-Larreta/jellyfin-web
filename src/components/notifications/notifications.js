import serverNotifications from '../../scripts/serverNotifications';
import { playbackManager } from '../playback/playbackmanager';
import Events from '../../utils/events.ts';
import globalize from '../../lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { createNotificationScope } from './notificationScope';

import NotificationIcon from './notificationicon.png';

let currentScope;
let serviceWorkerRegistration;
let permissionHandler;

function observeRegistration() {
    const ready = window['navigator']['serviceWorker']?.ready;
    if (ready) {
        void Promise.resolve(ready).then(registration => {
            serviceWorkerRegistration = registration;
        }).catch(() => undefined);
    }
}

function scopeFor(client) {
    if (!client) return null;
    if (currentScope?.client === client && currentScope.isCurrent()) return currentScope;
    void currentScope?.retire();
    try {
        currentScope = createNotificationScope(client, () => serviceWorkerRegistration,
            window['Notification'], NotificationIcon);
    } catch {
        currentScope = null;
    }
    return currentScope;
}

function eligibleGesture(event) {
    return event.isTrusted && (event.type === 'click' && event.button === 0
        || event.type === 'keydown' && !event.repeat && !event.altKey && !event.ctrlKey
            && !event.metaKey && ['Enter', ' '].includes(event.key));
}

/** @returns {unknown} */
function requestNativePermission() {
    return Reflect.apply(window['Notification'].requestPermission, window['Notification'], []);
}

function detachPermissionHandler() {
    if (!permissionHandler) return;
    document.removeEventListener('click', permissionHandler);
    document.removeEventListener('keydown', permissionHandler);
    permissionHandler = null;
}

function armPermissionRequest() {
    detachPermissionHandler();
    if (window['Notification']?.permission !== 'default') return;
    const scope = scopeFor(ServerConnections.currentApiClient());
    if (!scope?.isCurrent()) return;

    let permissionRequested = false;
    permissionHandler = event => {
        if (!eligibleGesture(event)) return;
        detachPermissionHandler();
        if (!scope.isCurrent() || window['Notification']?.permission !== 'default') return;
        if (permissionRequested) return;
        permissionRequested = true;
        let request;
        try {
            request = requestNativePermission();
        } catch {
            return;
        }
        void Promise.resolve(request).catch(() => undefined);
    };
    document.addEventListener('click', permissionHandler);
    document.addEventListener('keydown', permissionHandler);
}

function eventContext(client, delivery) {
    if (window['Notification']?.permission !== 'granted') return null;
    try {
        if (delivery?.isCurrent() !== true) return null;
    } catch {
        return null;
    }
    const scope = scopeFor(client);
    if (!scope?.isCurrent(delivery)) return null;
    const event = scope.captureEvent(delivery);
    return event && { ...event, scope, delivery };
}

function publish(context, notification, timeoutMs, item, reservation) {
    void context.scope.publish(notification, timeoutMs, context.delivery, item, context.image, reservation)
        .catch(() => undefined);
}

function newItemNotification(item) {
    let body = item.Name;
    if (item.SeriesName) body = `${item.SeriesName} - ${body}`;
    return {
        title: `New ${item.Type}`,
        body,
        vibrate: true,
        tag: `newItem${item.Id}`,
        data: {}
    };
}

async function onLibraryChanged(data, context) {
    const added = data?.ItemsAdded;
    if (!Array.isArray(added) || !added.length) return;
    if (playbackManager.isPlayingLocally(['Video'])) return;
    try {
        const result = await context.read.getItems({
            userId: context.read.identity.profileUserId,
            recursive: true,
            limit: 3,
            filters: ['IsNotFolder'],
            sortBy: ['DateCreated'],
            sortOrder: ['Descending'],
            ids: added.slice(0, 12),
            mediaTypes: ['Audio', 'Video'],
            enableTotalRecordCount: false
        });
        if (!context.scope.isCurrent(context.delivery) || !Array.isArray(result?.Items)) return;
        for (const item of result.Items.slice(0, 3)) {
            if (!context.scope.isCurrent(context.delivery)) return;
            if (!item?.Id || !item?.Type || !item?.Name
                || item.ServerId && item.ServerId !== context.read.identity.serverId) continue;
            publish(context, newItemNotification(item), 15000, item);
        }
    } catch {
        // Reads may fail or be cancelled when the session changes.
    }
}

function packageNotification(installation, status) {
    const notification = { tag: `install${installation.Id}`, data: {} };
    if (status === 'completed') {
        notification.title = globalize.translate('PackageInstallCompleted', installation.Name, installation.Version);
        notification.vibrate = true;
    } else if (status === 'cancelled') {
        notification.title = globalize.translate('PackageInstallCancelled', installation.Name, installation.Version);
    } else if (status === 'failed') {
        notification.title = globalize.translate('PackageInstallFailed', installation.Name, installation.Version);
        notification.vibrate = true;
    } else if (status === 'progress') {
        notification.title = globalize.translate('InstallingPackage', installation.Name, installation.Version);
        notification.actions = [{
            action: 'cancel-install',
            title: globalize.translate('ButtonCancel'),
            icon: NotificationIcon
        }];
        notification.data.id = installation.Id;
        notification.body = `${Math.round(installation.PercentComplete || 0)}% complete.`;
    }
    return notification;
}

async function onPackageInstallation(installation, status, context, reservation) {
    let handedToPublication = false;
    try {
        const user = await context.read.getCurrentUser();
        if (!context.scope.isCurrent(context.delivery) || user?.Policy?.IsAdministrator !== true) return;
        publish(context, packageNotification(installation, status), status === 'cancelled' ? 5000 : 0,
            undefined, reservation);
        handedToPublication = true;
    } catch {
        // A successor's administrator status cannot authorize this event.
    } finally {
        if (!handedToPublication) context.scope.cancelReservation(reservation);
    }
}

function onServerStatus(client, delivery, translation, action) {
    const context = eventContext(client, delivery);
    if (!context) return;
    const server = client.serverInfo();
    if (!server?.Id || server.Id !== context.read.identity.serverId) return;
    const notification = {
        tag: `restart${server.Id}`,
        title: globalize.translate(translation, server.Name)
    };
    if (action) {
        notification.actions = [{
            action: 'restart',
            title: globalize.translate('Restart'),
            icon: NotificationIcon
        }];
    }
    publish(context, notification, 0);
}

observeRegistration();
Events.on(ServerConnections, 'localusersignedin', () => {
    void currentScope?.retire();
    currentScope = null;
    armPermissionRequest();
});
Events.on(ServerConnections, 'localusersignedout', detachPermissionHandler);
armPermissionRequest();

Events.on(serverNotifications, 'LibraryChanged', (event, client, data, delivery) => {
    const context = eventContext(client, delivery);
    if (context) void onLibraryChanged(data, context).catch(() => undefined);
});

for (const [event, status] of [
    ['PackageInstallationCompleted', 'completed'],
    ['PackageInstallationFailed', 'failed'],
    ['PackageInstallationCancelled', 'cancelled'],
    ['PackageInstalling', 'progress']
]) {
    Events.on(serverNotifications, event, (occurrence, client, data, delivery) => {
        const context = eventContext(client, delivery);
        if (!context || !data?.Id) return;
        const reservation = context.scope.reserve(`install${data.Id}`, delivery);
        if (reservation) {
            void onPackageInstallation(data, status, context, reservation)
                .catch(() => undefined);
        }
    });
}

Events.on(serverNotifications, 'ServerShuttingDown', (event, client, data, delivery) => {
    onServerStatus(client, delivery, 'ServerNameIsShuttingDown');
});
Events.on(serverNotifications, 'ServerRestarting', (event, client, data, delivery) => {
    onServerStatus(client, delivery, 'ServerNameIsRestarting');
});
Events.on(serverNotifications, 'RestartRequired', (event, client, data, delivery) => {
    onServerStatus(client, delivery, 'PleaseRestartServerName', true);
});
