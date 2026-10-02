import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('components/apphost', () => ({
    appHost: {
        appName: () => 'Web',
        appVersion: () => '1',
        deviceId: () => 'device-1',
        deviceName: () => 'Browser'
    }
}));
vi.mock('scripts/settings/appSettings', () => ({
    default: { enableAutoLogin: () => true }
}));
vi.mock('scripts/settings/userSettings', () => ({ setUserInfo: vi.fn() }));
vi.mock('utils/dashboard', () => ({ default: { capabilities: () => ({}) } }));
vi.mock('utils/jellyfin-apiclient/compat', () => ({ toApi: vi.fn() }));
vi.mock('utils/fetch', () => ({ ajax: vi.fn() }));

import { ServerConnections } from './ServerConnections';
import { ConnectionState } from './connectionState';
import { createActiveProfileSession } from '../profileSelector/sessionSwitch/model';
import { Credentials } from 'jellyfin-apiclient';
import { ajax } from 'utils/fetch';
import Events from 'utils/events.ts';

describe('ServerConnections startup with the real legacy ApiClient', () => {
    beforeEach(() => {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: { request: (_name, _options, operation) => Promise.resolve().then(() => operation({})) }
        });
    });

    it('keeps the supplied server URL as the client address when a saved server exists', () => {
        const address = 'https://jellyfin.example';
        const saved = { Id: 'server-1', ManualAddress: address, LastConnectionMode: 2 };
        const credentials = {
            key: 'startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});

        expect(() => connections.initApiClient(address)).not.toThrow();
        expect(connections.getLocalApiClient().serverAddress()).toBe(address);
    });

    it('reuses the registered saved-server client after startup imports enumerate clients', () => {
        const address = 'https://jellyfin.example/web';
        const saved = {
            Id: 'server-1', ManualAddress: address, LastConnectionMode: 2,
            UserId: 'user-1', AccessToken: 'test-only-token', SessionSwitchAuthorityRevision: 4,
            SessionSwitchEnvelope: null
        };
        const credentials = {
            key: 'pre-enumerated-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        const registered = connections.getApiClients()[0];
        const created = vi.fn();
        const signedIn = vi.fn();
        const savedBeforeInit = JSON.stringify(saved);
        Events.on(connections, 'apiclientcreated', created);
        Events.on(connections, 'localusersignedin', signedIn);

        connections.initApiClient(address);
        connections.initApiClient(address);

        expect(connections.currentApiClient()).toBe(registered);
        expect(connections.getApiClient('server-1')).toBe(registered);
        expect(connections.getApiClients()).toHaveLength(1);
        expect(created).not.toHaveBeenCalled();
        expect(signedIn).not.toHaveBeenCalled();
        expect(JSON.stringify(saved)).toBe(savedBeforeInit);
        expect(registered.enableAutomaticNetworking).toBe(false);
        expect(registered.manualAddressOnly).toBe(true);
    });

    it('allows another base path without reusing or retargeting the saved client', () => {
        const saved = { Id: 'server-1', ManualAddress: 'https://jellyfin.example/web', LastConnectionMode: 2 };
        const credentials = {
            key: 'changed-path-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        const registered = connections.getApiClients()[0];

        connections.initApiClient('https://jellyfin.example/other');

        expect(connections.getApiClients()).toHaveLength(2);
        expect(connections.getApiClient('server-1')).toBe(registered);
        expect(registered.serverAddress()).toBe(saved.ManualAddress);
        expect(connections.currentApiClient().serverId()).toBeUndefined();
    });

    it('does not let legacy case-insensitive address matching assign a saved ID to another path', () => {
        const saved = { Id: 'server-1', ManualAddress: 'https://jellyfin.example/Web', LastConnectionMode: 2 };
        const credentials = {
            key: 'case-sensitive-path-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        const registered = connections.getApiClients()[0];

        expect(() => connections.initApiClient('https://jellyfin.example/web')).toThrow();
        expect(connections.getApiClients()).toEqual([ registered ]);
    });

    it('selects only the matching server when several saved clients were enumerated', () => {
        const servers = [
            { Id: 'server-1', ManualAddress: 'https://jellyfin.example/first', LastConnectionMode: 2 },
            { Id: 'server-2', ManualAddress: 'https://jellyfin.example/second', LastConnectionMode: 2 }
        ];
        const credentials = {
            key: 'multiple-saved-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: servers })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        const [ first, second ] = connections.getApiClients();

        connections.initApiClient('https://jellyfin.example/second');

        expect(connections.currentApiClient()).toBe(second);
        expect(connections.getApiClient('server-1')).toBe(first);
        expect(connections.getApiClients()).toHaveLength(2);
    });

    it('rejects ambiguous registered candidates without changing the selected client', () => {
        const address = 'https://jellyfin.example/web';
        const saved = { Id: 'server-1', ManualAddress: address, LastConnectionMode: 2 };
        const credentials = {
            key: 'ambiguous-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        const registered = connections.getApiClients()[0];
        connections._apiClients.push(registered);

        expect(() => connections.initApiClient(address)).toThrow();
        expect(connections.getLocalApiClient()).toBeNull();
    });

    it('selects the canonical identified client after first-server discovery', async () => {
        const address = 'https://jellyfin.example/web';
        const credentials = new Credentials('first-discovery-startup-test-credentials');
        credentials.credentials({ Servers: [] });
        vi.mocked(ajax).mockResolvedValue({
            Id: 'discovered-server',
            Version: '10.12.0',
            StartupWizardCompleted: true
        });

        try {
            const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
            connections.initApiClient(address);
            const provisional = connections.currentApiClient();
            await vi.waitFor(() => expect(credentials.credentials().Servers).toHaveLength(1));

            const response = await connections.connect();

            expect(response.State).toBe(ConnectionState.ServerSignIn);
            expect(response.ApiClient.serverId()).toBe('discovered-server');
            expect(connections.getApiClient('discovered-server')).toBe(response.ApiClient);
            expect(response.ApiClient).not.toBe(provisional);
            expect(connections.currentApiClient()).toBe(provisional);
        } finally {
            credentials.clear();
            vi.mocked(ajax).mockReset();
        }
    });

    it('creates an isolated target client on the installed origin and keeps credentials out of server metadata', () => {
        const address = 'https://jellyfin.example';
        const saved = {
            Id: 'server-1', ManualAddress: address, LastConnectionMode: 2,
            UserId: 'target-user', AccessToken: 'target-token'
        };
        const credentials = {
            key: 'isolated-startup-test-credentials',
            appStorage: window.localStorage,
            credentials: () => ({ Servers: [saved] })
        };
        const connections = new ServerConnections(credentials, 'Web', '1', 'Browser', 'device-1', {});
        connections.initApiClient(address);
        const target = createActiveProfileSession('server-1', 'device-1', 'target-user', 'target-token', 1);

        const isolated = connections.createIsolatedSessionApiClient(saved, target);
        expect(isolated.serverAddress()).toBe(address);
        expect(isolated.getCurrentUserId()).toBe('target-user');
        expect(isolated.serverInfo()).toEqual(expect.objectContaining({ Id: 'server-1', UserId: 'target-user' }));
        expect(isolated.serverInfo()).not.toHaveProperty('OwnerAccessToken');
        expect(isolated.serverInfo()).not.toHaveProperty('SessionSwitchEnvelope');
    });
});
