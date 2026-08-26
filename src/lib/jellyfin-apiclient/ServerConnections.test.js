import { describe, expect, it, vi } from 'vitest';

const { ajaxMock, constructedApiClients } = vi.hoisted(() => ({
    ajaxMock: vi.fn(),
    constructedApiClients: []
}));

vi.mock('components/apphost', () => ({
    appHost: {
        appName: () => 'test-app',
        appVersion: () => '1.0.0',
        deviceId: () => 'device-1',
        deviceName: () => 'test-device'
    }
}));
vi.mock('scripts/settings/appSettings', () => ({
    default: { enableAutoLogin: () => true }
}));
vi.mock('scripts/settings/userSettings', () => ({
    setUserInfo: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('utils/dashboard', () => ({
    default: { capabilities: () => ({}) }
}));
vi.mock('utils/jellyfin-apiclient/compat', () => ({
    toApi: vi.fn()
}));
vi.mock('utils/fetch', () => ({ ajax: ajaxMock }));
vi.mock('jellyfin-apiclient', () => ({
    ApiClient: class {
        constructor(...args) {
            this.constructorArgs = args;
            constructedApiClients.push(this);
        }
        accessToken = vi.fn(() => this.authenticationToken ?? null);
        closeWebSocket = vi.fn();
        ensureWebSocket = vi.fn();
        getCurrentUser = vi.fn();
        getCurrentUserId = vi.fn(() => this.authenticationUserId ?? null);
        serverInfo = vi.fn();
        setAuthenticationInfo = vi.fn((token, userId) => {
            this.authenticationToken = token;
            this.authenticationUserId = userId;
        });
    },
    Credentials: class {
        key = 'default-test-credentials';
        value = { Servers: [] };
        credentials(next) {
            if (arguments.length > 0) this.value = next;
            return this.value;
        }
    }
}));

import {
    ConcurrentSessionWriteError,
    SessionStorageCorruptionError,
    SessionSwitchUnsupportedEngineError,
    createActiveProfileSession,
    createOwnerRecoverySession
} from '../profileSelector/sessionSwitch/model';
import { SessionAdmissionBarrier } from '../profileSelector/sessionSwitch/barrier';
import {
    ServerConnectionsSessionSwitchStore,
    createSessionSwitchEnvelope
} from '../profileSelector/sessionSwitch/store';
import { ServerConnections } from './ServerConnections';
import { ConnectionState } from './connectionState';
import { revokeSavedSessionAuthority } from './connectionManager';
import Events from 'utils/events.ts';

function createEnvelope(targetUser = 'target-user', targetToken = 'target-token') {
    const initial = createSessionSwitchEnvelope(
        createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
        createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
    );
    return {
        ...initial,
        revision: 1,
        activeSession: createActiveProfileSession('server-1', 'device-1', targetUser, targetToken, 8)
    };
}

function createPendingEnvelope(revision = 1) {
    const initial = createSessionSwitchEnvelope(
        createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
        createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
    );
    return {
        ...initial,
        revision,
        marker: {
            kind: 'PendingSwitch',
            phase: 'Preparing',
            switchId: 'switch-1',
            serverId: 'server-1',
            deviceId: 'device-1',
            oldProfileUserId: 'old-user',
            oldEpoch: 7,
            targetProfileUserId: 'target-user',
            coordinatorId: 'coordinator-1',
            fencingToken: 1,
            leaseExpiresAtMs: 1_000,
            updatedAtMs: 10
        }
    };
}

function createStorage() {
    const values = new Map();
    return {
        get length() {
            return values.size;
        },
        getItem: vi.fn(key => values.get(key) ?? null),
        key: vi.fn(index => Array.from(values.keys())[index] ?? null),
        setItem: vi.fn((key, value) => {
            values.set(key, value);
        }),
        removeItem: vi.fn(key => {
            values.delete(key);
        }),
        peek: key => values.get(key) ?? null
    };
}

function createProvider(server = {}, appStorage = createStorage()) {
    const key = 'test-credentials';
    let state = {
        Servers: [{
            Id: 'server-1',
            UserId: 'old-user',
            AccessToken: 'old-token',
            OwnerUserId: 'owner-user',
            OwnerAccessToken: 'owner-token',
            SessionSwitchEnvelope: createSessionSwitchEnvelope(
                createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
                createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
            ),
            ...server
        }]
    };
    const stored = appStorage.getItem(key);
    if (stored === null) {
        appStorage.setItem(key, JSON.stringify(state));
    } else {
        state = JSON.parse(stored);
    }
    const writes = [];
    let failNextWrite = false;
    return {
        appStorage,
        key,
        writes,
        credentials(next) {
            if (arguments.length === 0) return state;
            const snapshot = JSON.parse(JSON.stringify(next));
            writes.push(snapshot);
            if (failNextWrite) {
                failNextWrite = false;
                throw new Error('persistence failpoint');
            }
            state = snapshot;
            appStorage.setItem(key, JSON.stringify(snapshot));
            return state;
        },
        addOrUpdateServer(servers, nextServer) {
            const index = servers.findIndex(savedServer => savedServer.Id === nextServer.Id);
            if (index === -1) servers.push(nextServer);
            else servers[index] = nextServer;
        },
        failOnce() {
            failNextWrite = true;
        },
        state() {
            return JSON.parse(JSON.stringify(state));
        }
    };
}

function createLockManager() {
    const pending = new Map();
    return {
        request: vi.fn((name, _options, operation) => {
            const previous = pending.get(name) || Promise.resolve();
            const current = previous.catch(() => undefined).then(() => operation({ name, mode: 'exclusive' }));
            pending.set(name, current.catch(() => undefined));
            return current;
        })
    };
}

function installLockManager(lockManager) {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: lockManager
    });
}

function createDeferred() {
    let resolve;
    const promise = new Promise(promiseResolve => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function createConnections(provider, lockManager = createLockManager()) {
    installLockManager(lockManager);
    return new ServerConnections(provider, 'test-app', '1.0.0', 'test-device', 'device-1', {});
}

describe('ServerConnections session envelope adapter', () => {
    it('publishes the envelope and legacy auth projection only after one durable write', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);
        const envelope = createEnvelope();

        await connections.replaceSessionSwitchEnvelope('server-1', 0, envelope);

        expect(provider.writes).toHaveLength(1);
        expect(provider.writes[0].Servers[0]).toEqual(expect.objectContaining({
            SessionSwitchEnvelope: envelope,
            UserId: 'target-user',
            AccessToken: 'target-token',
            OwnerUserId: 'owner-user',
            OwnerAccessToken: 'owner-token'
        }));
        expect(observed).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenCalledWith(envelope);
    });

    it('rolls back the complete previous snapshot and never publishes after a persistence failpoint', async () => {
        const provider = createProvider();
        const before = provider.state();
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);
        provider.failOnce();

        await expect(connections.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope()))
            .rejects.toThrow('persistence failpoint');

        expect(provider.state()).toEqual(before);
        expect(provider.writes).toHaveLength(2);
        expect(observed).not.toHaveBeenCalled();
    });

    it('rejects a stale CAS writer before publishing or changing legacy auth', async () => {
        const provider = createProvider({
            SessionSwitchEnvelope: { ...createEnvelope(), revision: 2 }
        });
        const before = provider.state();
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);

        await expect(connections.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope()))
            .rejects.toEqual(expect.objectContaining({
                name: 'ConcurrentSessionWriteError',
                actualRevision: 2
            }));
        expect(provider.state()).toEqual(before);
        expect(observed).not.toHaveBeenCalled();
    });

    it('updates recovery authority through the same revisioned envelope projection', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);

        await connections.cacheOwnerSession('server-1', 'new-owner', 'new-owner-token');

        const server = provider.state().Servers[0];
        expect(server.SessionSwitchEnvelope).toEqual(expect.objectContaining({
            revision: 1,
            recoverySession: expect.objectContaining({
                ownerUserId: 'new-owner',
                credentialRef: { scope: 'owner-recovery', token: 'new-owner-token' }
            })
        }));
        expect(server).toEqual(expect.objectContaining({
            OwnerUserId: 'new-owner',
            OwnerAccessToken: 'new-owner-token'
        }));
    });

    it('keeps the quarantined credential only inside the recovery envelope, not legacy active auth', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const envelope = createEnvelope();

        await connections.replaceSessionSwitchEnvelope('server-1', 0, {
            ...envelope,
            marker: {
                kind: 'QuarantinedSession',
                phase: 'Quarantined',
                switchId: 'switch-1',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 7,
                targetProfileUserId: 'target-user',
                coordinatorId: 'coordinator-a',
                fencingToken: 1,
                leaseExpiresAtMs: 1_000,
                updatedAtMs: 1,
                reason: 'IdentityMismatch'
            }
        });

        expect(provider.state().Servers[0]).toEqual(expect.objectContaining({
            UserId: null,
            AccessToken: null
        }));
        expect(connections.getActiveProfileSession('server-1')).toBeNull();
    });

    it('keeps a late contender outside every sink while the browser lock owner is paused', async () => {
        const storage = createStorage();
        const providerA = createProvider({}, storage);
        const providerB = createProvider({}, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const observedA = vi.fn();
        const observedB = vi.fn();
        connectionsA.subscribeSessionSwitchEnvelope('server-1', observedA);
        connectionsB.subscribeSessionSwitchEnvelope('server-1', observedB);
        const ownerPaused = createDeferred();
        const releaseOwner = createDeferred();
        connectionsA.beforeSessionEnvelopeSink = vi.fn(async () => {
            ownerPaused.resolve();
            await releaseOwner.promise;
        });
        connectionsB.beforeSessionEnvelopeSink = vi.fn();

        const ownerAttempt = connectionsA.replaceSessionSwitchEnvelope(
            'server-1',
            0,
            createEnvelope('target-a', 'token-a')
        );
        await ownerPaused.promise;
        const lateAttempt = connectionsB.replaceSessionSwitchEnvelope(
            'server-1',
            0,
            createEnvelope('target-b', 'token-b')
        );
        await Promise.resolve();

        expect(connectionsB.beforeSessionEnvelopeSink).not.toHaveBeenCalled();
        expect(providerA.writes).toHaveLength(0);
        expect(providerB.writes).toHaveLength(0);
        expect(observedA).not.toHaveBeenCalled();
        expect(observedB).not.toHaveBeenCalled();

        releaseOwner.resolve();
        await ownerAttempt;
        await expect(lateAttempt).rejects.toEqual(expect.objectContaining({
            name: 'ConcurrentSessionWriteError',
            actualRevision: 1
        }));

        expect(providerA.writes).toHaveLength(1);
        expect(providerB.writes).toHaveLength(0);
        expect(observedA).toHaveBeenCalledOnce();
        expect(observedB).not.toHaveBeenCalled();
        const durableServer = JSON.parse(storage.peek(providerA.key)).Servers[0];
        expect(durableServer.SessionSwitchEnvelope).toEqual(
            providerA.writes[0].Servers[0].SessionSwitchEnvelope
        );
    });

    it.each([
        [ 'clear', connections => connections.clearSessionSwitchEnvelope('server-1') ],
        [ 'logout', connections => connections.logout() ],
        [ 'server removal', connections => connections.deleteServer('server-1') ]
    ])('gives terminal %s precedence over an envelope replacement paused before its sink', async (_case, terminate) => {
        const storage = createStorage();
        const providerA = createProvider({}, storage);
        const providerB = createProvider({}, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const observedA = vi.fn();
        const observedB = vi.fn();
        connectionsA.subscribeSessionSwitchEnvelope('server-1', observedA);
        connectionsB.subscribeSessionSwitchEnvelope('server-1', observedB);
        const ownerPaused = createDeferred();
        const releaseOwner = createDeferred();
        connectionsA.beforeSessionEnvelopeSink = vi.fn(async () => {
            ownerPaused.resolve();
            await releaseOwner.promise;
        });

        const replace = connectionsA.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope());
        await ownerPaused.promise;
        const terminal = terminate(connectionsB);
        await Promise.resolve();

        expect(providerA.writes).toHaveLength(0);
        expect(providerB.writes).toHaveLength(0);
        releaseOwner.resolve();
        await replace;
        await terminal;

        const durableCredentials = JSON.parse(storage.peek(providerA.key));
        const durableServer = durableCredentials.Servers.find(server => server.Id === 'server-1');
        if (_case === 'server removal') {
            expect(durableServer).toBeUndefined();
        } else {
            expect(durableServer.SessionSwitchEnvelope).toBeNull();
            expect(durableServer.SessionSwitchAuthorityRevision).toBe(2);
        }
        expect(observedA).toHaveBeenCalledOnce();
        expect(observedA).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
        expect(observedB).toHaveBeenCalledOnce();
        expect(observedB).toHaveBeenCalledWith(null);
    });

    it('rejects a stale replacement admitted before a terminal clear wins the credential lock', async () => {
        const storage = createStorage();
        const providerA = createProvider({}, storage);
        const providerB = createProvider({}, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);

        const clear = connectionsB.clearSessionSwitchEnvelope('server-1');
        const staleReplace = connectionsA.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope());

        await clear;
        await expect(staleReplace).rejects.toEqual(expect.objectContaining({
            name: 'ConcurrentSessionWriteError',
            actualRevision: 0
        }));

        const durableServer = JSON.parse(storage.peek(providerA.key)).Servers[0];
        expect(durableServer.SessionSwitchEnvelope).toBeNull();
        expect(durableServer.SessionSwitchAuthorityRevision).toBe(1);
        expect(providerA.writes).toHaveLength(0);
        expect(providerB.writes).toHaveLength(1);
    });

    it('merges metadata from a stale independent cache without overwriting the durable envelope', async () => {
        const storage = createStorage();
        const providerA = createProvider({}, storage);
        const providerB = createProvider({}, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const envelope = createEnvelope();

        await connectionsA.replaceSessionSwitchEnvelope('server-1', 0, envelope);
        await connectionsB.setProfileSelectorAvailability('server-1', true);

        const durableServer = JSON.parse(storage.peek(providerA.key)).Servers[0];
        expect(durableServer).toEqual(expect.objectContaining({
            ProfileSelectorEnabled: true,
            SessionSwitchAuthorityRevision: 1,
            SessionSwitchEnvelope: envelope,
            UserId: 'target-user',
            AccessToken: 'target-token'
        }));
        expect(providerB.writes).toHaveLength(1);
        expect(providerB.writes[0].Servers[0].SessionSwitchEnvelope).toEqual(envelope);
    });

    it('routes inherited discovery metadata through fresh credentials without overwriting another context commit', async () => {
        const storage = createStorage();
        const providerA = createProvider({ LocalAddress: 'https://old-address' }, storage);
        const providerB = createProvider({ LocalAddress: 'https://old-address' }, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const envelope = createEnvelope();
        const previousNativeShell = window.NativeShell;
        window.NativeShell = {
            findServers: vi.fn().mockResolvedValue([{
                Id: 'server-1',
                Address: 'https://discovered-address',
                Name: 'Discovered server'
            }])
        };

        try {
            await connectionsA.replaceSessionSwitchEnvelope('server-1', 0, envelope);
            await connectionsB.getAvailableServers();
        } finally {
            window.NativeShell = previousNativeShell;
        }

        const durableServer = JSON.parse(storage.peek(providerA.key)).Servers[0];
        expect(durableServer).toEqual(expect.objectContaining({
            Name: 'Discovered server',
            SessionSwitchAuthorityRevision: 1,
            SessionSwitchEnvelope: envelope,
            UserId: 'target-user',
            AccessToken: 'target-token'
        }));
    });

    it('makes the real inherited authentication writer terminal over a stale independent cache', async () => {
        const storage = createStorage();
        const providerA = createProvider({ ManualAddress: 'https://server' }, storage);
        const providerB = createProvider({ ManualAddress: 'https://server' }, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const observed = vi.fn();
        connectionsB.subscribeSessionSwitchEnvelope('server-1', observed);
        let serverInfo = providerB.state().Servers[0];
        const apiClient = {
            ensureWebSocket: vi.fn(),
            manualAddressOnly: false,
            reportCapabilities: vi.fn(),
            serverAddress: () => 'https://server',
            serverId: () => serverInfo.Id,
            serverInfo(next) {
                if (arguments.length > 0) serverInfo = next;
                return serverInfo;
            },
            setAuthenticationInfo: vi.fn()
        };
        connectionsB.addApiClient(apiClient);
        connectionsB.getApiClient = () => apiClient;
        connectionsB.onLocalUserSignedIn = vi.fn().mockResolvedValue(undefined);

        await connectionsA.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope());
        await apiClient.onAuthenticated(apiClient, {
            ServerId: 'server-1',
            AccessToken: 'new-login-token',
            User: { Id: 'new-login-user', ServerId: 'server-1' }
        });

        const durableServer = JSON.parse(storage.peek(providerA.key)).Servers[0];
        expect(durableServer).toEqual(expect.objectContaining({
            SessionSwitchAuthorityRevision: 2,
            SessionSwitchEnvelope: null,
            UserId: 'new-login-user',
            AccessToken: 'new-login-token',
            OwnerUserId: null,
            OwnerAccessToken: null
        }));
        expect(observed).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenCalledWith(null);
    });

    it('revokes durable session authority when real connection validation rejects detached cached auth', async () => {
        vi.useFakeTimers();
        const provider = createProvider({
            LocalAddress: 'https://server',
            LastConnectionMode: 2
        });
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);
        await connections.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope());
        observed.mockClear();
        let serverInfo = provider.state().Servers[0];
        const apiClient = {
            serverInfo(next) {
                if (arguments.length > 0) serverInfo = next;
                return serverInfo;
            },
            setAuthenticationInfo: vi.fn(),
            setSystemInfo: vi.fn(),
            updateServerInfo: vi.fn()
        };
        connections._apiClients.push(apiClient);
        ajaxMock.mockImplementation(options => {
            if (options.url.endsWith('/System/Info/Public')) {
                return Promise.resolve({
                    Id: 'server-1',
                    ServerName: 'Test server',
                    Version: '10.12.0'
                });
            }
            return Promise.reject(new Error('invalid saved authentication'));
        });

        try {
            const connectionResult = connections.connectToServer(provider.state().Servers[0], {});
            await vi.runAllTimersAsync();
            const result = await connectionResult;
            expect(result).toEqual(expect.objectContaining({
                State: ConnectionState.ServerSignIn
            }));
            expect(result.Servers[0]).toEqual(expect.objectContaining({
                SessionSwitchEnvelope: null,
                UserId: null,
                AccessToken: null,
                OwnerUserId: null,
                OwnerAccessToken: null
            }));
        } finally {
            vi.useRealTimers();
            ajaxMock.mockReset();
        }

        const durableServer = provider.state().Servers[0];
        expect(durableServer).toEqual(expect.objectContaining({
            SessionSwitchAuthorityRevision: 2,
            SessionSwitchEnvelope: null,
            UserId: null,
            AccessToken: null,
            ExchangeToken: null,
            OwnerUserId: null,
            OwnerAccessToken: null
        }));
        expect(observed).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenCalledWith(null);
    });

    it('fails closed without touching a sink when Web Locks are unavailable', async () => {
        const provider = createProvider();
        installLockManager(undefined);
        const connections = new ServerConnections(provider, 'test-app', '1.0.0', 'test-device', 'device-1', {});
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);

        await expect(connections.replaceSessionSwitchEnvelope('server-1', 0, createEnvelope()))
            .rejects.toBeInstanceOf(SessionSwitchUnsupportedEngineError);

        expect(provider.writes).toHaveLength(0);
        expect(observed).not.toHaveBeenCalled();
    });

    it.each([
        [ 'JSON null', JSON.stringify(null) ],
        [ 'object without Servers', JSON.stringify({}) ],
        [ 'JSON string', JSON.stringify('credentials') ],
        [ 'Servers string', JSON.stringify({ Servers: 'invalid' }) ],
        [ 'invalid JSON', '{' ],
        [ 'invalid server member', JSON.stringify({ Servers: [ null ] }) ]
    ])('turns a corrupt real storage event (%s) into a closed barrier before access', (_case, newValue) => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const store = new ServerConnectionsSessionSwitchStore(connections);
        const barrier = new SessionAdmissionBarrier();
        store.subscribe({ serverId: 'server-1', deviceId: 'device-1' }, observation => {
            barrier.synchronize(observation);
        });
        barrier.synchronize(createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        ));
        const read = barrier.admitCurrent('read');

        window.dispatchEvent(new StorageEvent('storage', {
            key: provider.key,
            newValue
        }));

        expect(read.signal.aborted).toBe(true);
        expect(barrier.isClosed()).toBe(true);
        expect(() => barrier.admitCurrent('read')).toThrow(SessionStorageCorruptionError);
    });

    it('clears envelope and all recovery authority on logout and invalid authentication', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);

        await connections.logout();

        expect(provider.state().Servers[0]).toEqual(expect.objectContaining({
            UserId: null,
            AccessToken: null,
            OwnerUserId: null,
            OwnerAccessToken: null,
            SessionSwitchEnvelope: null
        }));

        const invalid = createProvider().state().Servers[0];
        revokeSavedSessionAuthority(invalid);
        expect(invalid).toEqual(expect.objectContaining({
            UserId: null,
            AccessToken: null,
            OwnerUserId: null,
            OwnerAccessToken: null,
            SessionSwitchEnvelope: null
        }));
    });

    it('removes the envelope with its server and publishes the removal', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);

        await connections.deleteServer('server-1');

        expect(provider.state().Servers).toEqual([]);
        expect(observed).toHaveBeenCalledWith(null);
    });

    it('makes selector-disabled cleanup conditional on the exact resolved revision', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const pending = createPendingEnvelope();

        await connections.replaceSessionSwitchEnvelope('server-1', 0, pending);
        await expect(connections.clearResolvedSessionSwitchEnvelope('server-1', 1))
            .rejects.toBeInstanceOf(ConcurrentSessionWriteError);

        expect(provider.state().Servers[0].SessionSwitchEnvelope).toEqual(pending);
        expect(provider.state().Servers[0].OwnerAccessToken).toBe('owner-token');
    });

    it('preserves a marker that wins the credential lock before selector-disabled cleanup', async () => {
        const storage = createStorage();
        const providerA = createProvider({}, storage);
        const providerB = createProvider({}, storage);
        const lockManager = createLockManager();
        const connectionsA = createConnections(providerA, lockManager);
        const connectionsB = createConnections(providerB, lockManager);
        const pending = createPendingEnvelope();

        const markerWrite = connectionsA.replaceSessionSwitchEnvelope('server-1', 0, pending);
        const staleCleanup = connectionsB.clearResolvedSessionSwitchEnvelope('server-1', 0);

        await markerWrite;
        await expect(staleCleanup).rejects.toBeInstanceOf(ConcurrentSessionWriteError);
        expect(JSON.parse(storage.peek(providerA.key)).Servers[0].SessionSwitchEnvelope).toEqual(pending);
    });

    it('keeps staged target authentication isolated and passes only allowlisted server DTO data', async () => {
        const provider = createProvider({
            UserId: 'target-user',
            AccessToken: 'target-token',
            SessionSwitchEnvelope: createEnvelope()
        });
        const connections = createConnections(provider);
        const oldApiClient = {
            accessToken: () => 'old-token',
            closeWebSocket: vi.fn(),
            ensureWebSocket: vi.fn(),
            getCurrentUserId: () => 'old-user',
            serverInfo: vi.fn(),
            setAuthenticationInfo: vi.fn()
        };
        connections._apiClients = [ oldApiClient ];
        connections.getApiClient = vi.fn(() => oldApiClient);
        connections.setLocalApiClient(oldApiClient);
        const constructionCount = constructedApiClients.length;
        const targetSession = createActiveProfileSession(
            'server-1',
            'device-1',
            'target-user',
            'target-token',
            8
        );

        connections.installSessionAuthentication(targetSession);
        const isolatedApiClient = constructedApiClients[constructionCount];
        isolatedApiClient.getCurrentUser.mockResolvedValue({ Id: 'target-user' });

        expect(provider.writes).toHaveLength(0);
        expect(connections._apiClients).toEqual([ oldApiClient ]);
        expect(connections.getLocalApiClient()).toBe(oldApiClient);
        expect(window.ApiClient).toBe(oldApiClient);
        expect(oldApiClient.closeWebSocket).not.toHaveBeenCalled();
        expect(oldApiClient.setAuthenticationInfo).not.toHaveBeenCalled();
        expect(await connections.getInstalledSessionUser('server-1')).toEqual({ Id: 'target-user' });

        const serverDto = isolatedApiClient.constructorArgs[0];
        expect(serverDto).toEqual(expect.objectContaining({
            Id: 'server-1',
            UserId: 'target-user'
        }));
        expect(JSON.stringify(serverDto)).not.toMatch(
            /AccessToken|OwnerAccessToken|SessionSwitchEnvelope|owner-token|target-token|recoverySession/
        );

        connections.reconnectInstalledSession('server-1');
        expect(isolatedApiClient.ensureWebSocket).toHaveBeenCalledOnce();
        expect(oldApiClient.setAuthenticationInfo).not.toHaveBeenCalled();

        connections.publishLocalUserState = vi.fn().mockResolvedValue(undefined);
        await connections.publishSessionSwitchCompletion(
            { Id: 'target-user' },
            {
                switchId: 'switch-1',
                serverId: 'server-1',
                profileUserId: 'target-user',
                sessionEpoch: 8
            }
        );
        expect(oldApiClient.setAuthenticationInfo).toHaveBeenCalledWith('target-token', 'target-user');
        expect(JSON.stringify(oldApiClient.serverInfo.mock.lastCall[0])).not.toMatch(
            /AccessToken|OwnerAccessToken|SessionSwitchEnvelope|owner-token|target-token|recoverySession/
        );
        expect(connections.getLocalApiClient()).toBe(oldApiClient);
        expect(connections._apiClients).toEqual([ oldApiClient ]);
    });

    it('finishes bootstrap before publishing user state to inherited authentication listeners', async () => {
        const connections = createConnections(createProvider());
        const events = [];
        connections.bootstrapAuthenticatedUser = vi.fn(async () => {
            events.push('bootstrap');
        });
        connections.publishLocalUserState = vi.fn(async () => {
            events.push('publish');
        });

        await connections.onLocalUserSignedIn({ Id: 'old-user', ServerId: 'server-1' });

        expect(events).toEqual([ 'bootstrap', 'publish' ]);
    });

    it('fails legacy target activation without mutating an existing durable owner envelope', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const before = provider.state();

        await expect(connections.applyAuthenticationResult('server-1', {
            AccessToken: 'legacy-target-token',
            User: { Id: 'legacy-target-user' }
        })).rejects.toThrow('Legacy profile activation is blocked');

        expect(provider.state()).toEqual(before);
        expect(provider.writes).toHaveLength(0);
        expect(connections.getActiveProfileSession('server-1')).toEqual(
            before.Servers[0].SessionSwitchEnvelope.activeSession
        );
    });

    it('publishes switch completion without emitting an early ordinary sign-in event', async () => {
        const connections = createConnections(createProvider());
        const activeApiClient = {
            accessToken: () => 'old-token',
            closeWebSocket: vi.fn(),
            ensureWebSocket: vi.fn(),
            getCurrentUserId: () => 'old-user',
            serverInfo: vi.fn(),
            setAuthenticationInfo: vi.fn()
        };
        connections.getApiClient = vi.fn(() => activeApiClient);
        connections.installSessionAuthentication(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        );
        connections.publishLocalUserState = vi.fn().mockResolvedValue(undefined);
        const signedIn = vi.fn();
        const completed = vi.fn();
        Events.on(connections, 'localusersignedin', signedIn);
        Events.on(connections, 'sessionswitchcompleted', completed);
        const receipt = {
            switchId: 'switch-1',
            serverId: 'server-1',
            profileUserId: 'old-user',
            sessionEpoch: 7
        };

        await connections.publishSessionSwitchCompletion(
            { Id: 'old-user' },
            receipt
        );

        expect(connections.publishLocalUserState).toHaveBeenCalledWith({
            Id: 'old-user',
            ServerId: 'server-1'
        });
        expect(completed).toHaveBeenCalledWith(expect.anything(), receipt);
        expect(signedIn).not.toHaveBeenCalled();
    });
});
