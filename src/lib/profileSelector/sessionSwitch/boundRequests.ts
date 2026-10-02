import { SessionAdmissionBarrier, type SessionWorkLease } from './barrier';
import { type ActiveProfileSession, type SessionSwitchEnvelope } from './model';

export interface FreshSessionAuthority {
    readonly serverId: string;
    readonly userId: string | null;
    readonly accessToken: string | null;
    readonly selectorEnabled: boolean | undefined;
    readonly authorityRevision: number;
    readonly envelope: SessionSwitchEnvelope | null;
}

interface BoundReadClient {
    serverId(): string;
    serverAddress(): string;
    deviceId(): string;
    getCurrentUserId(): string | null;
    accessToken(): string | null;
}

interface BoundReadConnections {
    getApiClient(serverId: string): BoundReadClient | null;
    currentApiClient(): BoundReadClient | null | undefined;
    getSessionDeviceId(): string;
    readFreshSessionAuthority(serverId: string): FreshSessionAuthority | null;
}

export interface BoundSessionReadIdentity {
    readonly serverId: string;
    readonly profileUserId: string;
    readonly sessionEpoch: number;
    readonly authorityGeneration: string;
}

export interface BoundSessionReadPort {
    readonly binding: Readonly<ActiveProfileSession>;
    readonly basePath: string;
    readonly identity: BoundSessionReadIdentity;
    acquire(): SessionWorkLease;
    assertCurrent(): void;
}

export class StaleSessionReadError extends Error {
    constructor() {
        super('Session read was cancelled because its authority changed.');
        this.name = 'StaleSessionReadError';
    }
}

export function createBoundSessionReadPort(
    client: BoundReadClient,
    connections: BoundReadConnections,
    barrier: SessionAdmissionBarrier,
    authority: FreshSessionAuthority | null
): BoundSessionReadPort | null {
    if (!authority || !isValidAuthority(client, connections, authority)) return null;

    const snapshot = authority.selectorEnabled === true ?
        authority.envelope?.activeSession :
        {
            serverId: authority.serverId,
            deviceId: client.deviceId(),
            profileUserId: authority.userId!,
            credentialRef: { scope: 'active-profile' as const, token: authority.accessToken! },
            sessionEpoch: 0
        };
    if (!snapshot) return null;

    const basePath = normalizeBasePath(client.serverAddress());
    if (!basePath) return null;
    const generation = createReadGeneration(authority.authorityRevision);
    if (!generation) return null;
    const binding = Object.freeze({
        ...snapshot,
        credentialRef: Object.freeze({ ...snapshot.credentialRef })
    });
    const identity = Object.freeze({
        serverId: binding.serverId,
        profileUserId: binding.profileUserId,
        sessionEpoch: binding.sessionEpoch,
        authorityGeneration: generation
    });

    const assertCurrent = () => {
        if (barrier.isClosed() || connections.currentApiClient() !== client
            || connections.getApiClient(binding.serverId) !== client
            || client.serverId() !== binding.serverId
            || client.deviceId() !== binding.deviceId
            || client.getCurrentUserId() !== binding.profileUserId
            || client.accessToken() !== binding.credentialRef.token
            || normalizeBasePath(client.serverAddress()) !== basePath) throw new StaleSessionReadError();

        let fresh: FreshSessionAuthority | null;
        try {
            fresh = connections.readFreshSessionAuthority(binding.serverId);
        } catch {
            throw new StaleSessionReadError();
        }
        if (!fresh || fresh.authorityRevision !== authority.authorityRevision
            || !isValidAuthority(client, connections, fresh)
            || fresh.selectorEnabled !== authority.selectorEnabled
            || (fresh.selectorEnabled === true && !sameSession(fresh.envelope?.activeSession, binding))
            || (fresh.selectorEnabled === true && !sameSession(barrier.current(), binding))) {
            throw new StaleSessionReadError();
        }
    };

    return Object.freeze({
        binding,
        basePath,
        identity,
        assertCurrent,
        acquire: () => {
            assertCurrent();
            const lease = barrier.admit(binding, 'read');
            try {
                assertCurrent();
                if (lease.signal.aborted) throw new StaleSessionReadError();
                return lease;
            } catch (error) {
                lease.settle();
                throw error;
            }
        }
    });
}

function createReadGeneration(revision: number): string | null {
    const browserCrypto = window['crypto'];
    if (!browserCrypto?.getRandomValues) return null;

    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return `${revision}:${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isValidAuthority(
    client: BoundReadClient,
    connections: BoundReadConnections,
    authority: FreshSessionAuthority
): boolean {
    if (!authority.serverId || !authority.userId || !authority.accessToken
        || !Number.isSafeInteger(authority.authorityRevision)
        || authority.authorityRevision < 0
        || client.serverId() !== authority.serverId
        || client.deviceId() !== connections.getSessionDeviceId()
        || client.getCurrentUserId() !== authority.userId
        || client.accessToken() !== authority.accessToken) return false;

    if (authority.selectorEnabled === false) return authority.envelope === null;
    if (authority.selectorEnabled !== true || authority.envelope?.marker !== null) return false;
    return sameSession(authority.envelope?.activeSession, {
        serverId: authority.serverId,
        deviceId: client.deviceId(),
        profileUserId: authority.userId,
        credentialRef: { scope: 'active-profile', token: authority.accessToken },
        sessionEpoch: authority.envelope.activeSession.sessionEpoch
    });
}

function sameSession(left: ActiveProfileSession | null | undefined, right: ActiveProfileSession): boolean {
    return !!left && left.serverId === right.serverId
        && left.deviceId === right.deviceId
        && left.profileUserId === right.profileUserId
        && left.sessionEpoch === right.sessionEpoch
        && left.credentialRef.token === right.credentialRef.token;
}

function normalizeBasePath(value: string): string | null {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash
            || url.username || url.password) return null;
        let normalized = url.href;
        while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
        return normalized;
    } catch {
        return null;
    }
}
