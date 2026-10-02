import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
    notifications: {},
    connections: {
        currentApiClient: vi.fn(),
        getApiClient: vi.fn(),
        subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
    },
    application: {
        captureBoundSessionRead: vi.fn(),
        subscribeSessionAdmission: vi.fn(() => vi.fn())
    },
    playback: { isPlayingLocally: vi.fn(() => false) }
}));

vi.mock('../../scripts/serverNotifications', () => ({ default: dependencies.notifications }));
vi.mock('../playback/playbackmanager', () => ({ playbackManager: dependencies.playback }));
vi.mock('../../lib/globalize', () => ({ default: { translate: (key, ...args) => `${key}:${args.join(':')}` } }));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: dependencies.connections }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => dependencies.application
}));

import Events from '../../utils/events.ts';

const originalAdapter = axios.defaults.adapter;
const itemId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let activeClient;
let port;
let transport;
let registration;
let NativeNotification;
let documentListeners;

function client(userId) {
    return {
        serverId: () => 'server-a',
        serverAddress: () => 'https://server.example/jellyfin',
        serverInfo: () => ({ Id: 'server-a', Name: 'Test server' }),
        getCurrentUserId: () => userId,
        getCurrentUser: vi.fn(async () => ({ Id: userId, Policy: { IsAdministrator: false } })),
        getItems: vi.fn(async () => ({ Items: [{ Id: itemId, Name: 'A film', Type: 'Movie' }] })),
        accessToken: () => `credential-${userId}`,
        deviceId: () => 'device-a',
        appName: () => 'Web', appVersion: () => '1', deviceName: () => 'Browser'
    };
}

function boundPort(apiClient) {
    const userId = apiClient.getCurrentUserId();
    const abort = new window['AbortController']();
    let current = true;
    return {
        identity: { serverId: 'server-a', profileUserId: userId,
            sessionEpoch: 1, authorityGeneration: `generation-${userId}` },
        binding: { serverId: 'server-a', profileUserId: userId,
            sessionEpoch: 1, deviceId: 'device-a',
            credentialRef: { token: apiClient.accessToken() } },
        basePath: apiClient.serverAddress(),
        assertCurrent: () => {
            if (!current || activeClient !== apiClient) throw new Error('stale');
        },
        acquire: () => ({ signal: abort.signal, settle: vi.fn() }),
        revoke: () => {
            current = false;
            abort.abort();
        }
    };
}

function setClient(apiClient) {
    activeClient = apiClient;
    port = boundPort(apiClient);
    dependencies.connections.currentApiClient.mockImplementation(() => activeClient);
    dependencies.connections.getApiClient.mockImplementation(() => activeClient);
    dependencies.application.captureBoundSessionRead.mockImplementation(captured =>
        captured === activeClient ? port : null);
}

function deliver(type, data, apiClient = activeClient, delivery = { isCurrent: () => true }) {
    Events.trigger(dependencies.notifications, type, [apiClient, data, delivery]);
}

async function settled() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
    documentListeners = vi.spyOn(document, 'addEventListener');
    setClient(client('child-a'));
    transport = vi.fn(async config => ({
        data: { Items: [{ Id: itemId, Name: 'A film', Type: 'Movie', ServerId: 'server-a' }] },
        status: 200, statusText: 'OK', headers: {}, config
    }));
    axios.defaults.adapter = transport;
    registration = {
        showNotification: vi.fn(async () => undefined),
        getNotifications: vi.fn(async () => [])
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true, value: { ready: Promise.resolve(registration) }
    });
    NativeNotification = class {
        static permission = 'default';
        static requestPermission = vi.fn(async () => 'denied');
        constructor() { throw new Error('Native fallback was not expected'); }
    };
    vi.stubGlobal('Notification', NativeNotification);
    vi.resetModules();
    await import('./notifications');
    await settled();
    dependencies.application.captureBoundSessionRead.mockClear();
});

afterEach(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await settled();
    axios.defaults.adapter = originalAdapter;
    vi.unstubAllGlobals();
    documentListeners.mockRestore();
    delete dependencies.notifications._callbacks;
});

describe('session-bound notification event consumer', () => {
    it.each(['default', 'denied'])('does not read private data or publish with permission %s', async permission => {
        NativeNotification.permission = permission;
        deliver('LibraryChanged', { ItemsAdded: [itemId] });
        deliver('PackageInstalling', { Id: 'install-a', Name: 'Plugin', Version: '1' });
        await settled();
        expect(transport).not.toHaveBeenCalled();
        expect(registration.showNotification).not.toHaveBeenCalled();
    });

    it('ignores unsupported permission and missing delivery before capturing a read', async () => {
        vi.stubGlobal('Notification', undefined);
        deliver('LibraryChanged', { ItemsAdded: [itemId] });
        NativeNotification.permission = 'granted';
        vi.stubGlobal('Notification', NativeNotification);
        deliver('LibraryChanged', { ItemsAdded: [itemId] }, activeClient, null);
        await settled();
        expect(dependencies.application.captureBoundSessionRead).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });

    it('prompts only once from a current trusted gesture and contains rejection', async () => {
        NativeNotification.requestPermission.mockRejectedValueOnce(new Error('blocked'));
        const clickHandler = documentListeners.mock.calls.find(([name]) => name === 'click')?.[1];
        expect(clickHandler).toBeTypeOf('function');
        clickHandler({ type: 'click', isTrusted: false, button: 0 });
        expect(NativeNotification.requestPermission).not.toHaveBeenCalled();
        clickHandler({ type: 'click', isTrusted: true, button: 0 });
        clickHandler({ type: 'click', isTrusted: true, button: 0 });
        await settled();
        expect(NativeNotification.requestPermission).toHaveBeenCalledOnce();
    });

    it('contains a synchronously thrown permission request without retrying', async () => {
        NativeNotification.requestPermission.mockImplementationOnce(() => {
            throw new Error('permission prompt unavailable');
        });
        const clickHandler = documentListeners.mock.calls.find(([name]) => name === 'click')?.[1];
        clickHandler({ type: 'click', isTrusted: true, button: 0 });
        clickHandler({ type: 'click', isTrusted: true, button: 0 });
        await settled();
        expect(NativeNotification.requestPermission).toHaveBeenCalledOnce();
    });

    it('contains a rejected persistent publication without a second native call', async () => {
        NativeNotification.permission = 'granted';
        registration.showNotification.mockRejectedValueOnce(new TypeError('permission failure'));
        deliver('LibraryChanged', { ItemsAdded: [itemId] });
        await settled();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(registration.showNotification).toHaveBeenCalledTimes(1);
    });

    it('does not publish a deferred item read after a successor replaces its profile', async () => {
        NativeNotification.permission = 'granted';
        let complete;
        transport.mockImplementationOnce(config => new Promise(resolve => {
            complete = () => resolve({ data: { Items: [{ Id: itemId, Name: 'A film', Type: 'Movie' }] },
                status: 200, statusText: 'OK', headers: {}, config });
        }));
        const first = activeClient;
        deliver('LibraryChanged', { ItemsAdded: [itemId] });
        await settled();
        port.revoke();
        setClient(client('child-b'));
        Events.trigger(dependencies.connections, 'localusersignedin');
        complete();
        await settled();
        expect(registration.showNotification).not.toHaveBeenCalled();
        expect(first).not.toBe(activeClient);
    });

    it('does not publish a deferred administrator result after same-user ABA', async () => {
        NativeNotification.permission = 'granted';
        let complete;
        transport.mockImplementationOnce(config => new Promise(resolve => {
            complete = () => resolve({ data: { Id: 'child-a', Policy: { IsAdministrator: true } },
                status: 200, statusText: 'OK', headers: {}, config });
        }));
        const sameClient = activeClient;
        deliver('PackageInstalling', { Id: 'install-a', Name: 'Plugin', Version: '1' });
        await settled();
        port.revoke();
        setClient(sameClient);
        complete();
        await settled();
        expect(registration.showNotification).not.toHaveBeenCalled();
    });

    it('preserves administrator package action and source Id casing', async () => {
        NativeNotification.permission = 'granted';
        transport.mockImplementationOnce(async config => ({
            data: { Id: 'child-a', Policy: { IsAdministrator: true } },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        deliver('PackageInstalling', { Id: 'install-a', Name: 'Plugin', Version: '1', PercentComplete: 21 });
        await settled();
        expect(registration.showNotification).toHaveBeenCalledOnce();
        const options = registration.showNotification.mock.calls[0][1];
        expect(options.title).toContain('InstallingPackage');
        expect(options.body).toBe('21% complete.');
        expect(options.actions[0].action).toBe('cancel-install');
        expect(options.data.id).toBe('install-a');
    });

    it('keeps a completed package newer than a deferred earlier progress read', async () => {
        NativeNotification.permission = 'granted';
        let finishProgressRead;
        transport.mockImplementationOnce(config => new Promise(resolve => {
            finishProgressRead = () => resolve({
                data: { Id: 'child-a', Policy: { IsAdministrator: true } },
                status: 200, statusText: 'OK', headers: {}, config
            });
        }));
        transport.mockImplementationOnce(async config => ({
            data: { Id: 'child-a', Policy: { IsAdministrator: true } },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        deliver('PackageInstalling', { Id: 'install-a', Name: 'Plugin', Version: '1', PercentComplete: 72 });
        await settled();
        deliver('PackageInstallationCompleted', { Id: 'install-a', Name: 'Plugin', Version: '1' });
        await settled();
        finishProgressRead();
        await settled();
        expect(registration.showNotification).toHaveBeenCalledTimes(1);
        const [title, options] = registration.showNotification.mock.calls[0];
        expect(title).toContain('PackageInstallCompleted');
        expect(options.actions).toBeUndefined();
    });

    it('keeps the source ItemsAdded array and bounds the SDK request', async () => {
        NativeNotification.permission = 'granted';
        const added = Array.from({ length: 14 }, (_, index) => String(index).padStart(32, '0'));
        deliver('LibraryChanged', { ItemsAdded: added });
        await settled();
        expect(added).toHaveLength(14);
        expect(transport).toHaveBeenCalledTimes(1);
        const request = new URL(axios.getUri(transport.mock.calls[0][0]), port.basePath);
        expect(request.searchParams.getAll('ids')).toHaveLength(12);
        expect(request.searchParams.get('limit')).toBe('3');
    });
});
