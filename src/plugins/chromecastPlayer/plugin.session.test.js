import { beforeEach, describe, expect, it, vi } from 'vitest';

import Events from '../../utils/events.ts';

const state = vi.hoisted(() => ({
    client: null,
    owner: null,
    receipt: null,
    generation: 0,
    currentToken: null,
    reserveResult: null,
    checkGate: null,
    confirmGate: null,
    claimGate: null,
    localChoiceGate: null,
    sdk: null,
    loadPromise: null,
    getItems: vi.fn(),
    plugins: []
}));

vi.mock('../../components/pluginManager', () => ({
    pluginManager: {
        ofType: type => type === 'mediaplayer' ? state.plugins : []
    }
}));
vi.mock('../../components/apphost', () => ({ appHost: { supports: () => false } }));
vi.mock('../../components/alert', () => ({ default: vi.fn() }));
vi.mock('./castSenderApi', () => ({ default: class {
    load() {
        return state.loadPromise ?? Promise.resolve();
    }
} }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        get currentUserId() {
            return state.client?.userId;
        },
        currentApiClient: () => state.client,
        getApiClient: () => state.client
    }
}));
vi.mock('components/playback/castActivationAuthority', () => ({
    createCastActivationOwner: () => state.owner,
    reserveCastConnectionReceipt: async () => {
        if (state.reserveResult) return state.reserveResult;
        const token = ++state.generation;
        state.currentToken = token;
        return { status: 'reserved', token };
    },
    checkCastConnectionReceipt: async (_activation, token) => {
        if (state.checkGate) await state.checkGate();
        return { status: state.currentToken === token ? 'current' : 'superseded' };
    },
    readRestoredCastReceipt: async (activation, receiverSession) => {
        if (state.claimGate) await state.claimGate();
        if (!activation.current() || state.receipt?.session !== receiverSession) return { status: 'missing' };
        const token = ++state.generation;
        state.currentToken = token;
        state.receipt.token = token;
        return { status: 'claimed', token, receipt: state.receipt };
    },
    writeCastConnectionReceipt: async (activation, playerId, receiverSession, token) => {
        if (state.confirmGate) await state.confirmGate();
        if (!activation.current() || state.currentToken !== token) return { status: 'superseded' };
        state.receipt = { owner: activation, playerId, session: receiverSession, token };
        return { status: 'confirmed' };
    },
    clearCastConnectionReceipt: async (activation, _receiverSession, token) => {
        if (state.currentToken === token) {
            state.currentToken = null;
            if (state.receipt?.owner === activation && state.receipt.token === token) state.receipt = null;
        }
        return { status: 'revoked' };
    },
    revokeCastConnectionForLocalChoice: async (activation, playerId, isCurrent) => {
        if (state.localChoiceGate) await state.localChoiceGate();
        if (isCurrent() && state.receipt?.owner === activation && state.receipt.playerId === playerId) {
            state.receipt = null;
            state.currentToken = null;
        }
        return { status: 'revoked' };
    }
}));
vi.mock('apps/stable/features/playback/utils/mediaSegmentManager', () => ({ bindMediaSegmentManager: () => undefined }));
vi.mock('../../utils/jellyfin-apiclient/getItems.ts', () => ({ getItems: (...args) => state.getItems(...args) }));
vi.mock('apps/stable/features/playback/utils/mediaSessionSubscriber', () => ({ bindMediaSessionSubscriber: () => undefined }));
vi.mock('../../components/playback/skipsegment.ts', () => ({ bindSkipSegment: () => undefined }));

let ChromecastPlayer;
let playbackManager;
let ServerConnections;
let pluginManager;

function owner(userId, token) {
    let active = true;
    const listeners = new Set();
    return {
        serverId: 'server', profileUserId: userId, deviceId: 'device', sessionEpoch: 1,
        authorityRevision: userId === 'A' ? 1 : 2,
        credential: { userId, accessToken: token, deviceId: 'device', serverId: 'server', serverVersion: '1', serverAddress: 'https://server' },
        current: () => active,
        retire: () => {
            if (!active) return;
            active = false;
            for (const listener of listeners) listener();
        },
        onInvalidated: listener => {
            listeners.add(listener);
            if (!active) listener();
            return () => listeners.delete(listener);
        }
    };
}

function session(sessionId) {
    const sends = [];
    return {
        sessionId,
        receiver: { label: 'receiver', friendlyName: 'Living room', volume: { level: 0.5 } },
        media: [],
        sends,
        addMessageListener: vi.fn(), removeMessageListener: vi.fn(),
        addMediaListener: vi.fn(), removeMediaListener: vi.fn(),
        addUpdateListener: vi.fn(), removeUpdateListener: vi.fn(),
        sendMessage: vi.fn((_namespace, payload, success, error) => sends.push({ payload: JSON.parse(payload), success, error })),
        setReceiverVolumeLevel: vi.fn()
    };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function initializedPlayer() {
    const player = new ChromecastPlayer();
    Events.trigger(pluginManager, 'registered', [player]);
    await flush();
    const target = player.getCurrentTargetInfo();
    const init = state.sdk.initializations.at(-1);
    init.success();
    init.config.receiverListener('available');
    return { player, target, init };
}

async function pairCurrent(player, target, receiverSession) {
    const priorRequests = state.sdk.requests.length;
    const pairing = playbackManager.trySetActivePlayer(player.name, target, state.owner);
    await vi.waitFor(() => expect(state.sdk.requests.length).toBeGreaterThan(priorRequests));
    state.sdk.requests.at(-1).success(receiverSession);
    await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
    receiverSession.sends[0].success();
    await expect(pairing).resolves.toBe(true);
}

describe('Cast activation through real manager and plugin', () => {
    beforeEach(async () => {
        vi.resetModules();
        state.plugins = [];
        ({ ServerConnections } = await import('lib/jellyfin-apiclient'));
        ({ pluginManager } = await import('../../components/pluginManager'));
        ServerConnections._callbacks = {};
        pluginManager._callbacks = {};
        ({ default: ChromecastPlayer } = await import('./plugin'));
        ({ playbackManager } = await import('../../components/playback/playbackmanager'));
        state.owner = owner('A', 'token-A');
        state.client = {
            userId: 'A',
            getCurrentUserId() { return this.userId; },
            serverAddress: () => 'https://server',
            serverId: () => 'server',
            serverVersion: () => '1',
            deviceId: () => 'device',
            accessToken: () => state.client.userId === 'A' ? 'token-A' : 'token-B',
            getUser: vi.fn(async () => ({ Configuration: { CastReceiverId: 'receiver-app' } }))
        };
        state.receipt = null;
        state.generation = 0;
        state.currentToken = null;
        state.reserveResult = null;
        state.checkGate = null;
        state.confirmGate = null;
        state.claimGate = null;
        state.localChoiceGate = null;
        state.plugins = [];
        state.sdk = { initializations: [], requests: [] };
        state.loadPromise = null;
        state.getItems.mockReset();
        window.chrome = { cast: {
            isAvailable: true,
            SessionRequest: class { constructor(id) { this.id = id; } },
            ApiConfig: class {
                constructor(request, sessionListener, receiverListener) {
                    Object.assign(this, { request, sessionListener, receiverListener });
                }
            },
            initialize: vi.fn((config, success, error) => state.sdk.initializations.push({ config, success, error })),
            requestSession: vi.fn((success, error) => state.sdk.requests.push({ success, error }))
        } };
    });

    it('does not let A request completion settle B or Identify with B credentials', async () => {
        const { player, target } = await initializedPlayer();
        const first = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const second = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(2));
        const staleSession = session('A-session');
        state.sdk.requests[0].success(staleSession);
        state.sdk.requests[0].error();
        expect(staleSession.sends).toHaveLength(0);
        const currentSession = session('B-session');
        state.sdk.requests[1].success(currentSession);
        await vi.waitFor(() => expect(currentSession.sends).toHaveLength(1));
        expect(currentSession.sends[0].payload).toMatchObject({ command: 'Identify', userId: 'B', accessToken: 'token-B' });
        currentSession.sends[0].success();
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(true);
        expect(playbackManager.getPlayerInfo()?.name).toBe('Google Cast');
    });

    it('does not let automatic reconnect supersede an explicit pairing in progress', async () => {
        const { player, target } = await initializedPlayer();
        const explicit = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const automaticOwner = owner('A', 'token-A');
        const automatic = playbackManager.tryRestoreActivePlayer(
            player.name, target, automaticOwner, playbackManager.getCastSelectionRevision()
        );
        await expect(automatic).resolves.toBe(false);
        expect(state.sdk.requests).toHaveLength(1);
        const receiverSession = session('explicit');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await expect(explicit).resolves.toBe(true);
    });

    it('does not send A item resolved after a same-server B connection is installed', async () => {
        const { player, target } = await initializedPlayer();
        const aSession = session('A');
        await pairCurrent(player, target, aSession);
        let resolveItem;
        state.client.getItem = vi.fn(() => new Promise(resolve => {
            resolveItem = resolve;
        }));
        const delayed = player.playWithCommand({ serverId: 'server', ids: ['A-item'] }, 'PlayNow');
        expect(state.client.getItem).toHaveBeenCalledOnce();

        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const bSession = session('B');
        await pairCurrent(player, target, bSession);
        resolveItem({ Id: 'A-item', ServerId: 'server', Name: 'Old title' });
        await flush();
        expect(bSession.sends).toHaveLength(1);
        await expect(delayed).rejects.toThrow('Cast connection expired');
    });

    it('does not send delayed A playlist, shuffle or instant mix to B', async () => {
        const { player, target } = await initializedPlayer();
        await pairCurrent(player, target, session('A'));
        const itemResolvers = new Map();
        state.client.getItem = vi.fn((_user, id) => new Promise(resolve => {
            itemResolvers.set(id, resolve);
        }));
        let resolveItems;
        state.getItems.mockImplementationOnce(() => new Promise(resolve => {
            resolveItems = resolve;
        }));
        player.shuffle({ Id: 'shuffle', ServerId: 'server' });
        player.instantMix({ Id: 'mix', ServerId: 'server' });
        const delayedPlay = player.play({ serverId: 'server', ids: ['one', 'two'] });
        expect(itemResolvers.size).toBe(2);
        expect(state.getItems).toHaveBeenCalledOnce();

        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const bSession = session('B');
        await pairCurrent(player, target, bSession);
        itemResolvers.get('shuffle')({ Id: 'shuffle', ServerId: 'server' });
        itemResolvers.get('mix')({ Id: 'mix', ServerId: 'server' });
        resolveItems({ Items: [{ Id: 'one', ServerId: 'server' }, { Id: 'two', ServerId: 'server' }] });
        await flush();
        expect(bSession.sends).toHaveLength(1);
        await expect(delayedPlay).rejects.toThrow('Cast connection expired');
    });

    it('ignores an unowned restored callback and accepts a matching receipt', async () => {
        const { player, init } = await initializedPlayer();
        const receiverSession = session('restored');
        init.config.sessionListener(receiverSession);
        expect(receiverSession.sends).toHaveLength(0);
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await flush();
        expect(playbackManager.getCurrentPlayer()).toBe(player);
        player.displayContent({ ServerId: 'foreign-server' });
        expect(receiverSession.sends).toHaveLength(1);
        state.owner.retire();
        player.seek(1000);
        expect(receiverSession.sends).toHaveLength(1);
        expect(state.receipt).toBeNull();
    });

    it('does not publish a passive restoration after explicit local selection during Identify', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        playbackManager.setActivePlayer('localplayer');
        receiverSession.sends[0].success();
        await flush();
        expect(playbackManager.getPlayerInfo()).toBeNull();
        expect(state.receipt).toBeNull();
    });

    it('keeps an explicit non-Cast player when a restored Identify completes late', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        const otherPlayer = { name: 'Other Remote', type: 'mediaplayer', isLocalPlayer: false, volume: () => 50 };
        Events.trigger(pluginManager, 'registered', [otherPlayer]);
        playbackManager.setActivePlayer(otherPlayer.name, { id: 'other', deviceName: 'Other Remote' });
        receiverSession.sends[0].success();
        await flush();
        expect(playbackManager.getCurrentPlayer()).toBe(otherPlayer);
        expect(state.receipt).toBeNull();
    });

    it('does not retry a locally dismissed receipt after same-profile SDK reinitialization', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        playbackManager.setActivePlayer('localplayer');
        init.config.sessionListener(receiverSession);
        expect(receiverSession.sends).toHaveLength(0);
        state.owner = owner('A', 'token-A');
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        const nextInit = state.sdk.initializations.at(-1);
        nextInit.success();
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        nextInit.config.sessionListener(receiverSession);
        expect(receiverSession.sends).toHaveLength(0);
    });

    it('does not restore after local selection made before the sender SDK loads', async () => {
        let finishLoad;
        state.loadPromise = new Promise(resolve => {
            finishLoad = resolve;
        });
        const player = new ChromecastPlayer();
        Events.trigger(pluginManager, 'registered', [player]);
        playbackManager.setActivePlayer('localplayer');
        state.owner = owner('A', 'token-A');
        finishLoad();
        await flush();
        const init = state.sdk.initializations.at(-1);
        expect(init).toBeDefined();
        init.success();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        expect(receiverSession.sends).toHaveLength(0);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('does not restore a confirmed receipt after a pre-plugin local choice and another reload', async () => {
        const receiverSession = session('old-confirmed');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession, token: 1 };
        playbackManager.setActivePlayer('localplayer');
        await vi.waitFor(() => expect(state.receipt).toBeNull());

        vi.resetModules();
        state.owner = owner('A', 'token-A');
        if (state.receipt) state.receipt.owner = state.owner;
        const { default: ReloadedPlayer } = await import('./plugin');
        const reloaded = new ReloadedPlayer();
        await vi.waitFor(() => expect(state.sdk.initializations).toHaveLength(1));
        state.sdk.initializations[0].success();
        state.sdk.initializations[0].config.sessionListener(receiverSession);
        await flush();
        expect(receiverSession.sends).toHaveLength(0);
        expect(reloaded._castPlayer.connection).toBeNull();
    });

    it('does not clear a new explicit Cast reservation while a local-choice storage open is delayed', async () => {
        const { player, target } = await initializedPlayer();
        const previousSession = session('previous');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: previousSession, token: 1 };
        let releaseLocalChoice;
        state.localChoiceGate = () => new Promise(resolve => {
            releaseLocalChoice = resolve;
        });

        playbackManager.setActivePlayer('localplayer');
        const automaticOwner = owner('A', 'token-A');
        await expect(playbackManager.tryRestoreActivePlayer(
            player.name, target, automaticOwner, playbackManager.getCastSelectionRevision()
        )).resolves.toBe(false);
        expect(state.sdk.requests).toHaveLength(0);
        const pairing = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        releaseLocalChoice();
        await flush();
        expect(state.receipt?.session).toBe(previousSession);

        const successor = session('successor');
        state.sdk.requests[0].success(successor);
        await vi.waitFor(() => expect(successor.sends).toHaveLength(1));
        successor.sends[0].success();
        await expect(pairing).resolves.toBe(true);
        expect(state.receipt?.session).toBe(successor);
    });

    it('drops a delayed A Identify after B owns the same generic target', async () => {
        const { player, target } = await initializedPlayer();
        const first = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const sessionA = session('A-session');
        state.sdk.requests[0].success(sessionA);
        await vi.waitFor(() => expect(sessionA.sends).toHaveLength(1));
        expect(sessionA.addUpdateListener).not.toHaveBeenCalled();
        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const second = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(2));
        const sessionB = session('B-session');
        state.sdk.requests[1].success(sessionB);
        sessionA.sends[0].success();
        expect(state.receipt).toBeNull();
        await vi.waitFor(() => expect(sessionB.sends).toHaveLength(1));
        sessionB.sends[0].success();
        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(true);
        expect(state.receipt.session).toBe(sessionB);
        expect(playbackManager.getCurrentPlayer()).toBe(player);
    });

    it('ignores A disconnect after B has confirmed its receiver', async () => {
        const { player, target } = await initializedPlayer();
        const first = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const sessionA = session('A-session');
        state.sdk.requests[0].success(sessionA);
        await vi.waitFor(() => expect(sessionA.sends).toHaveLength(1));
        sessionA.sends[0].success();
        await expect(first).resolves.toBe(true);
        const staleDisconnect = sessionA.addUpdateListener.mock.calls[0][0];
        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const second = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(2));
        const sessionB = session('B-session');
        state.sdk.requests[1].success(sessionB);
        await vi.waitFor(() => expect(sessionB.sends).toHaveLength(1));
        sessionB.sends[0].success();
        await expect(second).resolves.toBe(true);
        staleDisconnect(false);
        expect(state.receipt.session).toBe(sessionB);
        expect(playbackManager.getCurrentPlayer()).toBe(player);
    });

    it('cancels reentrant pairing and explicit local selection without publishing late callbacks', async () => {
        const { player, target } = await initializedPlayer();
        const revokeDuringPairing = () => state.owner.retire();
        Events.on(playbackManager, 'pairing', revokeDuringPairing);
        const first = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        Events.off(playbackManager, 'pairing', revokeDuringPairing);
        await expect(first).resolves.toBe(false);
        expect(state.sdk.requests).toHaveLength(0);
        expect(playbackManager.getPlayerInfo()).toBeNull();

        state.owner = owner('A', 'token-A');
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        state.sdk.initializations.at(-1).success();
        const second = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        playbackManager.setActivePlayer('localplayer');
        state.sdk.requests[0].success(session('late'));
        await expect(second).resolves.toBe(false);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('does not initialize an old receiver after its user lookup completes under B', async () => {
        let finishA;
        state.client.getUser = vi.fn(userId => userId === 'A' ? new Promise(resolve => {
            finishA = resolve;
        }) : Promise.resolve({ Configuration: { CastReceiverId: 'receiver-B' } }));
        new ChromecastPlayer();
        await flush();
        const countBefore = state.sdk.initializations.length;
        state.owner.retire();
        state.owner = owner('B', 'token-B');
        state.client.userId = 'B';
        Events.trigger(ServerConnections, 'localusersignedin');
        await flush();
        const countAfterB = state.sdk.initializations.length;
        expect(countAfterB).toBeGreaterThan(countBefore);
        finishA({ Configuration: { CastReceiverId: 'receiver-A' } });
        await flush();
        expect(state.sdk.initializations).toHaveLength(countAfterB);
    });

    it('rechecks ownership after a paired listener revokes the same request', async () => {
        const { player, target } = await initializedPlayer();
        const revokeAfterIdentify = () => state.owner.retire();
        Events.on(playbackManager, 'paired', revokeAfterIdentify);
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const receiverSession = session('A-session');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await expect(result).resolves.toBe(false);
        Events.off(playbackManager, 'paired', revokeAfterIdentify);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('settles a request whose SDK callback lacks concrete receiver identity', async () => {
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        state.sdk.requests[0].success({ sessionId: 'incomplete', receiver: {} });
        await expect(result).resolves.toBe(false);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('does not let a direct player assignment bypass unavailable Cast authority', async () => {
        const { player, target } = await initializedPlayer();
        playbackManager.setActivePlayer(player.name, target);
        expect(playbackManager.getCurrentPlayer()).toBeFalsy();
        state.owner = null;
        await expect(playbackManager.trySetActivePlayer(player.name, target)).resolves.toBe(false);
        expect(state.sdk.requests).toHaveLength(0);
    });

    it('deduplicates only a still-current retry with the same bound authority', async () => {
        const { player, target } = await initializedPlayer();
        const first = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        const equivalent = owner('A', 'token-A');
        const joined = playbackManager.trySetActivePlayer(player.name, target, equivalent);
        expect(joined).toBe(first);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        expect(equivalent.current()).toBe(false);
        const receiverSession = session('A-session');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await expect(first).resolves.toBe(true);
    });

    it('does not Identify when another document supersedes the reservation during storage check', async () => {
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        let releaseCheck;
        state.checkGate = () => new Promise(resolve => {
            releaseCheck = resolve;
        });
        const receiverSession = session('old');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(releaseCheck).toBeTypeOf('function'));
        state.currentToken = ++state.generation;
        releaseCheck();
        await expect(result).resolves.toBe(false);
        expect(receiverSession.sends).toHaveLength(0);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('does not install receiver callbacks or relay playback before storage admits the connection', async () => {
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        let releaseCheck;
        state.checkGate = () => new Promise(resolve => {
            releaseCheck = resolve;
        });
        const receiverSession = session('old');
        receiverSession.addMessageListener.mockImplementation((namespace, listener) => {
            listener(namespace, JSON.stringify({ type: 'playbackstart', data: { ItemId: 'old-item' } }));
        });
        const addedDocumentListener = vi.spyOn(document, 'addEventListener');
        const published = vi.fn();
        Events.on(player._castPlayer, 'playbackstart', published);
        state.sdk.requests[0].success(receiverSession);
        expect(receiverSession.addMessageListener).not.toHaveBeenCalled();
        expect(receiverSession.addMediaListener).not.toHaveBeenCalled();
        expect(receiverSession.addUpdateListener).not.toHaveBeenCalled();
        expect(addedDocumentListener.mock.calls.some(([event]) => event === 'volumeupbutton')).toBe(false);
        expect(published).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(releaseCheck).toBeTypeOf('function'));
        state.currentToken = ++state.generation;
        releaseCheck();
        await expect(result).resolves.toBe(false);
        expect(receiverSession.addMessageListener).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
        expect(receiverSession.sends).toHaveLength(0);
    });

    it('keeps restored media invisible while receipt admission waits', async () => {
        const { player, init } = await initializedPlayer();
        const receiverSession = session('restored');
        const media = { mediaSessionId: 1, playerState: 'PLAYING', addUpdateListener: vi.fn() };
        receiverSession.media.push(media);
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        let releaseCheck;
        state.checkGate = () => new Promise(resolve => {
            releaseCheck = resolve;
        });
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(releaseCheck).toBeTypeOf('function'));
        expect(player._castPlayer.currentMediaSession).toBeNull();
        expect(media.addUpdateListener).not.toHaveBeenCalled();
        expect(receiverSession.addMediaListener).not.toHaveBeenCalled();
        state.currentToken = ++state.generation;
        releaseCheck();
        await flush();
        expect(player._castPlayer.currentMediaSession).toBeNull();
        expect(receiverSession.sends).toHaveLength(0);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('revokes a restored receipt immediately when local selection interrupts a pending check', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        state.checkGate = () => new Promise(() => undefined);
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(state.currentToken).not.toBeNull());
        playbackManager.setActivePlayer('localplayer');
        await vi.waitFor(() => expect(state.receipt).toBeNull());
        expect(receiverSession.sends).toHaveLength(0);
    });

    it('revokes a restored receipt when local selection interrupts an Identify with no callback', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        playbackManager.setActivePlayer('localplayer');
        await vi.waitFor(() => expect(state.receipt).toBeNull());
        expect(playbackManager.getPlayerInfo()).toBeNull();

        const initializationCount = state.sdk.initializations.length;
        vi.resetModules();
        state.owner = owner('A', 'token-A');
        if (state.receipt) state.receipt.owner = state.owner;
        const { default: ReloadedPlayer } = await import('./plugin');
        const reloaded = new ReloadedPlayer();
        await vi.waitFor(() => expect(state.sdk.initializations.length).toBeGreaterThan(initializationCount));
        const reloadedSdk = state.sdk.initializations.at(-1);
        reloadedSdk.success();
        reloadedSdk.config.sessionListener(receiverSession);
        await flush();
        expect(receiverSession.sends).toHaveLength(1);
        expect(reloaded._castPlayer.connection).toBeNull();
    });

    it('ignores a queued receiver message after an explicit local choice', async () => {
        const { player, init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await vi.waitFor(() => expect(receiverSession.addMessageListener).toHaveBeenCalledOnce());
        const queuedMessage = receiverSession.addMessageListener.mock.calls[0][1];
        const published = vi.fn();
        Events.on(player._castPlayer, 'playbackstart', published);
        playbackManager.setActivePlayer('localplayer');
        queuedMessage('urn:x-cast:com.connectsdk', JSON.stringify({ type: 'playbackstart', data: { ItemId: 'old-item' } }));
        expect(published).not.toHaveBeenCalled();
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('does not publish when another document supersedes while receipt confirmation waits', async () => {
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const receiverSession = session('old');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        let releaseConfirm;
        state.confirmGate = () => new Promise(resolve => {
            releaseConfirm = resolve;
        });
        receiverSession.sends[0].success();
        await vi.waitFor(() => expect(releaseConfirm).toBeTypeOf('function'));
        state.currentToken = ++state.generation;
        releaseConfirm();
        await expect(result).resolves.toBe(false);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });

    it('ignores a duplicate SDK success for the same pending request', async () => {
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const receiverSession = session('first');
        const duplicateSession = session('duplicate');
        state.sdk.requests[0].success(receiverSession);
        state.sdk.requests[0].success(duplicateSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        expect(duplicateSession.sends).toHaveLength(0);
        receiverSession.sends[0].success();
        await expect(result).resolves.toBe(true);
        expect(playbackManager.getCurrentPlayer()).toBe(player);
    });

    it('allows current explicit pairing in memory when storage is unavailable', async () => {
        state.reserveResult = { status: 'unavailable' };
        const { player, target } = await initializedPlayer();
        const result = playbackManager.trySetActivePlayer(player.name, target, state.owner);
        await vi.waitFor(() => expect(state.sdk.requests).toHaveLength(1));
        const receiverSession = session('current');
        state.sdk.requests[0].success(receiverSession);
        await vi.waitFor(() => expect(receiverSession.sends).toHaveLength(1));
        receiverSession.sends[0].success();
        await expect(result).resolves.toBe(true);
        expect(state.receipt).toBeNull();
        expect(playbackManager.getCurrentPlayer()).toBe(player);
    });

    it('drops a restored claim if local selection occurs while storage is pending', async () => {
        const { init } = await initializedPlayer();
        const receiverSession = session('restored');
        state.receipt = { owner: state.owner, playerId: 'Google Cast', session: receiverSession };
        let releaseClaim;
        state.claimGate = () => new Promise(resolve => {
            releaseClaim = resolve;
        });
        init.config.sessionListener(receiverSession);
        await vi.waitFor(() => expect(releaseClaim).toBeTypeOf('function'));
        playbackManager.setActivePlayer('localplayer');
        releaseClaim();
        await flush();
        expect(receiverSession.sends).toHaveLength(0);
        expect(playbackManager.getPlayerInfo()).toBeNull();
    });
});
