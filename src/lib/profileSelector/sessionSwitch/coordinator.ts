import { type ProfileSwitchApiPort } from './api';
import { SessionAdmissionBarrier } from './barrier';
import {
    CommitUnknownError,
    CORRUPT_SESSION_STORAGE,
    ConcurrentSessionWriteError,
    DeterministicSwitchRejectionError,
    PlaybackQuiesceFailedError,
    SessionSwitchRecoveryRequiredError,
    SessionSwitchTimeoutError,
    SessionStorageCorruptionError,
    SwitchAlreadyInProgressError,
    createActiveProfileSession,
    type ActiveProfileSession,
    type CleanupPhase,
    type CommittedPendingCleanup,
    type PendingSwitchRecord,
    type PlaybackQuiesceResult,
    type QuarantinedSession,
    type ServerSwitchResult,
    type SessionSwitchCompletionReceipt,
    type SessionSwitchEnvelope,
    type SessionSwitchMarker,
    type SessionSwitchRequest
} from './model';
import { type AtomicSessionSwitchStore, type SessionScope } from './store';

type TimedOperation = 'Prepare' | 'Commit' | 'Status' | 'Abort' | 'Join';

export interface SessionSwitchClock {
    now(): number;
    sleep(milliseconds: number): Promise<void>;
}

export interface SessionSwitchTimeoutPolicy {
    readonly prepareMs: number;
    readonly commitMs: number;
    readonly statusMs: number;
    readonly abortMs: number;
    readonly joinMs: number;
    readonly leaseMs: number;
}

export interface PlaybackQuiescePort {
    stopAndReport(snapshot: ActiveProfileSession, switchId: string): Promise<PlaybackQuiesceResult>;
}

export interface SessionRuntimePort {
    installActiveSession(session: ActiveProfileSession): Promise<void>;
    restoreOldSession(session: ActiveProfileSession): Promise<boolean>;
    resetSessionState(marker: CommittedPendingCleanup, session: ActiveProfileSession): Promise<void>;
    reconnectAndVerify(session: ActiveProfileSession): Promise<boolean>;
    clearActiveSession(session: ActiveProfileSession): Promise<void>;
    publishCompleted(receipt: SessionSwitchCompletionReceipt): Promise<void>;
}

export interface ProfileSessionSwitchCoordinatorDependencies {
    readonly coordinatorId: string;
    readonly api: ProfileSwitchApiPort;
    readonly store: AtomicSessionSwitchStore;
    readonly barrier: SessionAdmissionBarrier;
    readonly playback: PlaybackQuiescePort;
    readonly runtime: SessionRuntimePort;
    readonly clock: SessionSwitchClock;
    readonly timeouts?: SessionSwitchTimeoutPolicy;
}

interface InFlightSwitch {
    readonly switchId: string;
    readonly requestIdentity: string;
    readonly promise: Promise<ActiveProfileSession>;
}

const DEFAULT_TIMEOUTS: SessionSwitchTimeoutPolicy = Object.freeze({
    prepareMs: 15_000,
    commitMs: 15_000,
    statusMs: 10_000,
    abortMs: 10_000,
    joinMs: 20_000,
    leaseMs: 30_000
});

export class ProfileSessionSwitchCoordinator {
    private inFlight: InFlightSwitch | null = null;
    private readonly unsubscribe: () => void;
    private readonly coordinatorId: string;
    private readonly api: ProfileSwitchApiPort;
    private readonly store: AtomicSessionSwitchStore;
    private readonly barrier: SessionAdmissionBarrier;
    private readonly playback: PlaybackQuiescePort;
    private readonly runtime: SessionRuntimePort;
    private readonly clock: SessionSwitchClock;
    private readonly timeouts: SessionSwitchTimeoutPolicy;

    constructor(
        private readonly scope: SessionScope,
        dependencies: ProfileSessionSwitchCoordinatorDependencies
    ) {
        if (!dependencies.coordinatorId) {
            throw new TypeError('coordinatorId is required.');
        }

        this.coordinatorId = dependencies.coordinatorId;
        this.api = dependencies.api;
        this.store = dependencies.store;
        this.barrier = dependencies.barrier;
        this.playback = dependencies.playback;
        this.runtime = dependencies.runtime;
        this.clock = dependencies.clock;
        this.timeouts = dependencies.timeouts ?? DEFAULT_TIMEOUTS;
        this.unsubscribe = this.store.subscribe(scope, envelope => {
            this.barrier.synchronize(envelope);
        });
    }

    dispose(): void {
        this.unsubscribe();
    }

    switchProfile(request: SessionSwitchRequest): Promise<ActiveProfileSession> {
        validateRequest(request);
        const requestIdentity = createEphemeralRequestIdentity(request);
        if (this.inFlight !== null) {
            if (this.inFlight.switchId === request.switchId
                && this.inFlight.requestIdentity === requestIdentity) {
                return this.inFlight.promise;
            }

            return Promise.reject(new SwitchAlreadyInProgressError(this.inFlight.switchId));
        }

        const promise = this.execute(request);
        this.inFlight = { switchId: request.switchId, requestIdentity, promise };
        void promise.then(
            () => this.clearInFlight(promise),
            () => this.clearInFlight(promise)
        );
        return promise;
    }

    async recover(): Promise<ActiveProfileSession> {
        const envelope = await this.loadRequiredEnvelope();
        if (envelope.marker === null) {
            return envelope.activeSession;
        }

        return this.resumeOrJoin(envelope);
    }

    private async execute(request: SessionSwitchRequest): Promise<ActiveProfileSession> {
        const envelope = await this.loadRequiredEnvelope();

        if (envelope.lastCompletion?.switchId === request.switchId) {
            if (envelope.lastCompletion.profileUserId !== request.targetProfileUserId) {
                throw new DeterministicSwitchRejectionError(409);
            }

            return envelope.activeSession;
        }

        if (envelope.marker !== null) {
            assertMatchingReplay(envelope.marker, request);
            return this.resumeOrJoin(envelope);
        }

        if (request.targetProfileUserId === envelope.activeSession.profileUserId) {
            return envelope.activeSession;
        }

        return this.start(envelope, request);
    }

    private async start(
        envelope: SessionSwitchEnvelope,
        request: SessionSwitchRequest
    ): Promise<ActiveProfileSession> {
        let durable: SessionSwitchEnvelope;
        try {
            durable = await this.replace(envelope, {
                ...envelope,
                lastCompletion: null,
                marker: {
                    kind: 'PendingSwitch',
                    phase: 'Preparing',
                    switchId: request.switchId,
                    serverId: this.scope.serverId,
                    deviceId: this.scope.deviceId,
                    oldProfileUserId: envelope.activeSession.profileUserId,
                    oldEpoch: envelope.activeSession.sessionEpoch,
                    targetProfileUserId: request.targetProfileUserId,
                    coordinatorId: this.coordinatorId,
                    fencingToken: 1,
                    leaseExpiresAtMs: this.leaseExpiry(),
                    updatedAtMs: this.clock.now()
                }
            });
        } catch (error) {
            if (error instanceof SessionSwitchRecoveryRequiredError) {
                return this.execute(request);
            }
            throw error;
        }
        this.barrier.close(request.switchId);

        let prepared: ServerSwitchResult;
        try {
            prepared = await this.timed('Prepare', this.api.prepare(request));
        } catch (error) {
            const restored = await this.restoreOld(
                durable,
                !(error instanceof DeterministicSwitchRejectionError)
            );
            if (restored.profileUserId !== durable.activeSession.profileUserId) {
                return restored;
            }
            throw error;
        }

        assertServerResult(prepared, durable.marker);
        if (prepared.state === 'Committed') {
            return this.installCommitted(durable, prepared);
        }

        if (prepared.state !== 'Prepared') {
            await this.restoreOld(durable, false);
            throw new DeterministicSwitchRejectionError(409);
        }

        durable = await this.movePending(durable, 'Quiescing');
        try {
            const playbackResult = await this.playback.stopAndReport(
                durable.activeSession,
                request.switchId
            );
            if (playbackResult.outcome === 'Failed') {
                throw new PlaybackQuiesceFailedError();
            }
            await this.barrier.drainMutations();
        } catch (error) {
            const restored = await this.restoreOld(durable, true);
            if (restored.profileUserId !== durable.activeSession.profileUserId) {
                return restored;
            }
            throw error;
        }

        durable = await this.movePending(durable, 'Committing');
        return this.commit(durable);
    }

    private async resumeOrJoin(envelope: SessionSwitchEnvelope): Promise<ActiveProfileSession> {
        const marker = requireMarker(envelope);
        this.barrier.close(marker.switchId);

        if (marker.kind === 'QuarantinedSession') {
            return this.resumeQuarantine(envelope);
        }

        if (marker.coordinatorId !== this.coordinatorId) {
            envelope = await this.followOrClaimForeignSwitch(envelope);
            if (envelope.marker === null) {
                return envelope.activeSession;
            }
        }

        return this.resumeOwnedSwitch(envelope);
    }

    private async followOrClaimForeignSwitch(envelope: SessionSwitchEnvelope): Promise<SessionSwitchEnvelope> {
        const marker = requireMarker(envelope);
        if (marker.leaseExpiresAtMs <= this.clock.now()) {
            return this.claimExpiredLease(envelope);
        }

        let changed: SessionSwitchEnvelope;
        try {
            changed = await this.timed('Join', this.store.waitForChange(this.scope, envelope.revision));
        } catch (error) {
            if (!(error instanceof SessionSwitchTimeoutError)) {
                throw error;
            }

            changed = await this.loadRequiredEnvelope();
            if (changed.revision === envelope.revision
                && requireMarker(changed).leaseExpiresAtMs > this.clock.now()) {
                throw new SessionSwitchRecoveryRequiredError(marker.switchId);
            }
        }

        if (changed.marker !== null
            && changed.marker.kind !== 'QuarantinedSession'
            && changed.marker.coordinatorId !== this.coordinatorId) {
            return this.followOrClaimForeignSwitch(changed);
        }
        return changed;
    }

    private async resumeOwnedSwitch(envelope: SessionSwitchEnvelope): Promise<ActiveProfileSession> {
        const ownedMarker = requireMarker(envelope);
        if (ownedMarker.kind === 'CommittedPendingCleanup') {
            return this.finishCleanup(envelope);
        }

        if (ownedMarker.kind === 'QuarantinedSession') {
            return this.resumeQuarantine(envelope);
        }

        if (ownedMarker.phase === 'Preparing' || ownedMarker.phase === 'Quiescing') {
            return this.restoreOld(envelope, true);
        }

        return this.resolveCommit(envelope);
    }

    private async claimExpiredLease(envelope: SessionSwitchEnvelope): Promise<SessionSwitchEnvelope> {
        const marker = requireMarker(envelope);
        return this.replace(envelope, {
            ...envelope,
            marker: {
                ...marker,
                coordinatorId: this.coordinatorId,
                fencingToken: marker.fencingToken + 1,
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
    }

    private async commit(
        envelope: SessionSwitchEnvelope,
        resolveUnknown: boolean = true
    ): Promise<ActiveProfileSession> {
        const marker = requirePendingMarker(envelope);
        let result: ServerSwitchResult;
        try {
            result = await this.timed('Commit', this.api.commit(marker.switchId));
        } catch (error) {
            if (error instanceof CommitUnknownError
                || (error instanceof SessionSwitchTimeoutError && error.operation === 'Commit')) {
                const unknownEnvelope = await this.movePending(envelope, 'CommitUnknown');
                if (resolveUnknown) {
                    return this.resolveCommit(unknownEnvelope);
                }
                throw new SessionSwitchRecoveryRequiredError(marker.switchId);
            }

            if (error instanceof DeterministicSwitchRejectionError) {
                const restored = await this.restoreOld(envelope, true);
                if (restored.profileUserId !== envelope.activeSession.profileUserId) {
                    return restored;
                }
            }
            throw error;
        }

        assertServerResult(result, marker);
        if (result.state !== 'Committed') {
            const restored = await this.restoreOld(envelope, true);
            if (restored.profileUserId !== envelope.activeSession.profileUserId) {
                return restored;
            }
            throw new DeterministicSwitchRejectionError(409);
        }

        return this.installCommitted(envelope, result);
    }

    private async resolveCommit(envelope: SessionSwitchEnvelope): Promise<ActiveProfileSession> {
        const marker = requirePendingMarker(envelope);
        const resolving = marker.phase === 'ResolvingCommit' ?
            envelope :
            await this.movePending(envelope, 'ResolvingCommit');

        let result: ServerSwitchResult;
        try {
            result = await this.timed('Status', this.api.status(marker.switchId));
        } catch {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }

        assertServerResult(result, marker);
        if (result.state === 'Committed') {
            return this.installCommitted(resolving, result);
        }
        if (result.state === 'Prepared') {
            const committing = await this.movePending(resolving, 'Committing');
            return this.commit(committing, false);
        }

        return this.restoreOld(resolving, false);
    }

    private async installCommitted(
        envelope: SessionSwitchEnvelope,
        result: ServerSwitchResult
    ): Promise<ActiveProfileSession> {
        const marker = requirePendingMarker(envelope);
        if (result.authentication === null
            || result.authentication.userId !== marker.targetProfileUserId) {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }

        const nextEpoch = marker.oldEpoch + 1;
        if (!Number.isSafeInteger(nextEpoch)) {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }

        const activeSession = createActiveProfileSession(
            marker.serverId,
            marker.deviceId,
            marker.targetProfileUserId,
            result.authentication.accessToken,
            nextEpoch
        );
        const committedEnvelope = await this.replace(envelope, {
            ...envelope,
            activeSession,
            marker: {
                ...marker,
                kind: 'CommittedPendingCleanup',
                phase: 'Installing',
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
        return this.finishCleanup(committedEnvelope);
    }

    private async finishCleanup(envelope: SessionSwitchEnvelope): Promise<ActiveProfileSession> {
        let durable = envelope;
        let marker = requireCleanupMarker(durable);

        try {
            if (marker.phase === 'Installing') {
                await this.runtime.installActiveSession(durable.activeSession);
                durable = await this.moveCleanup(durable, 'Resetting');
                marker = requireCleanupMarker(durable);
            }
            if (marker.phase === 'Resetting') {
                await this.runtime.resetSessionState(marker, durable.activeSession);
                durable = await this.moveCleanup(durable, 'Reconnecting');
                marker = requireCleanupMarker(durable);
            }
            if (marker.phase === 'Reconnecting') {
                if (!await this.runtime.reconnectAndVerify(durable.activeSession)) {
                    await this.quarantine(durable);
                }
                durable = await this.moveCleanup(durable, 'Completing');
                marker = requireCleanupMarker(durable);
            }

            const receipt = createCompletionReceipt(marker, durable.activeSession);
            await this.runtime.publishCompleted(receipt);
            const completedEnvelope = await this.replace(durable, {
                ...durable,
                marker: null,
                lastCompletion: receipt
            });
            this.barrier.reopen(marker.switchId);
            return completedEnvelope.activeSession;
        } catch (error) {
            if (error instanceof SessionSwitchRecoveryRequiredError) {
                throw error;
            }
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }
    }

    private async quarantine(envelope: SessionSwitchEnvelope): Promise<never> {
        const marker = requireCleanupMarker(envelope);
        let durable = await this.replace(envelope, {
            ...envelope,
            marker: {
                ...marker,
                kind: 'QuarantinedSession',
                phase: 'ClearingBinding',
                reason: 'IdentityMismatch',
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
        await this.runtime.clearActiveSession(durable.activeSession);
        const quarantined = requireQuarantineMarker(durable);
        durable = await this.replace(durable, {
            ...durable,
            marker: {
                ...quarantined,
                phase: 'Quarantined',
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
        throw new SessionSwitchRecoveryRequiredError(requireMarker(durable).switchId);
    }

    private async resumeQuarantine(envelope: SessionSwitchEnvelope): Promise<never> {
        let marker = requireQuarantineMarker(envelope);
        if (marker.phase === 'ClearingBinding') {
            await this.runtime.clearActiveSession(envelope.activeSession);
            envelope = await this.replace(envelope, {
                ...envelope,
                marker: {
                    ...marker,
                    phase: 'Quarantined',
                    leaseExpiresAtMs: this.leaseExpiry(),
                    updatedAtMs: this.clock.now()
                }
            });
            marker = requireQuarantineMarker(envelope);
        }
        throw new SessionSwitchRecoveryRequiredError(marker.switchId);
    }

    private async restoreOld(
        envelope: SessionSwitchEnvelope,
        abortPrepared: boolean
    ): Promise<ActiveProfileSession> {
        const marker = requirePendingMarker(envelope);
        if (abortPrepared) {
            let aborted: ServerSwitchResult;
            try {
                aborted = await this.timed('Abort', this.api.abort(marker.switchId));
            } catch (error) {
                if (error instanceof DeterministicSwitchRejectionError && error.status === 409) {
                    return this.resolveAbortedConflict(envelope);
                }
                throw new SessionSwitchRecoveryRequiredError(marker.switchId);
            }
            assertServerResult(aborted, marker);
            if (aborted.state === 'Committed') {
                return this.installCommitted(envelope, aborted);
            }
            if (aborted.state !== 'Aborted' && aborted.state !== 'Expired') {
                throw new SessionSwitchRecoveryRequiredError(marker.switchId);
            }
        }

        let identityMatches = false;
        try {
            identityMatches = await this.runtime.restoreOldSession(envelope.activeSession);
        } catch {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }
        if (!identityMatches) {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }

        const restored = await this.replace(envelope, { ...envelope, marker: null });
        this.barrier.reopen(marker.switchId);
        return restored.activeSession;
    }

    private async resolveAbortedConflict(envelope: SessionSwitchEnvelope): Promise<ActiveProfileSession> {
        const marker = requirePendingMarker(envelope);
        let result: ServerSwitchResult;
        try {
            result = await this.timed('Status', this.api.status(marker.switchId));
        } catch {
            throw new SessionSwitchRecoveryRequiredError(marker.switchId);
        }

        assertServerResult(result, marker);
        if (result.state === 'Committed') {
            return this.installCommitted(envelope, result);
        }
        if (result.state === 'Aborted' || result.state === 'Expired') {
            return this.restoreOld(envelope, false);
        }
        throw new SessionSwitchRecoveryRequiredError(marker.switchId);
    }

    private async movePending(
        envelope: SessionSwitchEnvelope,
        phase: PendingSwitchRecord['phase']
    ): Promise<SessionSwitchEnvelope> {
        const marker = requirePendingMarker(envelope);
        return this.replace(envelope, {
            ...envelope,
            marker: {
                ...marker,
                phase,
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
    }

    private async moveCleanup(
        envelope: SessionSwitchEnvelope,
        phase: CleanupPhase
    ): Promise<SessionSwitchEnvelope> {
        const marker = requireCleanupMarker(envelope);
        return this.replace(envelope, {
            ...envelope,
            marker: {
                ...marker,
                phase,
                leaseExpiresAtMs: this.leaseExpiry(),
                updatedAtMs: this.clock.now()
            }
        });
    }

    private async replace(
        current: SessionSwitchEnvelope,
        next: SessionSwitchEnvelope
    ): Promise<SessionSwitchEnvelope> {
        try {
            return await this.store.compareAndSwap(this.scope, current.revision, {
                ...next,
                revision: current.revision + 1
            });
        } catch (error) {
            if (error instanceof SessionStorageCorruptionError) {
                this.barrier.synchronize(CORRUPT_SESSION_STORAGE);
                throw error;
            }
            if (error instanceof ConcurrentSessionWriteError) {
                throw new SessionSwitchRecoveryRequiredError(current.marker?.switchId ?? 'session-envelope');
            }
            throw error;
        }
    }

    private timed<T>(operation: TimedOperation, promise: Promise<T>): Promise<T> {
        return Promise.race([
            promise,
            this.clock.sleep(this.timeoutFor(operation)).then(() => {
                throw new SessionSwitchTimeoutError(operation);
            })
        ]);
    }

    private timeoutFor(operation: TimedOperation): number {
        switch (operation) {
            case 'Prepare': return this.timeouts.prepareMs;
            case 'Commit': return this.timeouts.commitMs;
            case 'Status': return this.timeouts.statusMs;
            case 'Abort': return this.timeouts.abortMs;
            case 'Join': return this.timeouts.joinMs;
        }
    }

    private leaseExpiry(): number {
        return this.clock.now() + this.timeouts.leaseMs;
    }

    private async loadRequiredEnvelope(): Promise<SessionSwitchEnvelope> {
        let envelope: SessionSwitchEnvelope | null;
        try {
            envelope = await this.store.load(this.scope);
        } catch (error) {
            this.barrier.synchronize(CORRUPT_SESSION_STORAGE);
            throw error;
        }
        if (envelope === null) {
            throw new Error('Active session envelope is not initialized.');
        }
        this.barrier.synchronize(envelope);
        return envelope;
    }

    private clearInFlight(promise: Promise<ActiveProfileSession>): void {
        if (this.inFlight?.promise === promise) {
            this.inFlight = null;
        }
    }
}

function requireMarker(envelope: SessionSwitchEnvelope): SessionSwitchMarker {
    if (envelope.marker === null) {
        throw new Error('Session switch marker is required.');
    }
    return envelope.marker;
}

function requirePendingMarker(envelope: SessionSwitchEnvelope): PendingSwitchRecord {
    const marker = requireMarker(envelope);
    if (marker.kind !== 'PendingSwitch') {
        throw new Error('Pending session switch marker is required.');
    }
    return marker;
}

function requireCleanupMarker(envelope: SessionSwitchEnvelope): CommittedPendingCleanup {
    const marker = requireMarker(envelope);
    if (marker.kind !== 'CommittedPendingCleanup') {
        throw new Error('Committed cleanup marker is required.');
    }
    return marker;
}

function requireQuarantineMarker(envelope: SessionSwitchEnvelope): QuarantinedSession {
    const marker = requireMarker(envelope);
    if (marker.kind !== 'QuarantinedSession') {
        throw new Error('Quarantined session marker is required.');
    }
    return marker;
}

function createCompletionReceipt(
    marker: CommittedPendingCleanup,
    activeSession: ActiveProfileSession
): SessionSwitchCompletionReceipt {
    return Object.freeze({
        switchId: marker.switchId,
        serverId: activeSession.serverId,
        profileUserId: activeSession.profileUserId,
        sessionEpoch: activeSession.sessionEpoch
    });
}

function assertMatchingReplay(
    marker: SessionSwitchMarker,
    request: SessionSwitchRequest
): void {
    if (marker.switchId !== request.switchId
        || marker.targetProfileUserId !== request.targetProfileUserId) {
        throw new SwitchAlreadyInProgressError(marker.switchId);
    }
}

function assertServerResult(result: ServerSwitchResult, marker: SessionSwitchMarker | null): void {
    if (marker === null
        || result.switchId !== marker.switchId
        || result.targetProfileUserId !== marker.targetProfileUserId) {
        throw new SessionSwitchRecoveryRequiredError(marker?.switchId ?? result.switchId);
    }
}

function validateRequest(request: SessionSwitchRequest): void {
    if (!request.switchId || !request.targetProfileUserId) {
        throw new TypeError('switchId and targetProfileUserId are required.');
    }
}

function createEphemeralRequestIdentity(request: SessionSwitchRequest): string {
    return JSON.stringify([ request.targetProfileUserId, request.pin ?? null ]);
}
