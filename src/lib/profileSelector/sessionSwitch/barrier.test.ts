import { describe, expect, it } from 'vitest';

import { SessionAdmissionBarrier } from './barrier';
import { SessionSwitchInProgressError, createActiveProfileSession } from './model';
import { createSessionSwitchEnvelope } from './store';

const oldSession = createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 4);

describe('SessionAdmissionBarrier', () => {
    it('cancels admitted reads and rejects new work after closing admission', () => {
        const barrier = new SessionAdmissionBarrier();
        const read = barrier.admit(oldSession, 'read');

        barrier.close('switch-1');

        expect(read.signal.aborted).toBe(true);
        expect(() => barrier.admit(oldSession, 'read')).toThrow(SessionSwitchInProgressError);
    });

    it('waits for old mutations to receive a classified settlement', async () => {
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

        mutation.settle('Acknowledged');
        await expect(drained).resolves.toBeUndefined();
    });

    it('blocks commit when an old mutation has an unclassified outcome', async () => {
        const barrier = new SessionAdmissionBarrier();
        const mutation = barrier.admit(oldSession, 'mutation');
        barrier.close('switch-1');

        const drained = barrier.drainMutations();
        mutation.settle('Unknown');

        await expect(drained).rejects.toThrow('unclassified outcome');
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
