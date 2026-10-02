import { describe, expect, it, vi } from 'vitest';

import { SessionAdmissionBarrier } from './barrier';
import { SessionSwitchInProgressError, createActiveProfileSession } from './model';
import { createSessionSwitchEnvelope } from './store';

const oldSession = createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 4);

describe('SessionAdmissionBarrier', () => {
    it('notifies after transitions and isolates a failing observer', () => {
        const barrier = new SessionAdmissionBarrier();
        const observed = vi.fn(() => barrier.isClosed());
        barrier.subscribe(() => {
            throw new Error('observer failure');
        });
        const unsubscribe = barrier.subscribe(observed);

        expect(() => barrier.close('switch-1')).not.toThrow();
        barrier.close('switch-1');
        expect(observed).toHaveBeenCalledTimes(1);

        barrier.reopen('switch-1');
        expect(observed).toHaveBeenCalledTimes(2);
        expect(observed.mock.results.map(result => result.value)).toEqual([ true, false ]);
        unsubscribe();
        barrier.synchronize(createSessionSwitchEnvelope(oldSession));
        expect(observed).toHaveBeenCalledTimes(2);
    });

    it('notifies terminal synchronization reopening before the later explicit reopen', () => {
        const barrier = new SessionAdmissionBarrier();
        const states: boolean[] = [];
        barrier.subscribe(() => states.push(barrier.isClosed()));
        barrier.close('switch-1');
        barrier.synchronize({ ...createSessionSwitchEnvelope(oldSession), marker: null });
        expect(barrier.admitCurrent('read').snapshot).toEqual(oldSession);
        barrier.reopen('switch-1');

        expect(states).toEqual([ true, false ]);
    });
    it('cancels admitted reads and rejects new work after closing admission', () => {
        const barrier = new SessionAdmissionBarrier();
        const read = barrier.admit(oldSession, 'read');

        barrier.close('switch-1');

        expect(read.signal.aborted).toBe(true);
        expect(() => barrier.admit(oldSession, 'read')).toThrow(SessionSwitchInProgressError);
    });

    it.each(['Acknowledged', 'Rejected', 'NotApplied'] as const)(
        'waits for old mutations to receive a classified %s settlement', async outcome => {
            const barrier = new SessionAdmissionBarrier();
            const mutation = barrier.admit(oldSession, 'mutation');
            barrier.close('switch-1');

            const drained = barrier.drainMutations();
            let finished = false;
            void drained.then(() => {
                finished = true;
            });
            await Promise.resolve();
            expect(finished).toBe(false);

            mutation.settle(outcome);
            await expect(drained).resolves.toBeUndefined();
        }
    );

    it('blocks commit when an old mutation has an unclassified outcome', async () => {
        const barrier = new SessionAdmissionBarrier();
        const mutation = barrier.admit(oldSession, 'mutation');
        barrier.close('switch-1');

        const drained = barrier.drainMutations();
        mutation.settle('Unknown');

        await expect(drained).rejects.toThrow('unclassified outcome');
    });

    it('rejects a drain started after a mutation settled with an unknown outcome', async () => {
        const barrier = new SessionAdmissionBarrier();
        const mutation = barrier.admit(oldSession, 'mutation');
        mutation.settle('Unknown');
        barrier.close('switch-1');

        await expect(barrier.drainMutations()).rejects.toThrow('unclassified outcome');
    });

    it('retains an unknown outcome across repeated drains and reopening admission', async () => {
        const barrier = new SessionAdmissionBarrier();
        const mutation = barrier.admit(oldSession, 'mutation');
        barrier.close('switch-1');
        mutation.settle('Unknown');

        await expect(barrier.drainMutations()).rejects.toThrow('unclassified outcome');
        barrier.reopen('switch-1');
        const newSession = createActiveProfileSession('server-1', 'device-1', 'new-user', 'new-token', 5);
        barrier.synchronize(createSessionSwitchEnvelope(newSession));
        barrier.close('switch-2');
        await expect(barrier.drainMutations()).rejects.toThrow('unclassified outcome');
    });

    it('rejects a mixed batch while allowing classified mutations to drain', async () => {
        const barrier = new SessionAdmissionBarrier();
        const acknowledged = barrier.admit(oldSession, 'mutation');
        const rejected = barrier.admit(oldSession, 'mutation');
        const notApplied = barrier.admit(oldSession, 'mutation');
        const unknown = barrier.admit(oldSession, 'mutation');
        barrier.close('switch-1');

        const drained = barrier.drainMutations();
        acknowledged.settle('Acknowledged');
        rejected.settle('Rejected');
        notApplied.settle('NotApplied');
        unknown.settle('Unknown');

        await expect(drained).rejects.toThrow('unclassified outcome');
        await expect(barrier.drainMutations()).rejects.toThrow('unclassified outcome');
    });

    it('does not let duplicate settlement turn an unknown outcome into success', async () => {
        const barrier = new SessionAdmissionBarrier();
        const mutation = barrier.admit(oldSession, 'mutation');
        mutation.settle('Unknown');
        mutation.settle('Acknowledged');

        await expect(barrier.drainMutations()).rejects.toThrow('unclassified outcome');
    });

    it('rejects late side effects captured under an old epoch', () => {
        const barrier = new SessionAdmissionBarrier();
        const newSession = createActiveProfileSession('server-1', 'device-1', 'new-user', 'new-token', 5);

        expect(() => barrier.assertCurrentEpoch(oldSession, newSession)).toThrow('stale epoch');
    });

    it('propagates a durable marker and epoch before admitting cross-tab work', () => {
        const barrier = new SessionAdmissionBarrier();
        const newSession = createActiveProfileSession('server-1', 'device-1', 'new-user', 'new-token', 5);
        barrier.synchronize({
            ...createSessionSwitchEnvelope(oldSession),
            revision: 1,
            marker: {
                kind: 'PendingSwitch',
                phase: 'Preparing',
                playbackReport: null,
                switchId: 'switch-1',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 4,
                targetProfileUserId: 'new-user',
                coordinatorId: 'other-tab',
                fencingToken: 1,
                leaseExpiresAtMs: 100,
                updatedAtMs: 1
            }
        });

        expect(() => barrier.admitCurrent('read')).toThrow(SessionSwitchInProgressError);

        barrier.synchronize({
            ...createSessionSwitchEnvelope(newSession),
            revision: 2
        });
        expect(barrier.admitCurrent('read').snapshot).toEqual(newSession);
    });

    it('cancels reads when another tab publishes a new terminal epoch', () => {
        const barrier = new SessionAdmissionBarrier();
        barrier.synchronize(createSessionSwitchEnvelope(oldSession));
        const oldRead = barrier.admitCurrent('read');
        const newSession = createActiveProfileSession('server-1', 'device-1', 'new-user', 'new-token', 5);

        barrier.synchronize({
            ...createSessionSwitchEnvelope(newSession),
            revision: 1
        });

        expect(oldRead.signal.aborted).toBe(true);
        expect(barrier.admitCurrent('read').snapshot).toEqual(newSession);
    });
});
