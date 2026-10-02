import { describe, expect, it, vi } from 'vitest';

import {
    ConcurrentSessionWriteError,
    SessionSwitchRecoveryRequiredError,
    createActiveProfileSession,
    createOwnerRecoverySession
} from './model';
import {
    ServerConnectionsSessionSwitchStore,
    createSessionSwitchEnvelope
} from './store';

const scope = { serverId: 'server-1', deviceId: 'device-1' };

function createPersistence(stored: unknown = null) {
    const listeners = new Set<(value: unknown) => void>();
    return {
        getSessionSwitchEnvelope: vi.fn().mockReturnValue(stored),
        replaceSessionSwitchEnvelope: vi.fn().mockResolvedValue(undefined),
        subscribeSessionSwitchEnvelope: vi.fn((_serverId, nextListener) => {
            listeners.add(nextListener);
            return () => listeners.delete(nextListener);
        }),
        emit(value: unknown) {
            listeners.forEach(listener => {
                listener(value);
            });
        }
    };
}

describe('ServerConnectionsSessionSwitchStore', () => {
    it('migrates a resolved v1 envelope through CAS before returning it', async () => {
        const old = { ...createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2)
        ), version: 1 };
        const persistence = createPersistence(old);
        const migrated = await new ServerConnectionsSessionSwitchStore(persistence).load(scope);

        expect(migrated).toMatchObject({ version: 2, revision: 1, marker: null });
        expect(persistence.replaceSessionSwitchEnvelope).toHaveBeenCalledWith('server-1', 0, migrated);
    });

    it('fails closed for a legacy pending switch that might have stopped playback', async () => {
        const old = { ...createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2)
        ), version: 1, marker: {
            kind: 'PendingSwitch', phase: 'Quiescing', switchId: 'switch-1', serverId: 'server-1',
            deviceId: 'device-1', oldProfileUserId: 'profile-1', oldEpoch: 2,
            targetProfileUserId: 'profile-2', coordinatorId: 'old-coordinator',
            fencingToken: 1, leaseExpiresAtMs: 10, updatedAtMs: 0
        } };
        const persistence = createPersistence(old);

        await expect(new ServerConnectionsSessionSwitchStore(persistence).load(scope))
            .rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);
        expect(persistence.replaceSessionSwitchEnvelope).not.toHaveBeenCalled();
    });

    it('migrates a legacy Preparing marker with no possible playback stop for safe abort recovery', async () => {
        const old = { ...createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2)
        ), version: 1, marker: {
            kind: 'PendingSwitch', phase: 'Preparing', switchId: 'switch-1', serverId: 'server-1',
            deviceId: 'device-1', oldProfileUserId: 'profile-1', oldEpoch: 2,
            targetProfileUserId: 'profile-2', coordinatorId: 'old-coordinator',
            fencingToken: 1, leaseExpiresAtMs: 10, updatedAtMs: 0
        } };
        const persistence = createPersistence(old);

        await expect(new ServerConnectionsSessionSwitchStore(persistence).load(scope))
            .resolves.toMatchObject({ version: 2, revision: 1,
                marker: { phase: 'Preparing', playbackReport: null } });
    });

    it('reloads the winning v2 envelope when another tab wins migration', async () => {
        const initial = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2)
        );
        const persistence = createPersistence({ ...initial, version: 1 });
        persistence.replaceSessionSwitchEnvelope.mockImplementationOnce(async () => {
            persistence.getSessionSwitchEnvelope.mockReturnValue({ ...initial, revision: 1 });
            throw new ConcurrentSessionWriteError(1);
        });

        await expect(new ServerConnectionsSessionSwitchStore(persistence).load(scope))
            .resolves.toMatchObject({ version: 2, revision: 1 });
    });
    it('replaces the complete envelope with the expected CAS revision in one persistence call', async () => {
        const active = createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2);
        const recovery = createOwnerRecoverySession('server-1', 'device-1', 'owner-1', 'recovery-token');
        const initial = createSessionSwitchEnvelope(active, recovery);
        const next = { ...initial, revision: 1 };
        const persistence = createPersistence(initial);

        await new ServerConnectionsSessionSwitchStore(persistence).compareAndSwap(scope, 0, next);

        expect(persistence.replaceSessionSwitchEnvelope).toHaveBeenCalledTimes(1);
        expect(persistence.replaceSessionSwitchEnvelope).toHaveBeenCalledWith('server-1', 0, next);
    });

    it('returns a defensive validated clone so callers cannot mutate persisted credentials', async () => {
        const active = createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2);
        const persisted = createSessionSwitchEnvelope(active);
        const persistence = createPersistence(persisted);

        const loaded = await new ServerConnectionsSessionSwitchStore(persistence).load(scope);

        expect(loaded).toEqual(persisted);
        expect(loaded).not.toBe(persisted);
        expect(loaded?.activeSession).not.toBe(persisted.activeSession);
    });

    it('rejects cross-device and non-monotonic envelopes before touching persistence', async () => {
        const active = createActiveProfileSession('server-1', 'another-device', 'profile-1', 'active-token', 2);
        const persistence = createPersistence();
        const store = new ServerConnectionsSessionSwitchStore(persistence);

        expect(() => store.compareAndSwap(scope, 0, {
            ...createSessionSwitchEnvelope(active),
            revision: 1
        })).toThrow('not bound');
        expect(persistence.replaceSessionSwitchEnvelope).not.toHaveBeenCalled();
    });

    it('propagates a durable cross-tab epoch change to subscribers and waiters', async () => {
        const active = createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2);
        const initial = createSessionSwitchEnvelope(active);
        const next = {
            ...initial,
            revision: 1,
            activeSession: createActiveProfileSession('server-1', 'device-1', 'profile-2', 'new-token', 3)
        };
        const persistence = createPersistence(initial);
        const store = new ServerConnectionsSessionSwitchStore(persistence);
        const observed = vi.fn();
        store.subscribe(scope, observed);
        const changed = store.waitForChange(scope, 0);

        persistence.getSessionSwitchEnvelope.mockReturnValue(next);
        persistence.emit(next);

        await expect(changed).resolves.toEqual(next);
        expect(observed).toHaveBeenCalledWith(next);
    });

    it('rejects extra or prohibited fields when loading persisted state', async () => {
        const active = createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2);
        const malformed = {
            ...createSessionSwitchEnvelope(active),
            pin: '0012'
        };

        await expect(new ServerConnectionsSessionSwitchStore(createPersistence(malformed)).load(scope))
            .rejects.toThrow('schema');
    });

    it('rejects a completion receipt that is not bound to the active server, profile and epoch', async () => {
        const active = createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2);
        const malformed = {
            ...createSessionSwitchEnvelope(active),
            lastCompletion: {
                switchId: 'switch-1',
                serverId: 'server-1',
                profileUserId: 'another-profile',
                sessionEpoch: 2
            }
        };

        await expect(new ServerConnectionsSessionSwitchStore(createPersistence(malformed)).load(scope))
            .rejects.toThrow('terminal session');
    });

    it('rejects a v2 captured report with prohibited or corrupt fields', async () => {
        const initial = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'profile-1', 'active-token', 2)
        );
        const marker = {
            kind: 'PendingSwitch', phase: 'Quiescing', switchId: 'switch-1', serverId: 'server-1',
            deviceId: 'device-1', oldProfileUserId: 'profile-1', oldEpoch: 2,
            targetProfileUserId: 'profile-2', coordinatorId: 'coordinator-1',
            fencingToken: 1, leaseExpiresAtMs: 10, updatedAtMs: 0,
            playbackReport: {
                version: 1, status: 'Captured', itemId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
                playSessionId: 'play-old', positionTicks: 250, reportKey: 'a'.repeat(64),
                endpointUrl: 'http://local.test/old-api/report', serverAddress: 'http://local.test/old-api',
                appName: 'Jellyfin Web', appVersion: '1', deviceName: 'Browser', token: 'prohibited'
            }
        };
        const persistence = createPersistence({ ...initial, marker });

        await expect(new ServerConnectionsSessionSwitchStore(persistence).load(scope))
            .rejects.toThrow('schema');
    });
});
