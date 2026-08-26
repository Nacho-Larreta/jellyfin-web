import { describe, expect, it, vi } from 'vitest';

import { createActiveProfileSession, type CommittedPendingCleanup } from './model';
import { ServerConnectionsSessionRuntime } from './runtime';

const session = createActiveProfileSession('server-1', 'device-1', 'target-user', 'target-token', 8);
const marker: CommittedPendingCleanup = {
    kind: 'CommittedPendingCleanup',
    phase: 'Resetting',
    switchId: 'switch-1',
    serverId: 'server-1',
    deviceId: 'device-1',
    oldProfileUserId: 'old-user',
    oldEpoch: 7,
    targetProfileUserId: 'target-user',
    coordinatorId: 'coordinator-1',
    fencingToken: 1,
    leaseExpiresAtMs: 1_000,
    updatedAtMs: 10
};

function createConnections(userId = 'target-user') {
    return {
        installSessionAuthentication: vi.fn(),
        resetInstalledSession: vi.fn(),
        reconnectInstalledSession: vi.fn(),
        getInstalledSessionUser: vi.fn().mockResolvedValue({ Id: userId, ServerId: 'server-1' }),
        discardStagedSession: vi.fn(),
        clearInstalledSession: vi.fn(),
        publishSessionSwitchCompletion: vi.fn().mockResolvedValue(undefined)
    };
}

describe('ServerConnectionsSessionRuntime', () => {
    it('installs without persistence, resets, proves exact Users/Me identity and reconnects', async () => {
        const connections = createConnections();
        const runtime = new ServerConnectionsSessionRuntime(connections);

        await runtime.installActiveSession(session);
        await runtime.resetSessionState(marker, session);
        const verified = await runtime.reconnectAndVerify(session);

        expect(verified).toBe(true);
        expect(connections.installSessionAuthentication).toHaveBeenCalledWith(session);
        expect(connections.resetInstalledSession).toHaveBeenCalledWith('server-1');
        expect(connections.getInstalledSessionUser).toHaveBeenCalledWith('server-1');
        expect(connections.reconnectInstalledSession).toHaveBeenCalledWith('server-1');
    });

    it('quarantines a mismatched Users/Me identity without reconnecting or publishing', async () => {
        const connections = createConnections('other-user');
        const runtime = new ServerConnectionsSessionRuntime(connections);

        await runtime.installActiveSession(session);

        expect(await runtime.reconnectAndVerify(session)).toBe(false);
        expect(connections.reconnectInstalledSession).not.toHaveBeenCalled();
        await expect(runtime.publishCompleted({
            switchId: 'switch-1',
            serverId: 'server-1',
            profileUserId: 'target-user',
            sessionEpoch: 8
        })).rejects.toThrow('Verified session identity');
    });

    it('publishes completion only for the identity proven after reconnect', async () => {
        const connections = createConnections();
        const runtime = new ServerConnectionsSessionRuntime(connections);
        const receipt = {
            switchId: 'switch-1',
            serverId: 'server-1',
            profileUserId: 'target-user',
            sessionEpoch: 8
        } as const;

        await runtime.installActiveSession(session);
        expect(await runtime.reconnectAndVerify(session)).toBe(true);
        await runtime.publishCompleted(receipt);

        expect(connections.publishSessionSwitchCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ Id: 'target-user' }),
            receipt
        );
    });

    it('restores and verifies old identity, and clears an unsafe installed binding', async () => {
        const connections = createConnections();
        const runtime = new ServerConnectionsSessionRuntime(connections);

        expect(await runtime.restoreOldSession(session)).toBe(true);
        await runtime.clearActiveSession(session);

        expect(connections.installSessionAuthentication).toHaveBeenCalledWith(session);
        expect(connections.clearInstalledSession).toHaveBeenCalledWith('server-1');
    });

    it('rejects cleanup markers from another target or epoch before reset', async () => {
        const connections = createConnections();
        const runtime = new ServerConnectionsSessionRuntime(connections);

        await expect(runtime.resetSessionState({ ...marker, targetProfileUserId: 'other-user' }, session))
            .rejects.toThrow('cleanup marker');
        expect(connections.resetInstalledSession).not.toHaveBeenCalled();
    });
});
