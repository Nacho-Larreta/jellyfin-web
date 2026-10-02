import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
    connections: {
        currentApiClient: vi.fn(),
        getApiClient: vi.fn(),
        subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
    },
    application: {
        captureBoundSessionRead: vi.fn(),
        subscribeSessionAdmission: vi.fn(() => vi.fn())
    },
    image: { fetchImage: vi.fn() }
}));

vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: dependencies.connections }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => dependencies.application
}));
vi.mock('utils/jellyfin-apiclient/sessionReadApi', () => ({
    createSessionScopedReadApi: (apiClient, port) => ({ identity: port.identity,
        assertCurrent: port.assertCurrent })
}));
vi.mock('utils/jellyfin-apiclient/sessionImageRead', () => ({
    createSessionImageRead: () => dependencies.image
}));

import { createNotificationScope } from './notificationScope';

const itemId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let activeClient;
let activePort;
let registration;
let notifications;
let scopes;
let NativeNotification;

function client(name = 'A') {
    return { serverId: () => `server-${name}` };
}

function portFor(apiClient) {
    let valid = true;
    return {
        identity: { serverId: apiClient.serverId(), profileUserId: 'child', sessionEpoch: 1,
            authorityGeneration: 'generation-a' },
        assertCurrent: () => {
            if (!valid || activeClient !== apiClient) throw new Error('stale');
        },
        revoke: () => {
            valid = false;
        }
    };
}

function scope() {
    const owner = createNotificationScope(activeClient, () => registration, NativeNotification, '/icon.png');
    scopes.push(owner);
    return owner;
}

function notification(options = {}) {
    return { title: 'New Movie', tag: 'newItem', body: 'Film', data: {}, ...options };
}

function artwork() {
    return { Id: itemId, ImageTags: { Primary: 'image-tag' } };
}

function deferred() {
    let resolve;
    const promise = new Promise(complete => {
        resolve = complete;
    });
    return { promise, resolve };
}

beforeEach(() => {
    activeClient = client();
    activePort = portFor(activeClient);
    scopes = [];
    notifications = [];
    dependencies.connections.currentApiClient.mockImplementation(() => activeClient);
    dependencies.connections.getApiClient.mockImplementation(id =>
        id === activeClient?.serverId() ? activeClient : null);
    dependencies.application.captureBoundSessionRead.mockImplementation(apiClient =>
        apiClient === activeClient ? activePort : null);
    registration = {
        showNotification: vi.fn(async (title, options) => {
            notifications.push({ title, ...options, close: vi.fn() });
        }),
        getNotifications: vi.fn(async ({ tag }) => notifications.filter(item => item.tag === tag))
    };
    NativeNotification = class {
        static permission = 'granted';
    };
    Object.defineProperty(URL, 'createObjectURL', {
        configurable: true, value: vi.fn(() => 'blob:artwork')
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true, value: vi.fn()
    });
    dependencies.image.fetchImage.mockReset();
});

afterEach(async () => {
    await Promise.all(scopes.filter(Boolean).map(owner => owner.retire()));
    vi.clearAllMocks();
});

describe('notification-local OS publication owner', () => {
    it('uses an opaque publication discriminator and closes only its own record', async () => {
        const owner = scope();
        const delivery = { isCurrent: () => true };
        expect(await owner.publish(notification(), 0, delivery)).toBe('Shown');
        const own = notifications[0];
        const otherTab = { ...own, data: { ...own.data, notificationOwnerId: 'another-tab' }, close: vi.fn() };
        notifications.push(otherTab);

        expect(own.data).toMatchObject({ serverId: 'server-A', notificationOwnerVersion: 1 });
        expect(own.data.notificationOwnerId).toMatch(/^[0-9a-f]{32}$/);
        expect(own.data.notificationPublicationId).toMatch(/^[0-9a-f]{32}$/);
        expect(await owner.retire()).toBe(true);
        expect(own.close).toHaveBeenCalledOnce();
        expect(otherTab.close).not.toHaveBeenCalled();
    });

    it('runs a second exact cleanup after a pending publication settles', async () => {
        const pending = deferred();
        registration.showNotification.mockImplementationOnce(async (title, options) => {
            await pending.promise;
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        const publishing = owner.publish(notification(), 0, { isCurrent: () => true });
        await Promise.resolve();
        expect(await owner.retire()).toBe(false);
        expect(registration.getNotifications).toHaveBeenCalledOnce();
        pending.resolve();
        expect(await publishing).toBe('Retired');
        expect(notifications[0].close).toHaveBeenCalledOnce();
        expect(registration.getNotifications).toHaveBeenCalledTimes(2);
    });

    it('keeps owned artwork until the persistent publication settles, then revokes it', async () => {
        dependencies.image.fetchImage.mockResolvedValue(new Blob(['raster'], { type: 'image/png' }));
        const pending = deferred();
        registration.showNotification.mockImplementationOnce(async () => {
            await pending.promise;
        });
        const owner = scope();
        const event = owner.captureEvent({ isCurrent: () => true });
        const publishing = owner.publish(notification(), 0, { isCurrent: () => true }, artwork(), event.image);
        await Promise.resolve();
        await Promise.resolve();
        expect(dependencies.image.fetchImage).toHaveBeenCalledWith({
            itemId, type: 'Primary', tag: 'image-tag', maxWidth: 80
        }, expect.any(AbortSignal), 512 * 1024);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        pending.resolve();
        expect(await publishing).toBe('Shown');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:artwork');
    });

    it('never publishes a fallback icon after retirement during artwork loading', async () => {
        const pending = deferred();
        dependencies.image.fetchImage.mockReturnValueOnce(pending.promise);
        const owner = scope();
        const event = owner.captureEvent({ isCurrent: () => true });
        const publishing = owner.publish(notification(), 0, { isCurrent: () => true }, artwork(), event.image);
        await owner.retire();
        pending.resolve(new Blob(['raster'], { type: 'image/png' }));
        expect(await publishing).toBe('Skipped');
        expect(registration.showNotification).not.toHaveBeenCalled();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('keeps pending persistent artwork until the late native call settles and closes it', async () => {
        dependencies.image.fetchImage.mockResolvedValue(new Blob(['raster'], { type: 'image/png' }));
        const pending = deferred();
        registration.showNotification.mockImplementationOnce(async (title, options) => {
            await pending.promise;
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        const event = owner.captureEvent({ isCurrent: () => true });
        const publishing = owner.publish(notification(), 0, { isCurrent: () => true }, artwork(), event.image);
        await Promise.resolve();
        await Promise.resolve();
        expect(await owner.retire()).toBe(false);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        pending.resolve();
        expect(await publishing).toBe('Retired');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:artwork');
        expect(notifications[0].close).toHaveBeenCalledOnce();
    });

    it('removes actions only for the nonpersistent API and closes its direct handle', async () => {
        registration = null;
        const handles = [];
        NativeNotification = class {
            static permission = 'granted';
            constructor(title, options) {
                this.title = title;
                this.options = options;
                this.close = vi.fn();
                this.addEventListener = vi.fn();
                handles.push(this);
            }
        };
        const owner = scope();
        const options = notification({ actions: [{ action: 'restart', title: 'Restart' }] });
        expect(await owner.publish(options, 0, { isCurrent: () => true })).toBe('Shown');
        expect(handles).toHaveLength(1);
        expect(handles[0].options.actions).toBeUndefined();
        expect(handles[0].options.body).toBe('Film');
        expect(options.actions[0].action).toBe('restart');
        expect(await owner.retire()).toBe(true);
        expect(handles[0].close).toHaveBeenCalledOnce();
    });

    it('does not let an older category timer close a newer publication', async () => {
        vi.useFakeTimers();
        try {
            const owner = scope();
            const delivery = { isCurrent: () => true };
            expect(await owner.publish(notification(), 1000, delivery)).toBe('Shown');
            expect(await owner.publish(notification(), 0, delivery)).toBe('Shown');
            expect(notifications[0].tag).toBe(notifications[1].tag);
            await vi.advanceTimersByTimeAsync(1000);
            expect(notifications[0].close).not.toHaveBeenCalled();
            expect(notifications[1].close).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries an exact native cleanup after one enumeration failure', async () => {
        const owner = scope();
        expect(await owner.publish(notification(), 0, { isCurrent: () => true })).toBe('Shown');
        registration.getNotifications.mockRejectedValueOnce(new Error('registration closed'));
        expect(await owner.retire()).toBe(true);
        expect(registration.getNotifications).toHaveBeenCalledTimes(2);
        expect(notifications[0].close).toHaveBeenCalledOnce();
    });

    it('retains a failed cleanup for a later retry without closing another owner', async () => {
        const owner = scope();
        expect(await owner.publish(notification(), 0, { isCurrent: () => true })).toBe('Shown');
        const own = notifications[0];
        const other = { ...own, data: { ...own.data, notificationOwnerId: 'other-owner' }, close: vi.fn() };
        notifications.push(other);
        registration.getNotifications.mockRejectedValueOnce(new Error('first'));
        registration.getNotifications.mockRejectedValueOnce(new Error('second'));
        expect(await owner.retire()).toBe(false);
        expect(await owner.retire()).toBe(true);
        expect(own.close).toHaveBeenCalledOnce();
        expect(other.close).not.toHaveBeenCalled();
    });

    it('reports failed cleanup after a late native publication', async () => {
        const pending = deferred();
        registration.showNotification.mockImplementationOnce(async (title, options) => {
            await pending.promise;
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        const publishing = owner.publish(notification(), 0, { isCurrent: () => true });
        expect(await owner.retire()).toBe(false);
        registration.getNotifications.mockRejectedValue(new Error('registration failed'));
        pending.resolve();
        expect(await publishing).toBe('CleanupFailed');
        registration.getNotifications.mockImplementation(async ({ tag }) =>
            notifications.filter(item => item.tag === tag));
        expect(await owner.retire()).toBe(true);
        expect(notifications[0].close).toHaveBeenCalledOnce();
    });

    it('retains only the latest confirmed record for repeated category updates', async () => {
        registration.showNotification.mockImplementation(async (title, options) => {
            const priorIndex = notifications.findIndex(item => item.tag === options.tag);
            if (priorIndex >= 0) notifications.splice(priorIndex, 1);
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        for (let index = 0; index < 30; index++) {
            expect(await owner.publish(notification({ body: `Progress ${index}` }), 0,
                { isCurrent: () => true })).toBe('Shown');
        }
        expect(await owner.retire()).toBe(true);
        expect(registration.getNotifications).toHaveBeenCalledOnce();
        expect(notifications[0].close).toHaveBeenCalledOnce();
    });

    it('serializes native same-tag calls so inverse completion leaves the newer publication', async () => {
        const first = deferred();
        registration.showNotification.mockImplementation(async (title, options) => {
            if (options.body === 'Old progress') await first.promise;
            const prior = notifications.findIndex(item => item.tag === options.tag);
            if (prior >= 0) notifications.splice(prior, 1);
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        const oldPublication = owner.publish(notification({ body: 'Old progress' }), 0,
            { isCurrent: () => true });
        const newPublication = owner.publish(notification({ body: 'New progress' }), 0,
            { isCurrent: () => true });
        await Promise.resolve();
        const callsBeforeOldSettlement = registration.showNotification.mock.calls.length;
        first.resolve();
        expect(await oldPublication).toBe('Superseded');
        expect(await newPublication).toBe('Shown');
        expect(callsBeforeOldSettlement).toBe(1);
        expect(notifications).toHaveLength(1);
        expect(notifications[0].body).toBe('New progress');
        expect(notifications[0].close).not.toHaveBeenCalled();
    });

    it('does not hold a different category behind a pending native show', async () => {
        const first = deferred();
        registration.showNotification.mockImplementation(async (title, options) => {
            if (options.body === 'Pending') await first.promise;
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        const pending = owner.publish(notification({ body: 'Pending' }), 0,
            { isCurrent: () => true });
        const independent = owner.publish(notification({ tag: 'restart', body: 'Restart' }), 0,
            { isCurrent: () => true });
        expect(await independent).toBe('Shown');
        expect(registration.showNotification).toHaveBeenCalledTimes(2);
        first.resolve();
        expect(await pending).toBe('Shown');
    });

    it('does not poison a category queue when the earlier native show rejects', async () => {
        const first = deferred();
        registration.showNotification.mockImplementationOnce(async () => {
            await first.promise;
            throw new Error('native display rejected');
        });
        const owner = scope();
        const failed = owner.publish(notification({ body: 'Old progress' }), 0,
            { isCurrent: () => true });
        const latest = owner.publish(notification({ body: 'New progress' }), 0,
            { isCurrent: () => true });
        first.resolve();
        expect(await failed).toBe('NativeDisplayFailed');
        expect(await latest).toBe('Shown');
        expect(notifications.at(-1).body).toBe('New progress');
    });

    it('does not retire a shown notification when an old delivery becomes stale', async () => {
        const owner = scope();
        let live = true;
        const delivery = { isCurrent: () => live };
        expect(await owner.publish(notification(), 0, delivery)).toBe('Shown');
        live = false;
        expect(owner.isCurrent()).toBe(true);
        expect(notifications[0].close).not.toHaveBeenCalled();
        expect(owner.isCurrent({ isCurrent: () => {
            throw new Error('closed socket');
        } })).toBe(false);
        expect(owner.isCurrent()).toBe(true);
        expect(notifications[0].close).not.toHaveBeenCalled();
    });

    it('keeps a native publication when only its socket delivery expires during show', async () => {
        const pending = deferred();
        registration.showNotification.mockImplementationOnce(async (title, options) => {
            await pending.promise;
            notifications.push({ title, ...options, close: vi.fn() });
        });
        const owner = scope();
        let liveDelivery = true;
        const delivery = { isCurrent: () => liveDelivery };
        const publishing = owner.publish(notification(), 0, delivery);
        liveDelivery = false;
        pending.resolve();
        expect(await publishing).toBe('Shown');
        expect(owner.isCurrent()).toBe(true);
        expect(notifications[0].close).not.toHaveBeenCalled();
    });
});
