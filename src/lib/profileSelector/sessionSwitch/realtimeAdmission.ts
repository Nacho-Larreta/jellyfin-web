import type { ApiClient, WebSocketDeliveryContext } from 'jellyfin-apiclient';

import type { BoundSessionReadPort, FreshSessionAuthority } from './boundRequests';
import {
    capturePendingOldAuthority,
    matchesCompletion,
    samePublication,
    sameRestoredSession,
    verifiedAuthority,
    type PublishedAuthority
} from './publicationAuthority';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

interface RealtimeConnections {
    currentApiClient(): ApiClient | null | undefined;
    getApiClient(serverId: string): ApiClient | null | undefined;
    readFreshSessionAuthority(serverId: string): FreshSessionAuthority | null;
    subscribeSessionSwitchEnvelope(serverId: string, listener: () => void): () => void;
}

interface RealtimeSessionApplication {
    captureBoundSessionRead(client: ApiClient): BoundSessionReadPort | null;
    subscribeSessionAdmission(serverId: string, listener: () => void): () => void;
}

interface ProbeUser {
    readonly Id?: string;
    readonly ServerId?: string | null;
}

type ProbeUserIdentity = (client: ApiClient, port: BoundSessionReadPort, signal: AbortSignal) => Promise<ProbeUser>;
type ReadinessMode = 'initial' | 'target' | 'restored';

interface PendingProbe {
    readonly authority: PublishedAuthority;
    readonly mode: ReadinessMode;
    readonly generation: number;
    readonly abort: AbortController;
}

interface ActiveGrant {
    readonly authority: PublishedAuthority;
    readonly guard: WebSocketDeliveryContext;
}

const USER_PROBE_TIMEOUT_MS = 12_000;

async function probeCurrentUser(client: ApiClient, port: BoundSessionReadPort, signal: AbortSignal): Promise<ProbeUser> {
    return createSessionScopedReadApi(client, port).getCurrentUser(signal);
}

export class WebSocketSessionAdmission {
    private readonly installedClients = new Set<ApiClient>();
    private readonly unsubscribeByServer = new Map<string, () => void>();
    private generation = 0;
    private grant: ActiveGrant | null = null;
    private pending: PendingProbe | null = null;
    private closedAuthority: PublishedAuthority | null = null;
    private coldOldAuthority: PublishedAuthority | null = null;
    private observedSwitchId: string | null = null;
    private restoreAllowed = false;
    private inspecting = false;
    private inspectAgain = false;
    private disposed = false;

    constructor(
        private readonly connections: RealtimeConnections,
        private readonly application: RealtimeSessionApplication,
        private readonly probeUser: ProbeUserIdentity = probeCurrentUser
    ) {}

    register(client: ApiClient): void {
        if (this.disposed) return;
        if (!this.installedClients.has(client)) {
            client.setWebSocketSessionProvider(() => this.capture(client));
            this.installedClients.add(client);
        }
        this.observeServer(client.serverId());
        this.inspect();
    }

    inspect(): void {
        if (this.disposed) return;
        if (this.inspecting) {
            this.inspectAgain = true;
            return;
        }
        this.inspecting = true;
        try {
            do {
                this.inspectAgain = false;
                this.inspectOnce();
            } while (this.inspectAgain);
        } finally {
            this.inspecting = false;
        }
    }

    signedOut(): void {
        this.revoke();
        this.closedAuthority = null;
        this.coldOldAuthority = null;
        this.observedSwitchId = null;
        this.restoreAllowed = false;
        this.inspect();
    }

    signedIn(): void {
        const serverId = this.connections.currentApiClient()?.serverId();
        if (serverId && !this.observedSwitchId && !this.readAuthority(serverId)?.envelope?.marker) {
            this.closedAuthority = null;
            this.coldOldAuthority = null;
            this.observedSwitchId = null;
            this.restoreAllowed = false;
        }
        this.inspect();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.revoke();
        this.unsubscribeByServer.forEach(unsubscribe => {
            unsubscribe();
        });
        this.unsubscribeByServer.clear();
        this.installedClients.forEach(client => {
            client.setWebSocketSessionProvider(null);
        });
        this.installedClients.clear();
    }

    private capture(client: ApiClient): WebSocketDeliveryContext | null {
        const grant = this.grant;
        return grant?.authority.client === client && grant.guard.isCurrent() ? grant.guard : null;
    }

    private observeServer(serverId: string): void {
        if (!serverId || this.unsubscribeByServer.has(serverId)) return;
        const unsubscribeAdmission = this.application.subscribeSessionAdmission(serverId, () => this.inspect());
        const unsubscribeEnvelope = this.connections.subscribeSessionSwitchEnvelope(serverId, () => this.inspect());
        this.unsubscribeByServer.set(serverId, () => {
            unsubscribeEnvelope();
            unsubscribeAdmission();
        });
    }

    private inspectOnce(): void {
        const client = this.connections.currentApiClient();
        if (!client || !this.installedClients.has(client)) {
            this.revoke();
            return;
        }
        const serverId = client.serverId();
        this.observeServer(serverId);
        const fresh = this.readAuthority(serverId);
        const candidate = this.verifyAuthority(client, fresh);

        if (this.grant?.guard.isCurrent()) return;
        if (this.grant) {
            this.closedAuthority = this.grant.authority;
            this.restoreAllowed = !!fresh?.envelope?.marker;
            this.revoke();
        }

        if (fresh?.envelope?.marker) {
            this.observeMarker(client, fresh);
            return;
        }
        if (!fresh || !candidate) {
            this.revokePending();
            return;
        }
        const mode = this.readinessMode(fresh, candidate);
        if (!mode) {
            this.revokePending();
            return;
        }
        if (this.pending && samePublication(this.pending.authority, candidate)
            && this.pending.mode === mode) return;
        this.revokePending();
        const port = this.application.captureBoundSessionRead(client);
        if (!port || port.binding.serverId !== candidate.serverId
            || port.binding.profileUserId !== candidate.userId
            || port.binding.sessionEpoch !== candidate.epoch) return;

        const pending: PendingProbe = {
            authority: candidate,
            mode,
            generation: ++this.generation,
            abort: new window['AbortController']()
        };
        this.pending = pending;
        void this.verifyAndOpen(client, port, pending);
    }

    private observeMarker(client: ApiClient, fresh: FreshSessionAuthority): void {
        const switchId = fresh.envelope?.marker?.switchId;
        if (!switchId) return;
        if (this.observedSwitchId !== switchId) {
            if (!this.closedAuthority) {
                this.coldOldAuthority = capturePendingOldAuthority(
                    client, fresh, this.connections.getApiClient(fresh.serverId)
                );
            }
            this.observedSwitchId = switchId;
            this.revokePending();
        }
    }

    private readinessMode(fresh: FreshSessionAuthority, candidate: PublishedAuthority): ReadinessMode | null {
        const old = this.closedAuthority ?? this.coldOldAuthority;
        if (old && (this.restoreAllowed || this.coldOldAuthority)
            && sameRestoredSession(old, candidate)) return 'restored';
        if (this.observedSwitchId) {
            return matchesCompletion(fresh, this.observedSwitchId, candidate) ? 'target' : null;
        }
        return old ? null : 'initial';
    }

    private async verifyAndOpen(client: ApiClient, port: BoundSessionReadPort, pending: PendingProbe): Promise<void> {
        const timeout = window.setTimeout(() => pending.abort.abort(), USER_PROBE_TIMEOUT_MS);
        try {
            const user = await this.probeUser(client, port, pending.abort.signal);
            if (this.pending !== pending || pending.abort.signal.aborted
                || user?.Id !== pending.authority.userId
                || user.ServerId && user.ServerId !== pending.authority.serverId) return;

            port.assertCurrent();
            const fresh = this.readAuthority(pending.authority.serverId);
            const latest = this.verifyAuthority(client, fresh);
            if (!latest || !samePublication(pending.authority, latest)
                || this.readinessMode(fresh!, latest) !== pending.mode) return;

            const generation = pending.generation;
            const grant: ActiveGrant = {
                authority: latest,
                guard: Object.freeze({ isCurrent: () => this.isGrantCurrent(grant, port, generation) })
            };
            this.pending = null;
            this.grant = grant;
            this.closedAuthority = null;
            this.coldOldAuthority = null;
            this.observedSwitchId = null;
            this.restoreAllowed = false;
            if (grant.guard.isCurrent()) client.ensureWebSocket();
        } catch {
            // Failed or cancelled identity probes cannot grant realtime authority.
        } finally {
            window.clearTimeout(timeout);
            if (this.pending === pending) this.pending = null;
        }
    }

    private isGrantCurrent(grant: ActiveGrant, port: BoundSessionReadPort, generation: number): boolean {
        if (this.disposed || this.generation !== generation || this.grant !== grant) return false;
        try {
            port.assertCurrent();
            const fresh = this.readAuthority(grant.authority.serverId);
            const latest = this.verifyAuthority(grant.authority.client, fresh);
            return !!latest && samePublication(grant.authority, latest);
        } catch {
            return false;
        }
    }

    private readAuthority(serverId: string): FreshSessionAuthority | null {
        try {
            return serverId ? this.connections.readFreshSessionAuthority(serverId) : null;
        } catch {
            return null;
        }
    }

    private verifyAuthority(client: ApiClient, fresh: FreshSessionAuthority | null): PublishedAuthority | null {
        if (!fresh) return null;
        try {
            return verifiedAuthority(
                client, fresh, this.connections.currentApiClient(),
                this.connections.getApiClient(fresh.serverId)
            );
        } catch {
            return null;
        }
    }

    private revokePending(): void {
        if (!this.pending) return;
        this.pending.abort.abort();
        this.pending = null;
        this.generation++;
    }

    private revoke(): void {
        this.revokePending();
        if (!this.grant) return;
        const client = this.grant.authority.client;
        this.grant = null;
        this.generation++;
        client.closeWebSocket();
    }
}
