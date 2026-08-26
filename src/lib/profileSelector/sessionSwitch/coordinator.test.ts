import { describe, expect, it, vi } from 'vitest';

import { type ProfileSwitchApiPort } from './api';
import { SessionAdmissionBarrier } from './barrier';
import {
    CommitUnknownError,
    ConcurrentSessionWriteError,
    DeterministicSwitchRejectionError,
    SessionSwitchRecoveryRequiredError,
    SessionSwitchTimeoutError,
    SwitchAlreadyInProgressError,
    createActiveProfileSession,
    createOwnerRecoverySession,
    type CleanupPhase,
    type CommittedPendingCleanup,
    type PendingSwitchRecord,
    type ServerSwitchResult,
    type SessionEnvelopeObservation,
    type SessionSwitchEnvelope
} from './model';
import {
    ProfileSessionSwitchCoordinator,
    type PlaybackQuiescePort,
    type SessionRuntimePort,
    type SessionSwitchClock,
    type SessionSwitchTimeoutPolicy
} from './coordinator';
import {
    cloneEnvelope,
    createSessionSwitchEnvelope,
    type AtomicSessionSwitchStore,
    type SessionScope
} from './store';

const scope = { serverId: 'server-1', deviceId: 'device-1' } as const;
const switchRequest = { switchId: 'switch-1', targetProfileUserId: 'target-user', pin: '0012' } as const;
const timeouts: SessionSwitchTimeoutPolicy = {
    prepareMs: 10,
    commitMs: 20,
    statusMs: 30,
    abortMs: 40,
    joinMs: 50,
    leaseMs: 1_000
};

class MemoryStore implements AtomicSessionSwitchStore {
    readonly writes: SessionSwitchEnvelope[] = [];
    failNextReplace: ((envelope: SessionSwitchEnvelope) => boolean) | null = null;
    private readonly listeners = new Set<(envelope: SessionEnvelopeObservation) => void>();

    constructor(public envelope: SessionSwitchEnvelope) {}

    load(requestedScope: SessionScope): Promise<SessionSwitchEnvelope | null> {
        expect(requestedScope).toEqual(scope);
        return Promise.resolve(cloneEnvelope(this.envelope));
    }

    compareAndSwap(
        requestedScope: SessionScope,
        expectedRevision: number,
        envelope: SessionSwitchEnvelope
    ): Promise<SessionSwitchEnvelope> {
        expect(requestedScope).toEqual(scope);
        if (this.envelope.revision !== expectedRevision) {
            return Promise.reject(new ConcurrentSessionWriteError(this.envelope.revision));
        }
        if (this.failNextReplace?.(envelope)) {
            this.failNextReplace = null;
            return Promise.reject(new Error('durable store failpoint'));
        }

        this.envelope = cloneEnvelope(envelope);
        this.writes.push(this.envelope);
        this.listeners.forEach(listener => {
            listener(cloneEnvelope(this.envelope));
        });
        return Promise.resolve(cloneEnvelope(this.envelope));
    }

    waitForChange(_requestedScope: SessionScope, revision: number): Promise<SessionSwitchEnvelope> {
        if (this.envelope.revision > revision) {
            return Promise.resolve(cloneEnvelope(this.envelope));
        }

        return new Promise(resolve => {
            const unsubscribe = this.subscribe(scope, envelope => {
                if (envelope !== null && !('kind' in envelope) && envelope.revision > revision) {
                    unsubscribe();
                    resolve(envelope);
                }
            });
        });
    }

    subscribe(
        _requestedScope: SessionScope,
        listener: (envelope: SessionEnvelopeObservation) => void
    ): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

class FakeClock implements SessionSwitchClock {
    private time = 100;
    private sleepers: Array<{ due: number; resolve: () => void }> = [];

    now(): number {
        return this.time;
    }

    sleep(milliseconds: number): Promise<void> {
        return new Promise(resolve => {
            this.sleepers.push({ due: this.time + milliseconds, resolve });
        });
    }

    advance(milliseconds: number): void {
        this.time += milliseconds;
        const ready = this.sleepers.filter(sleeper => sleeper.due <= this.time);
        this.sleepers = this.sleepers.filter(sleeper => sleeper.due > this.time);
        ready.forEach(sleeper => {
            sleeper.resolve();
        });
    }
}

class RecordingBarrier extends SessionAdmissionBarrier {
    constructor(private readonly events: string[]) {
        super();
    }

    override close(switchId: string): void {
        this.events.push('barrier:close');
        super.close(switchId);
    }

    override drainMutations(): Promise<void> {
        this.events.push('barrier:drain');
        return super.drainMutations();
    }

    override reopen(switchId: string): void {
        this.events.push('barrier:reopen');
        super.reopen(switchId);
    }
}

function createInitialEnvelope(): SessionSwitchEnvelope {
    return createSessionSwitchEnvelope(
        createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
        createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'recovery-token')
    );
}

function serverResult(state: ServerSwitchResult['state']): ServerSwitchResult {
    return {
        switchId: 'switch-1',
        targetProfileUserId: 'target-user',
        state,
        authentication: state === 'Committed' ?
            { accessToken: 'target-token', userId: 'target-user' } :
            null
    };
}

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createHarness(
    initialEnvelope = createInitialEnvelope(),
    sharedStore?: MemoryStore,
    coordinatorId = 'coordinator-a',
    clock = new FakeClock()
) {
    const events: string[] = [];
    const store = sharedStore ?? new MemoryStore(initialEnvelope);
    const api: ProfileSwitchApiPort = {
        prepare: vi.fn(async () => {
            events.push('api:prepare');
            return serverResult('Prepared');
        }),
        commit: vi.fn(async () => {
            events.push('api:commit');
            return serverResult('Committed');
        }),
        status: vi.fn(async () => {
            events.push('api:status');
            return serverResult('Committed');
        }),
        abort: vi.fn(async () => {
            events.push('api:abort');
            return serverResult('Aborted');
        })
    };
    const playback: PlaybackQuiescePort = {
        stopAndReport: vi.fn(async () => {
            events.push('playback:quiesce');
            return { outcome: 'Acknowledged' as const, reportKey: 'report-key' };
        })
    };
    const runtime: SessionRuntimePort = {
        installActiveSession: vi.fn(async session => {
            events.push(`runtime:install:${session.profileUserId}`);
        }),
        restoreOldSession: vi.fn(async session => {
            events.push(`runtime:restore:${session.profileUserId}`);
            return true;
        }),
        resetSessionState: vi.fn(async () => {
            events.push('runtime:reset');
        }),
        reconnectAndVerify: vi.fn(async session => {
            events.push(`runtime:reconnect:${session.profileUserId}`);
            return true;
        }),
        clearActiveSession: vi.fn(async session => {
            events.push(`runtime:clear:${session.profileUserId}`);
        }),
        publishCompleted: vi.fn(async receipt => {
            events.push(`runtime:complete:${receipt.sessionEpoch}`);
        })
    };
    const barrier = new RecordingBarrier(events);
    const coordinator = new ProfileSessionSwitchCoordinator(
        scope,
        {
            coordinatorId,
            api,
            store,
            barrier,
            playback,
            runtime,
            clock,
            timeouts
        }
    );

    return { api, barrier, clock, coordinator, events, playback, runtime, store };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (condition()) return;
        await Promise.resolve();
    }
    throw new Error('Expected async operation was not reached.');
}

describe('ProfileSessionSwitchCoordinator', () => {
    it('persists every phase before its side effect and installs exactly oldEpoch + 1', async () => {
        const harness = createHarness();

        const active = await harness.coordinator.switchProfile(switchRequest);

        expect(active).toEqual(expect.objectContaining({
            profileUserId: 'target-user',
            sessionEpoch: 8,
            credentialRef: { scope: 'active-profile', token: 'target-token' }
        }));
        expect(harness.events).toEqual([
            'barrier:close',
            'api:prepare',
            'playback:quiesce',
            'barrier:drain',
            'api:commit',
            'runtime:install:target-user',
            'runtime:reset',
            'runtime:reconnect:target-user',
            'runtime:complete:8',
            'barrier:reopen'
        ]);
        expect(harness.store.writes.map(write => write.marker?.phase ?? 'Idle')).toEqual([
            'Preparing', 'Quiescing', 'Committing', 'Installing', 'Resetting',
            'Reconnecting', 'Completing', 'Idle'
        ]);
        expect(harness.store.envelope.lastCompletion).toEqual({
            switchId: 'switch-1',
            serverId: 'server-1',
            profileUserId: 'target-user',
            sessionEpoch: 8
        });
        expect(harness.store.envelope.recoverySession?.credentialRef.token).toBe('recovery-token');
    });

    it.each([[ '0012', '9999' ], [ '9999', '0012' ]] as const)(
        'joins the same in-memory payload and rejects PIN mismatch %s -> %s',
        async (firstPin, secondPin) => {
            const harness = createHarness();
            const prepare = deferred<ServerSwitchResult>();
            vi.mocked(harness.api.prepare).mockReturnValueOnce(prepare.promise);
            const firstRequest = { ...switchRequest, pin: firstPin };

            const first = harness.coordinator.switchProfile(firstRequest);
            const joined = harness.coordinator.switchProfile(firstRequest);
            const mismatched = harness.coordinator.switchProfile({ ...switchRequest, pin: secondPin });

            expect(joined).toBe(first);
            await expect(mismatched).rejects.toBeInstanceOf(SwitchAlreadyInProgressError);
            prepare.resolve(serverResult('Prepared'));
            await expect(first).resolves.toEqual(expect.objectContaining({ profileUserId: 'target-user' }));
        }
    );

    it('uses server-owned switch state for cross-tab replay without persisting PIN-derived material', async () => {
        for (const [ firstPin, secondPin ] of [[ '0012', '9999' ], [ '9999', '0012' ]] as const) {
            const store = new MemoryStore(createInitialEnvelope());
            const first = createHarness(store.envelope, store, 'coordinator-a');
            const prepare = deferred<ServerSwitchResult>();
            vi.mocked(first.api.prepare).mockReturnValueOnce(prepare.promise);
            const firstPromise = first.coordinator.switchProfile({ ...switchRequest, pin: firstPin });
            await flush();

            const second = createHarness(store.envelope, store, 'coordinator-b');
            const joined = second.coordinator.switchProfile({ ...switchRequest, pin: secondPin });
            const serialized = JSON.stringify(store.envelope);
            expect(serialized).not.toContain(firstPin);
            expect(serialized).not.toContain(secondPin);
            expect(serialized).not.toContain('requestFingerprint');

            prepare.resolve(serverResult('Prepared'));
            await firstPromise;
            await joined;
            first.coordinator.dispose();
            second.coordinator.dispose();
        }
    });

    it('joins the same switch across coordinators and rejects a different cross-tab switch', async () => {
        const store = new MemoryStore(createInitialEnvelope());
        const first = createHarness(store.envelope, store, 'coordinator-a');
        const prepare = deferred<ServerSwitchResult>();
        vi.mocked(first.api.prepare).mockReturnValueOnce(prepare.promise);
        const firstPromise = first.coordinator.switchProfile(switchRequest);
        await flush();

        const conflicting = createHarness(store.envelope, store, 'coordinator-conflict');
        await expect(conflicting.coordinator.switchProfile({ switchId: 'switch-2', targetProfileUserId: 'other-user' }))
            .rejects.toBeInstanceOf(SwitchAlreadyInProgressError);
        const second = createHarness(store.envelope, store, 'coordinator-b');
        const joined = second.coordinator.switchProfile(switchRequest);

        prepare.resolve(serverResult('Prepared'));
        await expect(firstPromise).resolves.toEqual(expect.objectContaining({ sessionEpoch: 8 }));
        await expect(joined).resolves.toEqual(expect.objectContaining({ sessionEpoch: 8 }));
        expect(second.api.prepare).not.toHaveBeenCalled();
    });

    it('fences a stale writer with the shared envelope revision', async () => {
        const store = new MemoryStore(createInitialEnvelope());
        const stale = cloneEnvelope(store.envelope);
        await store.compareAndSwap(scope, 0, { ...stale, revision: 1 });

        await expect(store.compareAndSwap(scope, 0, { ...stale, revision: 1 }))
            .rejects.toEqual(expect.objectContaining({ name: 'ConcurrentSessionWriteError', actualRevision: 1 }));
    });

    it('replays a completed opaque server switch without retaining the PIN', async () => {
        const harness = createHarness();
        const first = await harness.coordinator.switchProfile(switchRequest);

        const replay = await harness.coordinator.switchProfile(switchRequest);
        const replayWithForgottenPin = await harness.coordinator.switchProfile({ ...switchRequest, pin: '9999' });

        expect(replay.sessionEpoch).toBe(first.sessionEpoch);
        expect(replayWithForgottenPin.sessionEpoch).toBe(first.sessionEpoch);
        expect(harness.api.prepare).toHaveBeenCalledTimes(1);
    });

    it('persists CommitUnknown and resolves Status before installing either identity', async () => {
        const harness = createHarness();
        vi.mocked(harness.api.commit).mockRejectedValueOnce(new CommitUnknownError());

        const active = await harness.coordinator.switchProfile(switchRequest);

        expect(active.profileUserId).toBe('target-user');
        expect(harness.store.writes.map(write => write.marker?.phase)).toContain('CommitUnknown');
        expect(harness.store.writes.map(write => write.marker?.phase)).toContain('ResolvingCommit');
        expect(harness.events.indexOf('api:status')).toBeLessThan(harness.events.indexOf('runtime:install:target-user'));
    });

    it('never exposes owner recovery authority to active API, playback or runtime ports', async () => {
        const harness = createHarness();

        await harness.coordinator.switchProfile(switchRequest);

        const activePortCalls = JSON.stringify({
            prepare: vi.mocked(harness.api.prepare).mock.calls,
            playback: vi.mocked(harness.playback.stopAndReport).mock.calls,
            install: vi.mocked(harness.runtime.installActiveSession).mock.calls,
            restore: vi.mocked(harness.runtime.restoreOldSession).mock.calls,
            reset: vi.mocked(harness.runtime.resetSessionState).mock.calls,
            reconnect: vi.mocked(harness.runtime.reconnectAndVerify).mock.calls,
            clear: vi.mocked(harness.runtime.clearActiveSession).mock.calls,
            complete: vi.mocked(harness.runtime.publishCompleted).mock.calls
        });
        expect(activePortCalls).not.toContain('recovery-token');
    });

    it('treats a Commit timeout as CommitUnknown and resolves server truth', async () => {
        const harness = createHarness();
        vi.mocked(harness.api.commit).mockReturnValueOnce(new Promise(() => undefined));

        const switched = harness.coordinator.switchProfile(switchRequest);
        await waitUntil(() => vi.mocked(harness.api.commit).mock.calls.length === 1);
        harness.clock.advance(timeouts.commitMs);

        await expect(switched).resolves.toEqual(expect.objectContaining({ profileUserId: 'target-user' }));
        expect(harness.store.writes.map(write => write.marker?.phase)).toContain('CommitUnknown');
        expect(harness.api.status).toHaveBeenCalledWith('switch-1');
    });

    it('restores after a Prepare timeout only after Abort and identity verification', async () => {
        const harness = createHarness();
        vi.mocked(harness.api.prepare).mockReturnValueOnce(new Promise(() => undefined));

        const switched = harness.coordinator.switchProfile(switchRequest);
        await waitUntil(() => vi.mocked(harness.api.prepare).mock.calls.length === 1);
        harness.clock.advance(timeouts.prepareMs);

        await expect(switched).rejects.toBeInstanceOf(SessionSwitchTimeoutError);
        expect(harness.api.abort).toHaveBeenCalledWith('switch-1');
        expect(harness.runtime.restoreOldSession).toHaveBeenCalled();
        expect(harness.store.envelope.marker).toBeNull();
    });

    it('keeps recovery closed when Status times out', async () => {
        const harness = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker('CommitUnknown') });
        vi.mocked(harness.api.status).mockReturnValueOnce(new Promise(() => undefined));

        const recovery = harness.coordinator.recover();
        await waitUntil(() => vi.mocked(harness.api.status).mock.calls.length === 1);
        harness.clock.advance(timeouts.statusMs);

        await expect(recovery).rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
        expect(harness.store.envelope.marker).toEqual(expect.objectContaining({ phase: 'ResolvingCommit' }));
        expect(harness.barrier.isClosed()).toBe(true);
    });

    it('keeps recovery closed when Abort times out or loses the network', async () => {
        for (const failure of [ 'timeout', 'network' ] as const) {
            const harness = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker('Preparing') });
            if (failure === 'timeout') {
                vi.mocked(harness.api.abort).mockReturnValueOnce(new Promise(() => undefined));
            } else {
                vi.mocked(harness.api.abort).mockRejectedValueOnce(new TypeError('network'));
            }

            const recovery = harness.coordinator.recover();
            await flush();
            if (failure === 'timeout') harness.clock.advance(timeouts.abortMs);

            await expect(recovery).rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
            expect(harness.store.envelope.marker).toEqual(expect.objectContaining({ phase: 'Preparing' }));
            expect(harness.barrier.isClosed()).toBe(true);
        }
    });

    it.each([ 'direct committed result', 'abort conflict then status' ] as const)(
        'installs the committed target when Abort reports %s',
        async mode => {
            const harness = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker('Preparing') });
            if (mode === 'direct committed result') {
                vi.mocked(harness.api.abort).mockResolvedValueOnce(serverResult('Committed'));
            } else {
                vi.mocked(harness.api.abort).mockRejectedValueOnce(new DeterministicSwitchRejectionError(409));
            }

            await expect(harness.coordinator.recover()).resolves.toEqual(expect.objectContaining({
                profileUserId: 'target-user',
                sessionEpoch: 8
            }));
            if (mode === 'abort conflict then status') {
                expect(harness.api.status).toHaveBeenCalledWith('switch-1');
            }
        }
    );

    it('does not clear the old marker when identity restoration fails, and resumes after restart', async () => {
        const first = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker('Preparing') });
        vi.mocked(first.runtime.restoreOldSession).mockRejectedValueOnce(new Error('restore failure'));

        await expect(first.coordinator.recover()).rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
        expect(first.store.envelope.marker).toEqual(expect.objectContaining({ phase: 'Preparing' }));
        expect(first.barrier.isClosed()).toBe(true);

        const restarted = createHarness(first.store.envelope);
        await expect(restarted.coordinator.recover()).resolves.toEqual(expect.objectContaining({ profileUserId: 'old-user' }));
        expect(restarted.store.envelope.marker).toBeNull();
    });

    it('quarantines a Users/Me identity mismatch, clears runtime binding, and does not loop after restart', async () => {
        const first = createHarness();
        vi.mocked(first.runtime.reconnectAndVerify).mockResolvedValueOnce(false);

        await expect(first.coordinator.switchProfile(switchRequest))
            .rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
        expect(first.runtime.clearActiveSession).toHaveBeenCalledWith(expect.objectContaining({ profileUserId: 'target-user' }));
        expect(first.store.envelope.marker).toEqual(expect.objectContaining({
            kind: 'QuarantinedSession',
            phase: 'Quarantined'
        }));
        expect(first.barrier.isClosed()).toBe(true);

        const restarted = createHarness(first.store.envelope);
        await expect(restarted.coordinator.recover()).rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
        expect(restarted.runtime.reconnectAndVerify).not.toHaveBeenCalled();
        expect(restarted.runtime.clearActiveSession).not.toHaveBeenCalled();
    });

    it.each([ 'Preparing', 'Quiescing' ] as const)(
        'aborts and restores the verified old identity after restart from %s',
        async phase => {
            const harness = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker(phase) });

            const active = await harness.coordinator.recover();

            expect(active.profileUserId).toBe('old-user');
            expect(harness.api.abort).toHaveBeenCalledWith('switch-1');
            expect(harness.store.envelope.marker).toBeNull();
        }
    );

    it.each([ 'Committing', 'CommitUnknown', 'ResolvingCommit' ] as const)(
        'resolves server truth after restart from %s',
        async phase => {
            const harness = createHarness({ ...createInitialEnvelope(), revision: 1, marker: pendingMarker(phase) });

            const active = await harness.coordinator.recover();

            expect(active.profileUserId).toBe('target-user');
            expect(active.sessionEpoch).toBe(8);
            expect(harness.api.status).toHaveBeenCalledWith('switch-1');
            expect(harness.store.envelope.marker).toBeNull();
        }
    );

    it.each([
        [ 'Installing', [ 'installActiveSession', 'resetSessionState', 'reconnectAndVerify', 'publishCompleted' ] ],
        [ 'Resetting', [ 'resetSessionState', 'reconnectAndVerify', 'publishCompleted' ] ],
        [ 'Reconnecting', [ 'reconnectAndVerify', 'publishCompleted' ] ],
        [ 'Completing', [ 'publishCompleted' ] ]
    ] as const)('resumes only remaining cleanup after restart from %s', async (phase, expectedCalls) => {
        const harness = createHarness(committedEnvelope(phase));

        const active = await harness.coordinator.recover();

        expect(active.sessionEpoch).toBe(8);
        const actualCalls = ([
            'installActiveSession',
            'resetSessionState',
            'reconnectAndVerify',
            'publishCompleted'
        ] as const).filter(name => vi.mocked(harness.runtime[name]).mock.calls.length > 0);
        expect(actualCalls).toEqual(expectedCalls);
        expect(harness.store.envelope.marker).toBeNull();
    });

    it('recovers the same committed result after the atomic install write fails', async () => {
        const first = createHarness();
        first.store.failNextReplace = envelope => envelope.marker?.phase === 'Installing';

        await expect(first.coordinator.switchProfile(switchRequest)).rejects.toThrow('durable store failpoint');
        expect(first.store.envelope.marker).toEqual(expect.objectContaining({ phase: 'Committing' }));
        expect(first.runtime.installActiveSession).not.toHaveBeenCalled();

        const restarted = createHarness(first.store.envelope);
        await expect(restarted.coordinator.recover()).resolves.toEqual(expect.objectContaining({
            profileUserId: 'target-user',
            sessionEpoch: 8
        }));
    });
});

function pendingMarker(phase: PendingSwitchRecord['phase']): PendingSwitchRecord {
    return {
        kind: 'PendingSwitch',
        phase,
        switchId: 'switch-1',
        serverId: 'server-1',
        deviceId: 'device-1',
        oldProfileUserId: 'old-user',
        oldEpoch: 7,
        targetProfileUserId: 'target-user',
        coordinatorId: 'coordinator-a',
        fencingToken: 1,
        leaseExpiresAtMs: 1_100,
        updatedAtMs: 90
    };
}

function committedEnvelope(phase: CleanupPhase): SessionSwitchEnvelope {
    const active = createActiveProfileSession('server-1', 'device-1', 'target-user', 'target-token', 8);
    const marker: CommittedPendingCleanup = {
        ...pendingMarker('Committing'),
        kind: 'CommittedPendingCleanup',
        phase
    };
    return {
        ...createInitialEnvelope(),
        revision: 1,
        activeSession: active,
        marker
    };
}
