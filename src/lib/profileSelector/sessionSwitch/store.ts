import {
    CORRUPT_SESSION_STORAGE,
    SESSION_SWITCH_ENVELOPE_VERSION,
    ConcurrentSessionWriteError,
    SessionStorageCorruptionError,
    SessionSwitchRecoveryRequiredError,
    assertSessionEnvelope,
    assertStoredSessionEnvelope,
    type ActiveProfileSession,
    type LegacySessionSwitchEnvelope,
    type OwnerRecoverySession,
    type SessionEnvelopeObservation,
    type SessionSwitchEnvelope
} from './model';

export interface SessionScope {
    readonly serverId: string;
    readonly deviceId: string;
}

export interface AtomicSessionSwitchStore {
    load(scope: SessionScope): Promise<SessionSwitchEnvelope | null>;
    compareAndSwap(
        scope: SessionScope,
        expectedRevision: number,
        envelope: SessionSwitchEnvelope
    ): Promise<SessionSwitchEnvelope>;
    waitForChange(scope: SessionScope, revision: number): Promise<SessionSwitchEnvelope>;
    subscribe(scope: SessionScope, listener: (envelope: SessionEnvelopeObservation) => void): () => void;
}

export interface ServerConnectionsEnvelopePersistence {
    getSessionSwitchEnvelope(serverId: string): unknown;
    replaceSessionSwitchEnvelope(
        serverId: string,
        expectedRevision: number,
        envelope: SessionSwitchEnvelope
    ): Promise<void>;
    subscribeSessionSwitchEnvelope(
        serverId: string,
        listener: (envelope: unknown) => void
    ): () => void;
}

export class ServerConnectionsSessionSwitchStore implements AtomicSessionSwitchStore {
    constructor(private readonly persistence: ServerConnectionsEnvelopePersistence) {}

    async load(scope: SessionScope): Promise<SessionSwitchEnvelope | null> {
        const stored = this.persistence.getSessionSwitchEnvelope(scope.serverId);
        if (stored === null || stored === undefined) {
            return null;
        }
        assertStoredSessionEnvelope(stored);
        if (stored.version === 1) return this.migrateLegacy(scope, stored);
        const envelope = cloneEnvelope(stored);
        assertScope(envelope, scope);
        return envelope;
    }

    private async migrateLegacy(
        scope: SessionScope,
        stored: LegacySessionSwitchEnvelope
    ): Promise<SessionSwitchEnvelope> {
        if (stored.marker !== null
            && (stored.marker.kind !== 'PendingSwitch' || stored.marker.phase !== 'Preparing')) {
            throw new SessionSwitchRecoveryRequiredError(stored.marker.switchId);
        }
        const marker = stored.marker === null ? null : { ...stored.marker, playbackReport: null };
        try {
            return await this.compareAndSwap(scope, stored.revision, {
                ...stored,
                version: SESSION_SWITCH_ENVELOPE_VERSION,
                revision: stored.revision + 1,
                marker
            });
        } catch (error) {
            if (!(error instanceof ConcurrentSessionWriteError)) throw error;
            return this.loadMigrationWinner(scope);
        }
    }

    private loadMigrationWinner(scope: SessionScope): SessionSwitchEnvelope {
        const current = this.persistence.getSessionSwitchEnvelope(scope.serverId);
        if (current === null || current === undefined) throw new SessionStorageCorruptionError();
        assertStoredSessionEnvelope(current);
        if (current.version !== SESSION_SWITCH_ENVELOPE_VERSION) {
            throw new SessionSwitchRecoveryRequiredError('legacy-session-envelope');
        }
        const winner = cloneEnvelope(current);
        assertScope(winner, scope);
        return winner;
    }

    compareAndSwap(
        scope: SessionScope,
        expectedRevision: number,
        envelope: SessionSwitchEnvelope
    ): Promise<SessionSwitchEnvelope> {
        const durableEnvelope = cloneEnvelope(envelope);
        assertScope(durableEnvelope, scope);
        if (durableEnvelope.revision !== expectedRevision + 1) {
            throw new TypeError('Atomic replacement must advance the envelope revision exactly once.');
        }

        return this.persistence
            .replaceSessionSwitchEnvelope(scope.serverId, expectedRevision, durableEnvelope)
            .then(() => durableEnvelope);
    }

    waitForChange(scope: SessionScope, revision: number): Promise<SessionSwitchEnvelope> {
        return new Promise((resolve, reject) => {
            let unsubscribe: () => void = () => undefined;
            unsubscribe = this.subscribe(scope, envelope => {
                if (envelope !== null && 'kind' in envelope) {
                    unsubscribe();
                    reject(new SessionStorageCorruptionError());
                    return;
                }
                if (envelope !== null && envelope.revision > revision) {
                    unsubscribe();
                    resolve(envelope);
                }
            });

            void this.load(scope).then(
                envelope => {
                    if (envelope !== null && envelope.revision > revision) {
                        unsubscribe();
                        resolve(envelope);
                    }
                },
                error => {
                    unsubscribe();
                    reject(error);
                }
            );
        });
    }

    subscribe(scope: SessionScope, listener: (envelope: SessionEnvelopeObservation) => void): () => void {
        return this.persistence.subscribeSessionSwitchEnvelope(scope.serverId, stored => {
            if (stored === null || stored === undefined) {
                listener(null);
                return;
            }

            try {
                const envelope = cloneEnvelope(stored);
                assertScope(envelope, scope);
                listener(envelope);
            } catch {
                listener(CORRUPT_SESSION_STORAGE);
            }
        });
    }
}

export function createSessionSwitchEnvelope(
    activeSession: ActiveProfileSession,
    recoverySession: OwnerRecoverySession | null = null
): SessionSwitchEnvelope {
    if (recoverySession !== null
        && (recoverySession.serverId !== activeSession.serverId || recoverySession.deviceId !== activeSession.deviceId)) {
        throw new TypeError('Recovery session must be bound to the active server and device.');
    }

    return Object.freeze({
        version: SESSION_SWITCH_ENVELOPE_VERSION,
        revision: 0,
        activeSession,
        recoverySession,
        marker: null,
        lastCompletion: null
    });
}

export function cloneEnvelope(value: unknown): SessionSwitchEnvelope {
    const clone: unknown = JSON.parse(JSON.stringify(value));
    assertSessionEnvelope(clone);
    return clone;
}

function assertScope(envelope: SessionSwitchEnvelope, scope: SessionScope): void {
    if (envelope.activeSession.serverId !== scope.serverId || envelope.activeSession.deviceId !== scope.deviceId) {
        throw new TypeError('Session switch envelope is not bound to the requested server and device.');
    }
}
