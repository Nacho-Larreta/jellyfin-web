import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createLibraryMenuViews } from 'scripts/libraryMenuViews';

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
        deviceId = vi.fn(() => this.constructorArgs[4]);
        ensureWebSocket = vi.fn();
        getCurrentUser = vi.fn();
        getCurrentUserId = vi.fn(() => this.authenticationUserId ?? null);
        serverAddress = vi.fn(() => this.constructorArgs[0]);
        serverId = vi.fn(() => this.savedServerInfo?.Id ?? null);
        serverInfo = vi.fn(function (next) {
            if (arguments.length > 0) this.savedServerInfo = next;
            return this.savedServerInfo;
        });
        setWebSocketSessionProvider = vi.fn(provider => {
            this.websocketSessionProvider = provider;
        });
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
    createOwnerRecoverySession,
    settledSwitchMarker
} from '../profileSelector/sessionSwitch/model';
import { SessionAdmissionBarrier } from '../profileSelector/sessionSwitch/barrier';
import { getWebSessionSwitchApplication } from '../profileSelector/sessionSwitch/application';
import { WebSocketSessionAdmission } from '../profileSelector/sessionSwitch/realtimeAdmission';
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
            playbackReport: null,
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
    it('reads authority from fresh persisted credentials instead of the provider cache', () => {
        const provider = createProvider({ ProfileSelectorEnabled: true, SessionSwitchAuthorityRevision: 2 });
        const connections = createConnections(provider);
        const saved = provider.state();
        saved.Servers[0].UserId = 'replacement-user';
        saved.Servers[0].AccessToken = 'replacement-token';
        saved.Servers[0].SessionSwitchAuthorityRevision = 3;
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));

        expect(connections.readFreshSessionAuthority('server-1')).toEqual(expect.objectContaining({
            userId: 'replacement-user',
            accessToken: 'replacement-token',
            selectorEnabled: true,
            authorityRevision: 3
        }));
        expect(provider.state().Servers[0].UserId).toBe('old-user');
    });

    it('rejects corrupt persisted envelope and authority revision', () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const saved = provider.state();
        saved.Servers[0].SessionSwitchEnvelope = { version: -1 };
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));
        expect(() => connections.readFreshSessionAuthority('server-1'))
            .toThrow('Invalid session switch envelope version.');

        saved.Servers[0].SessionSwitchEnvelope = null;
        saved.Servers[0].SessionSwitchAuthorityRevision = -1;
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));
        expect(() => connections.readFreshSessionAuthority('server-1'))
            .toThrow(SessionStorageCorruptionError);
    });

    it('keeps explicit selector-disabled authority distinct from absent flag and persisted marker', () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const saved = provider.state();
        saved.Servers[0].SessionSwitchEnvelope = null;
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));
        expect(connections.readFreshSessionAuthority('server-1')).toMatchObject({
            selectorEnabled: undefined, envelope: null
        });

        saved.Servers[0].ProfileSelectorEnabled = false;
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));
        expect(connections.readFreshSessionAuthority('server-1')).toMatchObject({
            selectorEnabled: false, envelope: null
        });

        saved.Servers[0].ProfileSelectorEnabled = true;
        saved.Servers[0].SessionSwitchEnvelope = createPendingEnvelope();
        provider.appStorage.setItem(provider.key, JSON.stringify(saved));
        expect(connections.readFreshSessionAuthority('server-1').envelope.marker)
            .toMatchObject({ kind: 'PendingSwitch' });
    });

    function arrangeLoginPublication(provider = createProvider(), lockManager) {
        const connections = createConnections(provider, lockManager);
        const apiClient = { serverId: () => 'server-1' };
        const activeApiClient = { ensureWebSocket: vi.fn() };
        connections.installAuthenticationBinding = vi.fn(() => activeApiClient);
        connections.bootstrapAuthenticatedUser = vi.fn().mockResolvedValue(undefined);
        connections.publishLocalUserState = vi.fn().mockResolvedValue(undefined);
        const result = {
            ServerId: 'server-1',
            AccessToken: 'new-token',
            User: { Id: 'new-user' }
        };
        return { connections, apiClient, activeApiClient, provider, result };
    }

    it('commits a validated login under the credential lock before publishing sign-in', async () => {
        const { connections, apiClient, activeApiClient, provider, result } = arrangeLoginPublication();
        const signedIn = vi.fn();
        Events.on(connections, 'localusersignedin', signedIn);
        const expectedAuthorityRevision = connections.captureLoginAuthority('server-1');

        await connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision,
            isCurrent: () => true
        });

        expect(provider.state().Servers[0]).toEqual(expect.objectContaining({
            UserId: 'new-user',
            AccessToken: 'new-token',
            SessionSwitchEnvelope: null,
            SessionSwitchAuthorityRevision: expectedAuthorityRevision + 1
        }));
        expect(connections.bootstrapAuthenticatedUser.mock.invocationCallOrder[0])
            .toBeLessThan(connections.publishLocalUserState.mock.invocationCallOrder[0]);
        expect(activeApiClient.ensureWebSocket).toHaveBeenCalledOnce();
        expect(signedIn).toHaveBeenCalledOnce();
    });

    it('keeps a cancelled authentication result outside a paused credential sink', async () => {
        const lockManager = createLockManager();
        const entered = createDeferred();
        const release = createDeferred();
        const held = lockManager.request('test-credentials:credentials', { mode: 'exclusive' }, () => {
            entered.resolve();
            return release.promise;
        });
        await entered.promise;
        const { connections, apiClient, provider, result } = arrangeLoginPublication(createProvider(), lockManager);
        const expectedAuthorityRevision = connections.captureLoginAuthority('server-1');
        let current = true;
        const publication = connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision,
            isCurrent: () => current
        });

        current = false;
        release.resolve();
        await held;
        await expect(publication).rejects.toBeInstanceOf(ConcurrentSessionWriteError);
        expect(provider.writes).toHaveLength(0);
        expect(connections.installAuthenticationBinding).not.toHaveBeenCalled();
    });

    it('preserves an unresolved marker instead of replacing its session authority', async () => {
        const provider = createProvider({ SessionSwitchEnvelope: createPendingEnvelope(1) });
        const { connections, apiClient, result } = arrangeLoginPublication(provider);
        expect(() => connections.captureLoginAuthority('server-1')).toThrow();

        await expect(connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision: 0,
            isCurrent: () => true
        })).rejects.toThrow();
        expect(provider.writes).toHaveLength(0);
    });

    it('does not publish sign-in after logout wins during bootstrap', async () => {
        const { connections, apiClient, provider, result } = arrangeLoginPublication();
        const bootstrap = createDeferred();
        connections.bootstrapAuthenticatedUser.mockReturnValue(bootstrap.promise);
        const signedIn = vi.fn();
        Events.on(connections, 'localusersignedin', signedIn);
        const expectedAuthorityRevision = connections.captureLoginAuthority('server-1');
        const publication = connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision,
            isCurrent: () => true
        });

        await vi.waitFor(() => expect(connections.bootstrapAuthenticatedUser).toHaveBeenCalledOnce());
        await connections.logout();
        bootstrap.resolve();
        await expect(publication).rejects.toBeInstanceOf(ConcurrentSessionWriteError);
        expect(provider.state().Servers[0].AccessToken).toBeNull();
        expect(connections.publishLocalUserState).not.toHaveBeenCalled();
        expect(signedIn).not.toHaveBeenCalled();
    });

    it('finishes auth publication when viewhide cancels UI after the durable sink', async () => {
        const { connections, apiClient, activeApiClient, provider, result } = arrangeLoginPublication();
        const bootstrap = createDeferred();
        connections.bootstrapAuthenticatedUser.mockReturnValue(bootstrap.promise);
        const signedIn = vi.fn();
        Events.on(connections, 'localusersignedin', signedIn);
        let current = true;
        const publication = connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision: connections.captureLoginAuthority('server-1'),
            isCurrent: () => current
        });

        await vi.waitFor(() => expect(connections.bootstrapAuthenticatedUser).toHaveBeenCalledOnce());
        current = false;
        bootstrap.resolve();
        await publication;

        expect(provider.state().Servers[0]).toEqual(expect.objectContaining({
            UserId: 'new-user', AccessToken: 'new-token'
        }));
        expect(connections.publishLocalUserState).toHaveBeenCalledOnce();
        expect(activeApiClient.ensureWebSocket).toHaveBeenCalledOnce();
        expect(signedIn).toHaveBeenCalledOnce();
    });

    it('finishes a committed bootstrap before a newer manual login publishes', async () => {
        const { connections, apiClient, provider, result } = arrangeLoginPublication();
        const firstBootstrap = createDeferred();
        connections.bootstrapAuthenticatedUser
            .mockImplementationOnce(() => firstBootstrap.promise)
            .mockResolvedValue(undefined);
        let firstCurrent = true;
        const firstPublication = connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision: connections.captureLoginAuthority('server-1'),
            isCurrent: () => firstCurrent
        });
        await vi.waitFor(() => expect(connections.bootstrapAuthenticatedUser).toHaveBeenCalledOnce());

        const secondPublication = connections.publishLoginAuthentication(apiClient, {
            ...result,
            AccessToken: 'manual-token',
            User: { Id: 'manual-user' }
        }, {
            expectedAuthorityRevision: connections.captureLoginAuthority('server-1'),
            isCurrent: () => true
        });
        expect(provider.writes).toHaveLength(1);
        firstCurrent = false;
        firstBootstrap.resolve();

        await firstPublication;
        await secondPublication;
        expect(provider.state().Servers[0]).toEqual(expect.objectContaining({
            UserId: 'manual-user', AccessToken: 'manual-token'
        }));
        expect(connections.publishLocalUserState).toHaveBeenCalledTimes(2);
    });

    it('settles a rejected W2 bootstrap and leaves the publication queue usable', async () => {
        const { connections, apiClient, result } = arrangeLoginPublication();
        connections.bootstrapAuthenticatedUser.mockRejectedValueOnce(new Error('bootstrap failed'));
        const expectedAuthorityRevision = connections.captureLoginAuthority('server-1');

        await expect(connections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision,
            isCurrent: () => true
        })).rejects.toThrow('bootstrap failed');
        expect(connections.publishLocalUserState).not.toHaveBeenCalled();

        const nextAuthorityRevision = connections.captureLoginAuthority('server-1');
        await connections.publishLoginAuthentication(apiClient, {
            ...result,
            AccessToken: 'later-token'
        }, {
            expectedAuthorityRevision: nextAuthorityRevision,
            isCurrent: () => true
        });
        expect(connections.publishLocalUserState).toHaveBeenCalledOnce();
    });
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

    it('migrates a resolved v1 envelope in real credential storage before accepting a v2 writer', async () => {
        const legacy = { ...createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        ), version: 1 };
        const provider = createProvider({ SessionSwitchEnvelope: legacy });
        const connections = createConnections(provider);
        const store = new ServerConnectionsSessionSwitchStore(connections);

        const migrated = await store.load({ serverId: 'server-1', deviceId: 'device-1' });

        expect(migrated).toMatchObject({ version: 2, revision: 1, marker: null });
        expect(provider.state().Servers[0].SessionSwitchEnvelope).toEqual(migrated);
    });

    it('rejects an old v1 writer after v2 became durable without altering credentials', async () => {
        const provider = createProvider();
        const connections = createConnections(provider);
        const current = createPendingEnvelope();
        await connections.replaceSessionSwitchEnvelope('server-1', 0, current);
        const before = provider.state();

        await expect(connections.replaceSessionSwitchEnvelope('server-1', 1, {
            ...current, version: 1, revision: 2
        })).rejects.toThrow('version');

        expect(provider.state()).toEqual(before);
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

    it('notifies current-user view subscribers only after a selector change is durable', async () => {
        const provider = createProvider({ ProfileSelectorEnabled: false, SessionSwitchAuthorityRevision: 4 });
        const connections = createConnections(provider);
        const before = connections.readFreshSessionAuthority('server-1');
        const seen = [];
        connections.subscribeSessionSwitchEnvelope('server-1', envelope => {
            seen.push({ envelope, authority: connections.readFreshSessionAuthority('server-1') });
        });

        await connections.setProfileSelectorAvailability('server-1', true);
        await connections.setProfileSelectorAvailability('server-1', false);

        expect(seen).toHaveLength(2);
        expect(seen.map(event => event.authority.selectorEnabled)).toEqual([ true, false ]);
        for (const event of seen) {
            expect(event.envelope).toEqual(before.envelope);
            expect(event.authority).toEqual(expect.objectContaining({
                authorityRevision: before.authorityRevision,
                envelope: before.envelope
            }));
        }
    });

    it('does not notify a missing or failed selector update', async () => {
        const provider = createProvider({ ProfileSelectorEnabled: false });
        const connections = createConnections(provider);
        const observed = vi.fn();
        connections.subscribeSessionSwitchEnvelope('server-1', observed);
        connections.subscribeSessionSwitchEnvelope('missing', observed);

        expect(await connections.setProfileSelectorAvailability('missing', true)).toBeNull();
        provider.failOnce();
        await expect(connections.setProfileSelectorAvailability('server-1', true))
            .rejects.toThrow('persistence failpoint');

        expect(observed).not.toHaveBeenCalled();
        expect(connections.readFreshSessionAuthority('server-1').selectorEnabled).toBe(false);
    });

    it('retains a null envelope, marker, and revision while notifying after the selector write', async () => {
        const provider = createProvider({
            ProfileSelectorEnabled: false,
            SessionSwitchEnvelope: null,
            SessionSwitchAuthorityRevision: 3
        });
        const connections = createConnections(provider);
        const seen = [];
        connections.subscribeSessionSwitchEnvelope('server-1', envelope => {
            seen.push({ envelope, authority: connections.readFreshSessionAuthority('server-1') });
        });

        await connections.setProfileSelectorAvailability('server-1', true);

        expect(seen).toEqual([{ envelope: null, authority: expect.objectContaining({
            selectorEnabled: true,
            envelope: null,
            authorityRevision: 3
        }) }]);
        expect(provider.state().Servers[0].SessionSwitchEnvelope).toBeNull();
    });

    it('clears a painted legacy menu through the real selector setter and rejects its late views', async () => {
        const provider = createProvider({ ProfileSelectorEnabled: false });
        const connections = createConnections(provider);
        const container = document.createElement('div');
        document.body.append(container);
        const oldRequest = createDeferred();
        const read = {
            identity: {
                serverId: 'server-1', profileUserId: 'old-user',
                sessionEpoch: 7, authorityGeneration: '7:old'
            },
            assertCurrent: () => {
                if (connections.readFreshSessionAuthority('server-1').selectorEnabled !== false) {
                    throw new Error('stale');
                }
            },
            getCurrentUser: async () => ({ Id: 'old-user', ServerId: 'server-1' }),
            getUserViews: vi.fn(async () => ({ Items: [{ Name: 'old-view' }] }))
        };
        let activeRead = read;
        const menu = createLibraryMenuViews({
            captureRead: () => activeRead,
            prepareDrawer: async () => container,
            currentDrawer: () => container,
            clear: () => container.replaceChildren(),
            renderUser: () => {
                const libraries = document.createElement('div');
                container.append(libraries);
                return { libraries };
            },
            renderViews: (target, result) => { target.textContent = result.Items[0].Name; },
            getLinks: async () => [],
            renderLinks: vi.fn(),
            subscribeAuthority: (bound, listener) => connections.subscribeSessionSwitchEnvelope(
                bound.identity.serverId, listener
            ),
            queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }),
            onError: vi.fn()
        });
        try {
            await menu.refresh();
            expect(container.textContent).toBe('old-view');
            await connections.setProfileSelectorAvailability('server-1', false);
            expect(container.textContent).toBe('old-view');
            await connections.setProfileSelectorAvailability('server-1', true);
            expect(container.textContent).toBe('');
            await connections.setProfileSelectorAvailability('server-1', false);
            expect(container.textContent).toBe('');
            const delayedRead = {
                ...read,
                identity: { ...read.identity, authorityGeneration: '7:next' },
                getUserViews: vi.fn(() => oldRequest.promise)
            };
            activeRead = delayedRead;
            const pendingRefresh = menu.refresh();
            await vi.waitFor(() => expect(delayedRead.getUserViews).toHaveBeenCalledOnce());
            await connections.setProfileSelectorAvailability('server-1', true);
            expect(container.textContent).toBe('');
            await connections.setProfileSelectorAvailability('server-1', false);
            oldRequest.resolve({ Items: [{ Name: 'late-view' }] });
            await pendingRefresh;
            expect(container.textContent).toBe('');
        } finally {
            container.remove();
        }
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
            setWebSocketSessionProvider: vi.fn(),
            serverAddress: () => 'https://server',
            serverId: () => serverInfo.Id,
            serverInfo(next) {
                if (arguments.length > 0) serverInfo = next;
                return serverInfo;
            },
            setAuthenticationInfo: vi.fn()
        };
        connectionsB.addApiClient(apiClient);
        expect(apiClient.setWebSocketSessionProvider).toHaveBeenCalledOnce();
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
        expect(connections.readFreshSessionAuthority('server-1')).toMatchObject({
            userId: null, accessToken: null, envelope: null
        });

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
        expect(connections.readFreshSessionAuthority('server-1')).toBeNull();
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
            serverId: () => 'server-1',
            serverAddress: () => 'https://jellyfin.example',
            serverInfo: vi.fn(),
            setWebSocketSessionProvider: vi.fn(),
            setAuthenticationInfo: vi.fn()
        };
        connections._apiClients = [ oldApiClient ];
        connections.getApiClient = vi.fn(() => oldApiClient);
        connections.setLocalApiClient(oldApiClient);
        expect(oldApiClient.setWebSocketSessionProvider).toHaveBeenCalledOnce();
        expect(oldApiClient.setWebSocketSessionProvider.mock.calls[0][0]()).toBeNull();
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
        expect(isolatedApiClient.setWebSocketSessionProvider).toHaveBeenCalledOnce();
        expect(isolatedApiClient.websocketSessionProvider()).toBeNull();
        isolatedApiClient.getCurrentUser.mockResolvedValue({ Id: 'target-user' });

        expect(provider.writes).toHaveLength(0);
        expect(connections._apiClients).toEqual([ oldApiClient ]);
        expect(connections.getLocalApiClient()).toBe(oldApiClient);
        expect(window.ApiClient).toBe(oldApiClient);
        expect(oldApiClient.closeWebSocket).not.toHaveBeenCalled();
        expect(oldApiClient.setAuthenticationInfo).not.toHaveBeenCalled();
        expect(await connections.getInstalledSessionUser('server-1')).toEqual({ Id: 'target-user' });

        expect(isolatedApiClient.constructorArgs[0]).toBe('https://jellyfin.example');
        const serverDto = isolatedApiClient.serverInfo.mock.lastCall[0];
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

    it('admits realtime only after the real terminal receipt, not completion events during a marker', async () => {
        const provider = createProvider({
            ManualAddress: 'https://server',
            ProfileSelectorEnabled: true,
            SessionSwitchAuthorityRevision: 0
        });
        const connections = createConnections(provider);
        connections.websocketAdmission.dispose();
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId,
            ServerId: 'server-1'
        }));
        connections.websocketAdmission = new WebSocketSessionAdmission(
            connections,
            getWebSessionSwitchApplication(connections),
            probe
        );
        connections.initApiClient('https://server');
        const client = connections.getLocalApiClient();
        let admittedOpens = 0;
        client.ensureWebSocket.mockImplementation(() => {
            if (client.websocketSessionProvider?.()?.isCurrent()) admittedOpens++;
        });
        client.setAuthenticationInfo('old-token', 'old-user');
        connections.websocketAdmission.inspect();
        await vi.waitFor(() => expect(admittedOpens).toBe(1));
        const oldGuard = client.websocketSessionProvider();
        const inspect = vi.spyOn(connections.websocketAdmission, 'inspect');
        const triggerCompletion = signal => {
            const priorInspections = inspect.mock.calls.length;
            Events.trigger(connections, 'sessionswitchcompleted', [signal]);
            expect(inspect).toHaveBeenCalledTimes(priorInspections + 1);
        };
        const publishedCompletion = vi.fn();
        Events.on(connections, 'sessionswitchcompleted', publishedCompletion);

        const pending = createPendingEnvelope();
        const receipt = {
            switchId: 'switch-1', serverId: 'server-1', profileUserId: 'target-user', sessionEpoch: 8
        };
        await connections.replaceSessionSwitchEnvelope('server-1', 0, pending);
        expect(oldGuard.isCurrent()).toBe(false);
        triggerCompletion({ ...receipt, switchId: 'foreign' });
        triggerCompletion(receipt);
        expect(admittedOpens).toBe(1);
        expect(client.websocketSessionProvider()).toBeNull();

        const targetSession = createActiveProfileSession(
            'server-1', 'device-1', 'target-user', 'target-token', 8
        );
        const settledMarker = settledSwitchMarker(pending.marker);
        const committed = {
            ...pending,
            revision: 2,
            activeSession: targetSession,
            marker: { ...settledMarker, kind: 'CommittedPendingCleanup', phase: 'Completing' }
        };
        await connections.replaceSessionSwitchEnvelope('server-1', 1, committed);
        connections.installSessionAuthentication(targetSession);
        connections.publishLocalUserState = vi.fn().mockResolvedValue(undefined);
        const priorCompletionEvents = publishedCompletion.mock.calls.length;
        await connections.publishSessionSwitchCompletion({ Id: 'target-user' }, receipt);
        expect(publishedCompletion).toHaveBeenCalledTimes(priorCompletionEvents + 1);
        expect(publishedCompletion.mock.lastCall).toEqual([expect.anything(), receipt]);
        expect(connections.readFreshSessionAuthority('server-1').envelope.marker).not.toBeNull();
        expect(admittedOpens).toBe(1);
        expect(client.websocketSessionProvider()).toBeNull();

        await connections.replaceSessionSwitchEnvelope('server-1', 2, {
            ...committed,
            revision: 3,
            marker: null,
            lastCompletion: { ...receipt, switchId: 'foreign' }
        });
        expect(admittedOpens).toBe(1);
        expect(client.websocketSessionProvider()).toBeNull();

        await connections.replaceSessionSwitchEnvelope('server-1', 3, {
            ...committed,
            revision: 4,
            marker: null,
            lastCompletion: receipt
        });
        await vi.waitFor(() => expect(admittedOpens).toBe(2));
        const currentGuard = client.websocketSessionProvider();
        const closeCount = client.closeWebSocket.mock.calls.length;
        triggerCompletion(receipt);
        triggerCompletion({ ...receipt, switchId: 'foreign' });
        expect(currentGuard.isCurrent()).toBe(true);
        expect(client.websocketSessionProvider()).toBe(currentGuard);
        expect(admittedOpens).toBe(2);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(client.closeWebSocket).toHaveBeenCalledTimes(closeCount);
    });
});
