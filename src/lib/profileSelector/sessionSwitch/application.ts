import { getCurrentProfileSelector } from '../api';

import { LegacyProfileSwitchApi, type ProfileSwitchApiPort } from './api';
import { SessionAdmissionBarrier } from './barrier';
import {
    ProfileSessionSwitchCoordinator,
    type PlaybackQuiescePort,
    type SessionSwitchClock
} from './coordinator';
import {
    ConcurrentSessionWriteError,
    SessionStorageCorruptionError,
    SessionSwitchRecoveryRequiredError,
    createActiveProfileSession,
    createOwnerRecoverySession,
    type ActiveProfileSession,
    type SessionSwitchEnvelope
} from './model';
import { ServerConnectionsSessionRuntime } from './runtime';
import {
    ServerConnectionsSessionSwitchStore,
    createSessionSwitchEnvelope,
    type AtomicSessionSwitchStore,
    type SessionScope
} from './store';

interface AuthenticatedUser {
    readonly Id?: string;
    readonly ServerId?: string | null;
}

interface ProfileSelectorState {
    readonly IsEnabled: boolean;
    readonly IsCurrentUserOwner: boolean;
    readonly OwnerUserId: string | null;
}

interface ProfileSwitchApiClient {
    accessToken(): string | null;
    getCurrentUser(): Promise<AuthenticatedUser>;
    getCurrentUserId(): string | null;
    getJSON(url: string, authenticated?: boolean): Promise<unknown>;
    getUrl(path: string): string;
    ajax(options: Record<string, unknown>): Promise<{ json(): Promise<unknown> }>;
    serverId(): string;
}

interface SessionSwitchConnections {
    getApiClient(serverId: string): ProfileSwitchApiClient | null;
    getSessionDeviceId(): string;
    getSessionSwitchEnvelope(serverId: string): unknown;
    replaceSessionSwitchEnvelope(
        serverId: string,
        expectedRevision: number,
        envelope: SessionSwitchEnvelope
    ): Promise<void>;
    subscribeSessionSwitchEnvelope(serverId: string, listener: (envelope: unknown) => void): () => void;
    setProfileSelectorAvailability(serverId: string, isEnabled: boolean): Promise<unknown>;
    clearSessionSwitchEnvelope(serverId: string): Promise<unknown>;
    clearResolvedSessionSwitchEnvelope(serverId: string, expectedRevision: number): Promise<void>;
    installSessionAuthentication(session: ActiveProfileSession): void;
    resetInstalledSession(serverId: string): void;
    reconnectInstalledSession(serverId: string): void;
    getInstalledSessionUser(serverId: string): Promise<AuthenticatedUser>;
    discardStagedSession(serverId: string): void;
    clearInstalledSession(serverId: string): void;
    publishSessionSwitchCompletion(user: AuthenticatedUser, receipt: unknown): Promise<void>;
}

interface SessionContext {
    readonly coordinator: ProfileSessionSwitchCoordinator;
    readonly runtime: ServerConnectionsSessionRuntime;
    readonly store: AtomicSessionSwitchStore;
}

export interface ProfileSessionBootstrapResult {
    readonly selector: ProfileSelectorState | null;
    readonly activeSession: ActiveProfileSession | null;
}

interface WebSessionSwitchApplicationOptions {
    readonly clock?: SessionSwitchClock;
    readonly createCoordinatorId?: () => string;
    readonly createApi?: (serverId: string) => ProfileSwitchApiPort;
    readonly playback?: PlaybackQuiescePort;
}

const defaultClock: SessionSwitchClock = {
    now: () => Date.now(),
    sleep: milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds))
};

const disabledPlaybackPort: PlaybackQuiescePort = {
    stopAndReport: async () => ({ outcome: 'Failed' })
};

export class WebSessionSwitchApplication {
    private readonly contexts = new Map<string, SessionContext>();
    private readonly clock: SessionSwitchClock;
    private readonly createCoordinatorId: () => string;
    private readonly createApi: (serverId: string) => ProfileSwitchApiPort;
    private readonly playback: PlaybackQuiescePort;

    constructor(
        private readonly connections: SessionSwitchConnections,
        options: WebSessionSwitchApplicationOptions = {}
    ) {
        this.clock = options.clock ?? defaultClock;
        this.createCoordinatorId = options.createCoordinatorId ?? createSecureCoordinatorId;
        this.createApi = options.createApi ?? (serverId => new DelegatingProfileSwitchApi(connections, serverId));
        this.playback = options.playback ?? disabledPlaybackPort;
    }

    async bootstrapAuthenticatedSession(
        apiClient: ProfileSwitchApiClient,
        authenticatedUser?: AuthenticatedUser
    ): Promise<ProfileSessionBootstrapResult> {
        const user = authenticatedUser ?? await apiClient.getCurrentUser();
        assertAuthenticatedBinding(apiClient, user);
        const selector = await getCurrentProfileSelector(apiClient) as ProfileSelectorState | null;
        const activeSession = await this.reconcile(apiClient, user, selector);
        return { selector, activeSession };
    }

    async prepareProtectedRoute(apiClient: ProfileSwitchApiClient): Promise<ProfileSessionBootstrapResult> {
        return this.bootstrapAuthenticatedSession(apiClient);
    }

    private async reconcile(
        apiClient: ProfileSwitchApiClient,
        user: AuthenticatedUser,
        selector: ProfileSelectorState | null
    ): Promise<ActiveProfileSession | null> {
        let currentUser = user;
        const serverId = apiClient.serverId();
        const scope = this.createScope(serverId);
        const context = this.getContext(scope);
        const stored = await context.store.load(scope);

        if (!selector?.IsEnabled) {
            await this.disableSelector(context, scope, stored, apiClient, currentUser);
            return null;
        }

        await this.connections.setProfileSelectorAvailability(serverId, true);
        let envelope = stored;
        if (envelope === null) {
            envelope = await this.initializeEnvelope(context.store, scope, apiClient, currentUser, selector);
        }
        if (envelope.marker !== null) {
            await context.coordinator.recover();
            envelope = await this.loadRequired(context.store, scope);
            currentUser = await apiClient.getCurrentUser();
        }

        assertRuntimeAuthentication(envelope, apiClient, currentUser);
        envelope = await this.establishExplicitOwnerRecovery(context.store, scope, envelope, apiClient, selector);

        if (!context.runtime.isVerifiedSession(envelope.activeSession)) {
            await context.runtime.installActiveSession(envelope.activeSession);
            if (!await context.runtime.reconnectAndVerify(envelope.activeSession)) {
                throw new SessionSwitchRecoveryRequiredError(envelope.marker?.switchId ?? 'identity-probe');
            }
        }
        return envelope.activeSession;
    }

    private async disableSelector(
        context: SessionContext,
        scope: SessionScope,
        stored: SessionSwitchEnvelope | null,
        apiClient: ProfileSwitchApiClient,
        user: AuthenticatedUser
    ): Promise<void> {
        let currentUser = user;
        let durable = stored;
        if (durable?.marker) {
            await context.coordinator.recover();
            durable = await this.requireResolvedEnvelope(context.store, scope);
            currentUser = await apiClient.getCurrentUser();
        }

        assertAuthenticatedBinding(apiClient, currentUser);
        await this.connections.setProfileSelectorAvailability(scope.serverId, false);
        durable = await context.store.load(scope);
        if (durable?.marker) {
            await context.coordinator.recover();
            durable = await this.requireResolvedEnvelope(context.store, scope);
            currentUser = await apiClient.getCurrentUser();
            assertAuthenticatedBinding(apiClient, currentUser);
        }
        if (durable !== null) {
            await this.clearResolvedDisabledEnvelope(context, scope, durable, apiClient, currentUser);
        }
    }

    private async clearResolvedDisabledEnvelope(
        context: SessionContext,
        scope: SessionScope,
        initial: SessionSwitchEnvelope,
        apiClient: ProfileSwitchApiClient,
        initialUser: AuthenticatedUser
    ): Promise<void> {
        let envelope = initial;
        let currentUser = initialUser;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.connections.clearResolvedSessionSwitchEnvelope(
                    scope.serverId,
                    envelope.revision
                );
                return;
            } catch (error) {
                if (!(error instanceof ConcurrentSessionWriteError)) throw error;

                const winner = await context.store.load(scope);
                if (winner === null) return;
                envelope = winner;
                if (envelope.marker !== null) {
                    await context.coordinator.recover();
                    envelope = await this.requireResolvedEnvelope(context.store, scope);
                    currentUser = await apiClient.getCurrentUser();
                }
                assertRuntimeAuthentication(envelope, apiClient, currentUser);
            }
        }

        throw new SessionSwitchRecoveryRequiredError('selector-disabled-cleanup-conflict');
    }

    private async initializeEnvelope(
        store: AtomicSessionSwitchStore,
        scope: SessionScope,
        apiClient: ProfileSwitchApiClient,
        user: AuthenticatedUser,
        selector: ProfileSelectorState
    ): Promise<SessionSwitchEnvelope> {
        const token = requireAccessToken(apiClient);
        const activeSession = createActiveProfileSession(
            scope.serverId,
            scope.deviceId,
            requireUserId(user),
            token,
            0
        );
        const userId = requireUserId(user);
        const recoverySession = selector.IsCurrentUserOwner && selector.OwnerUserId === userId ?
            createOwnerRecoverySession(scope.serverId, scope.deviceId, userId, token) :
            null;
        const initial = createSessionSwitchEnvelope(activeSession, recoverySession);

        try {
            return await store.compareAndSwap(scope, 0, { ...initial, revision: 1 });
        } catch (error) {
            if (!(error instanceof ConcurrentSessionWriteError)) {
                throw error;
            }
            const winner = await store.load(scope);
            if (winner === null) {
                throw new SessionSwitchRecoveryRequiredError('session-envelope');
            }
            return winner;
        }
    }

    private async establishExplicitOwnerRecovery(
        store: AtomicSessionSwitchStore,
        scope: SessionScope,
        envelope: SessionSwitchEnvelope,
        apiClient: ProfileSwitchApiClient,
        selector: ProfileSelectorState
    ): Promise<SessionSwitchEnvelope> {
        if (!selector.IsCurrentUserOwner
            || selector.OwnerUserId !== envelope.activeSession.profileUserId
            || envelope.recoverySession !== null) {
            return envelope;
        }

        const recoverySession = createOwnerRecoverySession(
            scope.serverId,
            scope.deviceId,
            selector.OwnerUserId,
            requireAccessToken(apiClient)
        );
        return store.compareAndSwap(scope, envelope.revision, {
            ...envelope,
            revision: envelope.revision + 1,
            recoverySession
        });
    }

    private getContext(scope: SessionScope): SessionContext {
        const key = `${scope.serverId}:${scope.deviceId}`;
        const existing = this.contexts.get(key);
        if (existing) return existing;

        const store = new ServerConnectionsSessionSwitchStore(this.connections);
        const barrier = new SessionAdmissionBarrier();
        const runtime = new ServerConnectionsSessionRuntime(this.connections);
        store.subscribe(scope, observation => {
            if (observation === null || 'kind' in observation) {
                runtime.invalidate(scope.serverId);
            }
        });
        const coordinator = new ProfileSessionSwitchCoordinator(scope, {
            coordinatorId: this.createCoordinatorId(),
            api: this.createApi(scope.serverId),
            store,
            barrier,
            playback: this.playback,
            runtime,
            clock: this.clock
        });
        const context = { coordinator, runtime, store };
        this.contexts.set(key, context);
        return context;
    }

    private createScope(serverId: string): SessionScope {
        const deviceId = this.connections.getSessionDeviceId();
        if (!serverId || !deviceId) {
            throw new TypeError('A server and device binding is required for session bootstrap.');
        }
        return { serverId, deviceId };
    }

    private async loadRequired(
        store: AtomicSessionSwitchStore,
        scope: SessionScope
    ): Promise<SessionSwitchEnvelope> {
        const envelope = await store.load(scope);
        if (envelope === null) {
            throw new SessionStorageCorruptionError();
        }
        return envelope;
    }

    private async requireResolvedEnvelope(
        store: AtomicSessionSwitchStore,
        scope: SessionScope
    ): Promise<SessionSwitchEnvelope> {
        const envelope = await this.loadRequired(store, scope);
        if (envelope.marker !== null) {
            throw new SessionSwitchRecoveryRequiredError(envelope.marker.switchId);
        }
        return envelope;
    }
}

class DelegatingProfileSwitchApi implements ProfileSwitchApiPort {
    constructor(
        private readonly connections: SessionSwitchConnections,
        private readonly serverId: string
    ) {}

    prepare(command: Parameters<ProfileSwitchApiPort['prepare']>[0]) {
        return this.client().prepare(command);
    }

    commit(switchId: string) {
        return this.client().commit(switchId);
    }

    status(switchId: string) {
        return this.client().status(switchId);
    }

    abort(switchId: string) {
        return this.client().abort(switchId);
    }

    private client(): LegacyProfileSwitchApi {
        const apiClient = this.connections.getApiClient(this.serverId);
        if (!apiClient) {
            throw new SessionSwitchRecoveryRequiredError('api-client');
        }
        return new LegacyProfileSwitchApi(apiClient);
    }
}

const applications = new WeakMap<object, WebSessionSwitchApplication>();

export function getWebSessionSwitchApplication(
    connections: SessionSwitchConnections
): WebSessionSwitchApplication {
    let application = applications.get(connections as object);
    if (!application) {
        application = new WebSessionSwitchApplication(connections);
        applications.set(connections as object, application);
    }
    return application;
}

function assertAuthenticatedBinding(
    apiClient: ProfileSwitchApiClient,
    user: AuthenticatedUser
): void {
    if (!apiClient.serverId() || !user?.Id
        || apiClient.getCurrentUserId() !== user.Id
        || !apiClient.accessToken()) {
        throw new SessionSwitchRecoveryRequiredError('authentication-binding');
    }
}

function assertRuntimeAuthentication(
    envelope: SessionSwitchEnvelope,
    apiClient: ProfileSwitchApiClient,
    user: AuthenticatedUser
): void {
    assertAuthenticatedBinding(apiClient, user);
    if (envelope.activeSession.serverId !== apiClient.serverId()
        || envelope.activeSession.profileUserId !== user.Id
        || envelope.activeSession.credentialRef.token !== apiClient.accessToken()) {
        throw new SessionSwitchRecoveryRequiredError(envelope.marker?.switchId ?? 'authentication-mismatch');
    }
}

function requireAccessToken(apiClient: ProfileSwitchApiClient): string {
    const token = apiClient.accessToken();
    if (!token) {
        throw new SessionSwitchRecoveryRequiredError('missing-active-credential');
    }
    return token;
}

function requireUserId(user: AuthenticatedUser): string {
    if (!user.Id) {
        throw new SessionSwitchRecoveryRequiredError('missing-user-identity');
    }
    return user.Id;
}

function createSecureCoordinatorId(): string {
    const browserCrypto = window['crypto'];
    if (!browserCrypto?.getRandomValues) {
        throw new SessionSwitchRecoveryRequiredError('secure-random-unavailable');
    }

    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
