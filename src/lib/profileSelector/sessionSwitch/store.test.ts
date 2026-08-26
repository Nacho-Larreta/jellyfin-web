import { describe, expect, it, vi } from 'vitest';

import { createActiveProfileSession, createOwnerRecoverySession } from './model';
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

        expect(() => new ServerConnectionsSessionSwitchStore(createPersistence(malformed)).load(scope))
            .toThrow('schema');
    });

    it('rejects a completion receipt that is not bound to the active server, profile and epoch', () => {
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

        expect(() => new ServerConnectionsSessionSwitchStore(createPersistence(malformed)).load(scope))
            .toThrow('terminal session');
    });
});
