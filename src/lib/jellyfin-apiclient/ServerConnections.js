import { Credentials, ApiClient } from 'jellyfin-apiclient';

import { appHost } from 'components/apphost';
import appSettings from 'scripts/settings/appSettings';
import { setUserInfo } from 'scripts/settings/userSettings';
import Dashboard from 'utils/dashboard';
import Events from 'utils/events.ts';
import { toApi } from 'utils/jellyfin-apiclient/compat';

import {
    CORRUPT_SESSION_STORAGE,
    ConcurrentSessionWriteError,
    SessionStorageCorruptionError,
    SessionSwitchUnsupportedEngineError,
    assertSessionEnvelope,
    createOwnerRecoverySession
} from '../profileSelector/sessionSwitch/model';

import ConnectionManager, { revokeSavedSessionAuthority } from './connectionManager';

const normalizeImageOptions = options => {
    if (!options.quality && (options.maxWidth || options.width || options.maxHeight || options.height || options.fillWidth || options.fillHeight)) {
        options.quality = 90;
    }
};

const getMaxBandwidth = () => {
    if (navigator.connection) {
        let max = navigator.connection.downlinkMax;
        if (max && max > 0 && max < Number.POSITIVE_INFINITY) {
            max /= 8;
            max *= 1000000;
            max *= 0.7;
            return parseInt(max, 10);
        }
    }

    return null;
};

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseStoredCredentials = serialized => {
    let credentials;
    try {
        credentials = JSON.parse(serialized);
    } catch {
        throw new SessionStorageCorruptionError();
    }

    if (!isRecord(credentials) || !Array.isArray(credentials.Servers)
        || credentials.Servers.some(server => !isRecord(server))) {
        throw new SessionStorageCorruptionError();
    }

    return credentials;
};

const readSessionAuthorityRevision = server => {
    const revision = server?.SessionSwitchAuthorityRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new SessionStorageCorruptionError();
    }
    return revision;
};

const sessionAuthorityProjection = server => JSON.stringify({
    AccessToken: server?.AccessToken ?? null,
    ExchangeToken: server?.ExchangeToken ?? null,
    OwnerAccessToken: server?.OwnerAccessToken ?? null,
    OwnerUserId: server?.OwnerUserId ?? null,
    SessionSwitchEnvelope: server?.SessionSwitchEnvelope ?? null,
    UserId: server?.UserId ?? null
});

const extractStorageEventEnvelope = (serialized, serverId) => {
    if (serialized === null) {
        return null;
    }

    const credentials = parseStoredCredentials(serialized);
    const server = credentials.Servers.find(savedServer => savedServer.Id === serverId);
    readSessionAuthorityRevision(server);
    return server?.SessionSwitchEnvelope || null;
};

const API_CLIENT_SERVER_INFO_FIELDS = Object.freeze([
    'Id',
    'Name',
    'LocalAddress',
    'RemoteAddress',
    'ManualAddress',
    'LastConnectionMode',
    'DateLastAccessed',
    'Version',
    'ProductName',
    'OperatingSystem',
    'StartupWizardCompleted',
    'UserId'
]);

const createApiClientServerInfo = server => Object.fromEntries(
    API_CLIENT_SERVER_INFO_FIELDS
        .filter(field => server?.[field] !== undefined)
        .map(field => [ field, server[field] ])
);

export class ServerConnections extends ConnectionManager {
    firstConnection = false;

    constructor() {
        super(...arguments);
        this.sessionCredentialProvider = arguments[0];
        this.sessionDeviceId = arguments[4];
        this.sessionEnvelopeListeners = new Map();
        this.stagedSessionBindings = new Map();
        this.localApiClient = null;
        this.firstConnection = null;
        this.mutateCredentials = mutation => this.mutateCredentialsWithAuthority(mutation);

        this.deleteServer = async serverId => {
            if (!serverId) {
                throw new Error('null serverId');
            }

            return this.withSessionEnvelopeLock(serverId, () => {
                const previousCredentials = this.readFreshCredentials();
                const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
                const previousLength = nextCredentials.Servers.length;
                nextCredentials.Servers = nextCredentials.Servers.filter(server => server.Id !== serverId);
                if (nextCredentials.Servers.length === previousLength) {
                    return;
                }

                this.persistCredentials(previousCredentials, nextCredentials);
                this.notifySessionSwitchEnvelope(serverId, null);
            });
        };

        this.logout = async () => {
            const signedOutServers = await Promise.all(this._apiClients
                .filter(apiClient => apiClient.accessToken?.())
                .map(async apiClient => {
                    const serverId = apiClient.serverInfo?.()?.Id;
                    try {
                        await apiClient.logout();
                    } catch {
                        // Local authority is revoked even when remote logout is unavailable.
                    }
                    return serverId;
                }));

            await this.withSessionEnvelopeLock('logout', () => {
                const previousCredentials = this.readFreshCredentials();
                const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
                const revokedServerIds = [];
                nextCredentials.Servers
                    .filter(server => server.UserLinkType !== 'Guest')
                    .forEach(server => {
                        revokeSavedSessionAuthority(server);
                        this.advanceSessionAuthorityRevision(server);
                        revokedServerIds.push(server.Id);
                    });
                this.persistCredentials(previousCredentials, nextCredentials);
                revokedServerIds.forEach(serverId => {
                    this.notifySessionSwitchEnvelope(serverId, null);
                });
            });

            signedOutServers.filter(Boolean).forEach(serverId => {
                Events.trigger(this, 'localusersignedout', [{ serverId }]);
            });
        };

        window.addEventListener('storage', event => {
            if (event.key !== this.sessionCredentialProvider.key) {
                return;
            }

            this.sessionEnvelopeListeners.forEach((_listeners, serverId) => {
                try {
                    this.notifySessionSwitchEnvelope(
                        serverId,
                        extractStorageEventEnvelope(event.newValue, serverId)
                    );
                } catch {
                    this.notifySessionSwitchEnvelope(serverId, CORRUPT_SESSION_STORAGE);
                }
            });
        });

        Events.on(this, 'localusersignedout', (_e, logoutInfo) => {
            setUserInfo(null, null);

            if (window.NativeShell && typeof window.NativeShell.onLocalUserSignedOut === 'function') {
                window.NativeShell.onLocalUserSignedOut(logoutInfo);
            }
        });

        Events.on(this, 'apiclientcreated', (_e, apiClient) => {
            apiClient.getMaxBandwidth = getMaxBandwidth;
            apiClient.normalizeImageOptions = normalizeImageOptions;
        });
    }

    initApiClient(server) {
        console.debug('creating ApiClient singleton');

        const apiClient = new ApiClient(
            createApiClientServerInfo(server),
            appHost.appName(),
            appHost.appVersion(),
            appHost.deviceName(),
            appHost.deviceId()
        );

        apiClient.enableAutomaticNetworking = false;
        apiClient.manualAddressOnly = true;

        this.addApiClient(apiClient);

        this.setLocalApiClient(apiClient);

        console.debug('loaded ApiClient singleton');
    }

    /**
     * @returns {Promise<import('jellyfin-apiclient').ConnectResponse>} The result of the connection attempt.
     */
    connect(options) {
        return super.connect({
            enableAutoLogin: appSettings.enableAutoLogin(),
            ...options
        });
    }

    setLocalApiClient(apiClient) {
        if (apiClient) {
            this.localApiClient = apiClient;
            window.ApiClient = apiClient;
        }
    }

    getLocalApiClient() {
        return this.localApiClient;
    }

    /**
     * Gets the ApiClient that is currently connected.
     * @returns {ApiClient|undefined} apiClient
     */
    currentApiClient() {
        let apiClient = this.getLocalApiClient();

        if (!apiClient) {
            const server = this.getLastUsedServer();

            if (server) {
                apiClient = this.getApiClient(server.Id);
            }
        }

        return apiClient;
    }

    /**
     * Gets the Api that is currently connected.
     * @returns {import(@jellyfin/sdk).Api|undefined} The current Api instance.
     */
    getCurrentApi() {
        const apiClient = this.currentApiClient();
        if (!apiClient) return;

        return toApi(apiClient);
    }

    /**
     * Gets the ApiClient that is currently connected or throws if not defined.
     * @async
     * @returns {Promise<ApiClient>} The current ApiClient instance.
     */
    async getCurrentApiClientAsync() {
        const apiClient = this.currentApiClient();
        if (!apiClient) throw new Error('[ServerConnection] No current ApiClient instance');

        return apiClient;
    }

    getSavedServer(serverId) {
        return this.sessionCredentialProvider.credentials().Servers.find(server => server.Id === serverId) || null;
    }

    updateSavedServer(serverId, updater, options = {}) {
        return this.withSessionEnvelopeLock(serverId, () => {
            const previousCredentials = this.readFreshCredentials();
            const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
            const server = nextCredentials.Servers.find(savedServer => savedServer.Id === serverId);
            if (!server) {
                return null;
            }

            updater(server);
            if (options.advanceSessionAuthority) {
                this.advanceSessionAuthorityRevision(server);
            }
            this.persistCredentials(previousCredentials, nextCredentials);
            if (options.notifySessionEnvelope) {
                this.notifySessionSwitchEnvelope(serverId, server.SessionSwitchEnvelope || null);
            }
            return JSON.parse(JSON.stringify(server));
        });
    }

    mutateCredentialsWithAuthority(mutation) {
        return this.withSessionEnvelopeLock('credentials', () => {
            const previousCredentials = this.readFreshCredentials();
            const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
            const result = mutation(nextCredentials);
            const changedEnvelopes = [];

            nextCredentials.Servers.forEach(server => {
                const previousServer = previousCredentials.Servers.find(candidate => candidate.Id === server.Id);
                if (sessionAuthorityProjection(previousServer) === sessionAuthorityProjection(server)) {
                    return;
                }

                const previousRevision = readSessionAuthorityRevision(previousServer);
                const currentRevision = readSessionAuthorityRevision(server);
                if (currentRevision <= previousRevision) {
                    if (previousRevision === Number.MAX_SAFE_INTEGER) {
                        throw new SessionStorageCorruptionError();
                    }
                    server.SessionSwitchAuthorityRevision = previousRevision + 1;
                }
                changedEnvelopes.push([ server.Id, server.SessionSwitchEnvelope || null ]);
            });

            previousCredentials.Servers.forEach(previousServer => {
                if (!nextCredentials.Servers.some(server => server.Id === previousServer.Id)) {
                    changedEnvelopes.push([ previousServer.Id, null ]);
                }
            });

            this.persistCredentials(previousCredentials, nextCredentials);
            changedEnvelopes.forEach(([ serverId, envelope ]) => {
                this.notifySessionSwitchEnvelope(serverId, envelope);
            });
            return result;
        });
    }

    getSessionSwitchEnvelope(serverId) {
        const server = this.readFreshCredentials().Servers.find(savedServer => savedServer.Id === serverId);
        readSessionAuthorityRevision(server);
        const envelope = server?.SessionSwitchEnvelope;
        if (!envelope) {
            return null;
        }

        const durableEnvelope = JSON.parse(JSON.stringify(envelope));
        assertSessionEnvelope(durableEnvelope);
        return durableEnvelope;
    }

    async replaceSessionSwitchEnvelope(serverId, expectedRevision, envelope) {
        assertSessionEnvelope(envelope);
        if (envelope.activeSession.serverId !== serverId) {
            throw new TypeError('[ServerConnection] Session envelope server mismatch');
        }

        if (envelope.revision !== expectedRevision + 1) {
            throw new TypeError('[ServerConnection] Session envelope revision must advance exactly once');
        }

        const expectedAuthorityRevision = this.getSessionAuthorityRevision(
            this.readFreshCredentials().Servers.find(server => server.Id === serverId)
        );

        return this.withSessionEnvelopeLock(serverId, async () => {
            await this.beforeSessionEnvelopeSink();
            const durableEnvelope = JSON.parse(JSON.stringify(envelope));
            const previousCredentials = this.readFreshCredentials();
            const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
            const server = nextCredentials.Servers.find(savedServer => savedServer.Id === serverId);
            if (!server) {
                throw new Error(`[ServerConnection] Saved server not found: ${serverId}`);
            }

            if (this.getSessionAuthorityRevision(server) !== expectedAuthorityRevision) {
                throw new ConcurrentSessionWriteError(server.SessionSwitchEnvelope?.revision ?? 0);
            }

            if (server.SessionSwitchEnvelope) {
                assertSessionEnvelope(server.SessionSwitchEnvelope);
            }
            const actualRevision = server.SessionSwitchEnvelope?.revision ?? 0;
            if (actualRevision !== expectedRevision) {
                throw new ConcurrentSessionWriteError(actualRevision);
            }

            server.SessionSwitchEnvelope = durableEnvelope;
            const isQuarantined = durableEnvelope.marker?.kind === 'QuarantinedSession';
            server.UserId = isQuarantined ? null : durableEnvelope.activeSession.profileUserId;
            server.AccessToken = isQuarantined ? null : durableEnvelope.activeSession.credentialRef.token;
            server.OwnerUserId = durableEnvelope.recoverySession?.ownerUserId || null;
            server.OwnerAccessToken = durableEnvelope.recoverySession?.credentialRef.token || null;
            server.DateLastAccessed = new Date().getTime();
            this.advanceSessionAuthorityRevision(server);

            this.persistCredentials(previousCredentials, nextCredentials);
            this.assertSessionEnvelopeWriteWon(serverId, durableEnvelope, expectedAuthorityRevision + 1);
            this.notifySessionSwitchEnvelope(serverId, durableEnvelope);
        });
    }

    clearSessionSwitchEnvelope(serverId) {
        return this.updateSavedServer(serverId, savedServer => {
            savedServer.SessionSwitchEnvelope = null;
            savedServer.OwnerUserId = null;
            savedServer.OwnerAccessToken = null;
        }, {
            advanceSessionAuthority: true,
            notifySessionEnvelope: true
        });
    }

    clearResolvedSessionSwitchEnvelope(serverId, expectedRevision) {
        return this.withSessionEnvelopeLock(serverId, async () => {
            await this.beforeResolvedSessionEnvelopeClearSink();
            const previousCredentials = this.readFreshCredentials();
            const nextCredentials = JSON.parse(JSON.stringify(previousCredentials));
            const server = nextCredentials.Servers.find(savedServer => savedServer.Id === serverId);
            const envelope = server?.SessionSwitchEnvelope;
            if (!server || !envelope) {
                throw new ConcurrentSessionWriteError(0);
            }

            assertSessionEnvelope(envelope);
            if (envelope.revision !== expectedRevision || envelope.marker !== null) {
                throw new ConcurrentSessionWriteError(envelope.revision);
            }

            server.SessionSwitchEnvelope = null;
            server.OwnerUserId = null;
            server.OwnerAccessToken = null;
            this.advanceSessionAuthorityRevision(server);
            this.persistCredentials(previousCredentials, nextCredentials);
            this.notifySessionSwitchEnvelope(serverId, null);
        });
    }

    subscribeSessionSwitchEnvelope(serverId, listener) {
        let listeners = this.sessionEnvelopeListeners.get(serverId);
        if (!listeners) {
            listeners = new Set();
            this.sessionEnvelopeListeners.set(serverId, listeners);
        }
        listeners.add(listener);

        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.sessionEnvelopeListeners.delete(serverId);
            }
        };
    }

    notifySessionSwitchEnvelope(serverId, envelope) {
        this.sessionEnvelopeListeners.get(serverId)?.forEach(listener => {
            listener(envelope ? JSON.parse(JSON.stringify(envelope)) : null);
        });
    }

    getActiveProfileSession(serverId) {
        const envelope = this.getSessionSwitchEnvelope(serverId);
        return envelope?.marker?.kind === 'QuarantinedSession' ? null : envelope?.activeSession || null;
    }

    getOwnerRecoverySession(serverId) {
        const envelope = this.getSessionSwitchEnvelope(serverId);
        return envelope?.recoverySession || null;
    }

    getSessionDeviceId() {
        return this.sessionDeviceId;
    }

    async cacheOwnerSession(serverId, ownerUserId, ownerAccessToken) {
        if (!serverId || !ownerUserId || !ownerAccessToken) {
            return;
        }

        const envelope = this.getSessionSwitchEnvelope(serverId);
        if (envelope) {
            await this.replaceSessionSwitchEnvelope(serverId, envelope.revision, {
                ...envelope,
                revision: envelope.revision + 1,
                recoverySession: createOwnerRecoverySession(
                    serverId,
                    envelope.activeSession.deviceId,
                    ownerUserId,
                    ownerAccessToken
                )
            });
            return;
        }

        await this.mutateCredentials(credentials => {
            const server = credentials.Servers.find(savedServer => savedServer.Id === serverId);
            if (!server) {
                return null;
            }
            server.OwnerUserId = ownerUserId;
            server.OwnerAccessToken = ownerAccessToken;
            return JSON.parse(JSON.stringify(server));
        });
    }

    readFreshCredentials() {
        const serialized = this.credentialStorage().getItem(this.sessionCredentialProvider.key);
        if (serialized === null) {
            return { Servers: [] };
        }

        return parseStoredCredentials(serialized);
    }

    withSessionEnvelopeLock(_serverId, operation) {
        const lockManager = navigator['locks'];
        if (!lockManager || typeof lockManager.request !== 'function') {
            throw new SessionSwitchUnsupportedEngineError();
        }

        const lockName = `${this.sessionCredentialProvider.key}:credentials`;
        return lockManager.request(lockName, { mode: 'exclusive' }, lock => {
            if (!lock) {
                throw new SessionSwitchUnsupportedEngineError();
            }
            return operation();
        });
    }

    beforeSessionEnvelopeSink() {
        return Promise.resolve();
    }

    beforeResolvedSessionEnvelopeClearSink() {
        return Promise.resolve();
    }

    assertSessionEnvelopeWriteWon(serverId, envelope, authorityRevision) {
        const storedCredentials = this.readFreshCredentials();
        const storedServer = storedCredentials.Servers.find(server => server.Id === serverId);
        const storedEnvelope = storedServer?.SessionSwitchEnvelope;

        if (JSON.stringify(storedEnvelope) !== JSON.stringify(envelope)
            || this.getSessionAuthorityRevision(storedServer) !== authorityRevision) {
            throw new ConcurrentSessionWriteError(storedEnvelope?.revision ?? 0);
        }
    }

    getSessionAuthorityRevision(server) {
        return readSessionAuthorityRevision(server);
    }

    advanceSessionAuthorityRevision(server) {
        const revision = this.getSessionAuthorityRevision(server);
        if (revision === Number.MAX_SAFE_INTEGER) {
            throw new SessionStorageCorruptionError();
        }
        server.SessionSwitchAuthorityRevision = revision + 1;
    }

    persistCredentials(previousCredentials, nextCredentials) {
        try {
            this.sessionCredentialProvider.credentials(nextCredentials);
        } catch (error) {
            try {
                this.sessionCredentialProvider.credentials(previousCredentials);
            } catch {
                // The original persistence failure remains actionable.
            }
            throw error;
        }
    }

    credentialStorage() {
        return this.sessionCredentialProvider.appStorage || window.localStorage;
    }

    setProfileSelectorAvailability(serverId, isEnabled) {
        if (!serverId) {
            return Promise.resolve(null);
        }

        return this.updateSavedServer(serverId, server => {
            server.ProfileSelectorEnabled = !!isEnabled;
        });
    }

    async applyAuthenticationResult(serverId, authenticationResult) {
        if (!serverId || !authenticationResult?.AccessToken || !authenticationResult?.User?.Id) {
            throw new Error('[ServerConnection] Invalid profile selector authentication result');
        }

        if (this.getSessionSwitchEnvelope(serverId) !== null) {
            throw new Error('[ServerConnection] Legacy profile activation is blocked by durable session authority');
        }

        const server = await this.mutateCredentials(credentials => {
            const savedServer = credentials.Servers.find(candidate => candidate.Id === serverId);
            if (!savedServer) {
                return null;
            }
            if (savedServer.SessionSwitchEnvelope) {
                throw new Error('[ServerConnection] Legacy profile activation is blocked by durable session authority');
            }
            savedServer.UserId = authenticationResult.User.Id;
            savedServer.AccessToken = authenticationResult.AccessToken;
            savedServer.DateLastAccessed = new Date().getTime();
            return JSON.parse(JSON.stringify(savedServer));
        });

        if (!server) {
            throw new Error(`[ServerConnection] Saved server not found: ${serverId}`);
        }

        const apiClient = this.installAuthenticationBinding(
            server,
            authenticationResult.AccessToken,
            authenticationResult.User.Id
        );

        const user = {
            ...authenticationResult.User,
            ServerId: serverId
        };

        await this.bootstrapAuthenticatedUser(user);
        apiClient.ensureWebSocket();
        await this.publishLocalUserState(user);
        Events.trigger(this, 'localusersignedin', [user]);

        return apiClient;
    }

    installSessionAuthentication(session) {
        if (!session?.serverId || !session?.profileUserId || !session?.credentialRef?.token) {
            throw new TypeError('[ServerConnection] Invalid active profile session');
        }

        const server = this.readFreshCredentials().Servers.find(candidate => candidate.Id === session.serverId);
        if (!server
            || server.UserId !== session.profileUserId
            || server.AccessToken !== session.credentialRef.token) {
            throw new Error('[ServerConnection] Durable active session projection mismatch');
        }

        const current = this.getApiClient(session.serverId);
        const alreadyInstalled = current?.accessToken?.() === session.credentialRef.token
            && current?.getCurrentUserId?.() === session.profileUserId;
        const apiClient = alreadyInstalled ?
            current :
            this.createIsolatedSessionApiClient(server, session);
        this.stagedSessionBindings.set(session.serverId, {
            apiClient,
            isolated: !alreadyInstalled,
            session
        });
    }

    resetInstalledSession(serverId) {
        const binding = this.getStagedSessionBinding(serverId);
        if (binding.isolated) {
            this.getApiClient(serverId)?.closeWebSocket();
        }
        binding.apiClient.closeWebSocket();
    }

    reconnectInstalledSession(serverId) {
        this.getStagedSessionBinding(serverId).apiClient.ensureWebSocket();
    }

    getInstalledSessionUser(serverId) {
        return this.getStagedSessionBinding(serverId).apiClient.getCurrentUser();
    }

    discardStagedSession(serverId) {
        const binding = this.stagedSessionBindings.get(serverId);
        if (binding?.isolated) {
            binding.apiClient.closeWebSocket();
            binding.apiClient.setAuthenticationInfo(null, null);
        }
        this.stagedSessionBindings.delete(serverId);
    }

    clearInstalledSession(serverId) {
        this.discardStagedSession(serverId);
        const apiClient = this.getApiClient(serverId);
        if (!apiClient) return;

        apiClient.closeWebSocket();
        const server = this.readFreshCredentials().Servers.find(candidate => candidate.Id === serverId);
        if (server) {
            apiClient.serverInfo(createApiClientServerInfo(server));
        }
        apiClient.setAuthenticationInfo(null, null);
    }

    async publishSessionSwitchCompletion(user, receipt) {
        if (!user?.Id || user.Id !== receipt?.profileUserId || !receipt.serverId) {
            throw new Error('[ServerConnection] Session completion identity mismatch');
        }

        const binding = this.getStagedSessionBinding(receipt.serverId);
        if (binding.session.profileUserId !== receipt.profileUserId
            || binding.session.sessionEpoch !== receipt.sessionEpoch) {
            throw new Error('[ServerConnection] Staged session completion mismatch');
        }

        if (binding.isolated) {
            const server = this.readFreshCredentials().Servers.find(candidate => candidate.Id === receipt.serverId);
            if (!server
                || server.UserId !== binding.session.profileUserId
                || server.AccessToken !== binding.session.credentialRef.token) {
                throw new Error('[ServerConnection] Durable completion projection mismatch');
            }

            const activeApiClient = this.getApiClient(receipt.serverId);
            if (!activeApiClient) {
                throw new Error(`[ServerConnection] ApiClient not found: ${receipt.serverId}`);
            }
            activeApiClient.closeWebSocket();
            activeApiClient.serverInfo(createApiClientServerInfo(server));
            activeApiClient.setAuthenticationInfo(
                binding.session.credentialRef.token,
                binding.session.profileUserId
            );
            this.setLocalApiClient(activeApiClient);
            activeApiClient.ensureWebSocket();
        }

        this.discardStagedSession(receipt.serverId);
        await this.publishLocalUserState({ ...user, ServerId: receipt.serverId });
        Events.trigger(this, 'sessionswitchcompleted', [receipt]);
    }

    async onLocalUserSignedIn(user) {
        await this.bootstrapAuthenticatedUser(user);
        return this.publishLocalUserState(user);
    }

    bootstrapAuthenticatedUser(user) {
        const apiClient = this.getApiClient(user.ServerId);
        if (!apiClient) {
            return Promise.reject(new Error(`[ServerConnection] ApiClient not found: ${user.ServerId}`));
        }

        return import('../profileSelector/sessionSwitch/application').then(({ getWebSessionSwitchApplication }) => {
            return getWebSessionSwitchApplication(this).bootstrapAuthenticatedSession(apiClient, user);
        });
    }

    publishLocalUserState(user) {
        const apiClient = this.getApiClient(user.ServerId);
        this.setLocalApiClient(apiClient);
        return setUserInfo(user.Id, apiClient).then(() => {
            if (window.NativeShell && typeof window.NativeShell.onLocalUserSignedIn === 'function') {
                return window.NativeShell.onLocalUserSignedIn(user, apiClient.accessToken());
            }
            return Promise.resolve();
        });
    }

    installAuthenticationBinding(server, accessToken, userId) {
        const apiClient = this.getOrCreateApiClient(server.Id);
        apiClient.closeWebSocket();
        apiClient.serverInfo(createApiClientServerInfo(server));
        apiClient.setAuthenticationInfo(accessToken, userId);
        this.setLocalApiClient(apiClient);
        return apiClient;
    }

    createIsolatedSessionApiClient(server, session) {
        const serverInfo = createApiClientServerInfo(server);
        const apiClient = new ApiClient(
            serverInfo,
            appHost.appName(),
            appHost.appVersion(),
            appHost.deviceName(),
            appHost.deviceId()
        );
        apiClient.enableAutomaticNetworking = false;
        apiClient.manualAddressOnly = true;
        apiClient.serverInfo(serverInfo);
        apiClient.setAuthenticationInfo(session.credentialRef.token, session.profileUserId);
        return apiClient;
    }

    getStagedSessionBinding(serverId) {
        const binding = this.stagedSessionBindings.get(serverId);
        if (!binding) {
            throw new Error(`[ServerConnection] Staged session not found: ${serverId}`);
        }
        return binding;
    }
}

const credentialProvider = new Credentials();

const capabilities = Dashboard.capabilities(appHost);

export default new ServerConnections(
    credentialProvider,
    appHost.appName(),
    appHost.appVersion(),
    appHost.deviceName(),
    appHost.deviceId(),
    capabilities);
