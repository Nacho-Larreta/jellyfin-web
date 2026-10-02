import { beforeEach, describe, expect, it, vi } from 'vitest';

import Events from 'utils/events.ts';

const state = vi.hoisted(() => ({
    clients: [],
    current: null,
    owners: new Map(),
    preference: null,
    readGate: null,
    restoreRevision: 0,
    restoreAllowed: true,
    player: null,
    playerInfo: null,
    writeGate: null,
    ownerUnavailable: false,
    targets: null,
    calls: { getTargets: vi.fn(), tryRestoreActivePlayer: vi.fn() }
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClients: () => state.clients,
        currentApiClient: () => state.current
    }
}));
vi.mock('components/playback/playbackmanager', () => ({
    playbackManager: {
        getTargets: (...args) => state.calls.getTargets(...args),
        getCastSelectionRevision: () => state.restoreRevision,
        canRestoreOwnedCast: (activation, revision) => activation?.current() && state.restoreAllowed && revision === state.restoreRevision,
        tryRestoreActivePlayer: (...args) => state.calls.tryRestoreActivePlayer(...args),
        getCurrentPlayer: () => state.player,
        getPlayerInfo: () => state.playerInfo
    }
}));
vi.mock('components/playback/castActivationAuthority', () => ({
    createCastActivationOwner: client => {
        if (state.ownerUnavailable) return null;
        return client ? state.owners.get(client) ?? null : owner();
    },
    readAutocastPreference: async activation => {
        if (state.readGate) await state.readGate;
        return activation?.current() ? { status: 'read', value: state.preference } : { status: 'inactive' };
    },
    writeAutocastPreference: vi.fn(async (_activation, playerId) => {
        if (state.writeGate) await state.writeGate;
        const token = { generation: 1 };
        state.preference = { playerId, token };
        return { status: 'written', token };
    }),
    clearAutocastPreference: vi.fn(async (activation, token) => {
        if (!activation?.current() || token && state.preference?.token !== token) return false;
        state.preference = null;
        return true;
    })
}));

import { ServerConnections } from 'lib/jellyfin-apiclient';
import { enable, initialize, isEnabled } from './autocast';

function owner() {
    let active = true;
    return {
        current: () => active,
        retire: () => { active = false; }
    };
}

describe('automatic Cast reconnect admission', () => {
    beforeEach(() => {
        state.clients = [{ name: 'A' }, { name: 'other-server' }];
        state.current = state.clients[0];
        state.owners = new Map([[state.clients[0], owner()]]);
        state.preference = { playerId: 'Google Cast' };
        state.readGate = null;
        state.restoreRevision = 0;
        state.restoreAllowed = true;
        state.player = null;
        state.playerInfo = null;
        state.writeGate = null;
        state.ownerUnavailable = false;
        state.calls.getTargets.mockReset();
        state.calls.tryRestoreActivePlayer.mockReset();
        state.calls.getTargets.mockResolvedValue([{ id: 'Google Cast', playerName: 'Google Cast' }]);
    });

    it('only admits the current socket and passes its owner to pairing', async () => {
        initialize();
        Events.trigger(state.clients[1], 'websocketopen');
        expect(state.calls.getTargets).not.toHaveBeenCalled();
        Events.trigger(state.clients[0], 'websocketopen');
        await vi.waitFor(() => expect(state.calls.getTargets).toHaveBeenCalledOnce());
        expect(state.calls.getTargets).toHaveBeenCalledOnce();
        expect(state.calls.tryRestoreActivePlayer).toHaveBeenCalledWith(
            'Google Cast', expect.objectContaining({ id: 'Google Cast' }), state.owners.get(state.clients[0]), 0);
    });

    it('discards targets resolved after logout and does not infer a legacy preference', async () => {
        let releaseTargets;
        state.calls.getTargets.mockImplementation(() => new Promise(resolve => {
            releaseTargets = resolve;
        }));
        initialize();
        Events.trigger(state.clients[0], 'websocketopen');
        await vi.waitFor(() => expect(state.calls.getTargets).toHaveBeenCalledOnce());
        state.owners.get(state.clients[0]).retire();
        state.current = null;
        releaseTargets([{ id: 'Google Cast', playerName: 'Google Cast' }]);
        await Promise.resolve();
        expect(state.calls.tryRestoreActivePlayer).not.toHaveBeenCalled();
        state.preference = null;
        state.current = state.clients[0];
        Events.trigger(state.clients[0], 'websocketopen');
        expect(state.calls.getTargets).toHaveBeenCalledOnce();
        expect(ServerConnections.currentApiClient()).toBe(state.clients[0]);
    });

    it('leaves pairing inactive when enumeration fails', async () => {
        state.calls.getTargets.mockRejectedValueOnce(new Error('discovery unavailable'));
        initialize();
        const activation = state.owners.get(state.clients[0]);
        Events.trigger(state.clients[0], 'websocketopen');
        await vi.waitFor(() => expect(activation.current()).toBe(false));
        expect(activation.current()).toBe(false);
        expect(state.calls.tryRestoreActivePlayer).not.toHaveBeenCalled();
    });

    it('does not restore after local selection before the socket event', async () => {
        state.restoreAllowed = false;
        initialize();
        Events.trigger(state.clients[0], 'websocketopen');
        await Promise.resolve();
        expect(state.calls.getTargets).not.toHaveBeenCalled();
        expect(state.calls.tryRestoreActivePlayer).not.toHaveBeenCalled();
    });

    it('does not restore when local selection wins during preference or target lookup', async () => {
        let releaseRead;
        state.readGate = new Promise(resolve => {
            releaseRead = resolve;
        });
        initialize();
        Events.trigger(state.clients[0], 'websocketopen');
        state.restoreRevision++;
        releaseRead();
        await Promise.resolve();
        expect(state.calls.getTargets).not.toHaveBeenCalled();

        state.readGate = null;
        state.owners.set(state.clients[0], owner());
        let releaseTargets;
        state.calls.getTargets.mockImplementationOnce(() => new Promise(resolve => {
            releaseTargets = resolve;
        }));
        Events.trigger(state.clients[0], 'websocketopen');
        await vi.waitFor(() => expect(releaseTargets).toBeTypeOf('function'));
        state.restoreRevision++;
        releaseTargets([{ id: 'Google Cast', playerName: 'Google Cast' }]);
        await Promise.resolve();
        expect(state.calls.tryRestoreActivePlayer).not.toHaveBeenCalled();
    });

    it('clears only its completed enable when the selected player changes during persistence', async () => {
        const activation = state.owners.get(state.current);
        state.player = { getConnectionOwner: () => activation };
        state.playerInfo = { id: 'Google Cast' };
        let releaseWrite;
        state.writeGate = new Promise(resolve => {
            releaseWrite = resolve;
        });
        const saved = enable(true);
        state.player = null;
        state.playerInfo = null;
        releaseWrite();
        expect(await saved).toBe(false);
        expect(state.preference).toBeNull();
    });

    it('reports preference failure as unknown instead of claiming disabled and preserves explicit disable', async () => {
        state.playerInfo = { id: 'Google Cast' };
        expect(await isEnabled()).toBe(true);
        expect(await enable(false)).toBe(true);
        expect(state.preference).toBeNull();
        state.ownerUnavailable = true;
        expect(await isEnabled()).toBeNull();
    });
});
