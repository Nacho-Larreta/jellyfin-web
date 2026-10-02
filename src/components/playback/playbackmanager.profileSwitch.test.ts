import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Events from '../../utils/events';
import { createPlaybackIdentity } from '../htmlMediaLifecycle';

const reports = vi.hoisted(() => ({
    started: vi.fn(async () => undefined),
    stopped: vi.fn(async (info: unknown): Promise<void> => { expect(info).toBeDefined(); })
}));
const preparation = vi.hoisted(() => ({ getItem: vi.fn() }));
const pluginRegistry = vi.hoisted(() => ({
    players: [] as unknown[],
    interceptors: [] as unknown[],
    ofType: (type: string) => type === 'mediaplayer' ? pluginRegistry.players : pluginRegistry.interceptors
}));

vi.mock('../apphost', () => ({ appHost: { supports: () => false } }));
vi.mock('../alert', () => ({ default: () => undefined }));
vi.mock('../pluginManager', () => ({ pluginManager: pluginRegistry }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: () => ({
            reportPlaybackStart: reports.started,
            reportPlaybackStopped: reports.stopped,
            getCurrentUserId: () => 'user-old',
            getItem: preparation.getItem
        })
    }
}));
vi.mock('apps/stable/features/playback/utils/mediaSegmentManager', () => ({ bindMediaSegmentManager: () => undefined }));
vi.mock('apps/stable/features/playback/utils/mediaSessionSubscriber', () => ({ bindMediaSessionSubscriber: () => undefined }));
vi.mock('./skipsegment.ts', () => ({ bindSkipSegment: () => undefined }));

import { createActiveProfileSession } from '../../lib/profileSelector/sessionSwitch/model';
import { WebPlaybackQuiescePort } from '../../lib/profileSelector/sessionSwitch/playback';
import { PlaybackManager } from './playbackmanager';

const item = { Id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', ServerId: 'server-old', MediaType: 'Video' };
const switchId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const session = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-old', 7);
const reportKey = '9496c00160f97656df419a1b3275aa0786dd928703ffea2a7c31df4bc079f3a8';

function stream(playItem = item, playSessionId = 'play-old', playMethod = 'DirectPlay') {
    return {
        item: playItem,
        playSessionId,
        url: `/Videos/${playItem.Id}/stream?PlaySessionId=${playSessionId}`,
        playMethod,
        mediaType: playItem.MediaType,
        mediaSource: null,
        started: true,
        ended: false,
        playbackIdentity: createPlaybackIdentity({ item: playItem, playSessionId })
    };
}

function htmlPlayer(mediaType = 'Video', playMethod = 'DirectPlay') {
    const initialStream = stream({ ...item, MediaType: mediaType }, 'play-old', playMethod);
    const player = {
        name: mediaType === 'Video' ? 'Html Video Player' : 'Html Audio Player',
        type: 'mediaplayer',
        id: `html-${mediaType}`,
        isLocalPlayer: true,
        supportsPlaybackLifecycle: true,
        canPlayMediaType: () => true,
        streamInfo: initialStream as ReturnType<typeof stream> | null,
        source: initialStream.url as string | null,
        currentSrc: () => player.source,
        currentTime: () => 25,
        duration: () => 100,
        volume: () => 100,
        isMuted: () => false,
        paused: () => false,
        maxStreamingBitrate: 120_000_000,
        destroy: vi.fn(),
        stop: vi.fn(async () => {
            emitStop(player);
            if (mediaType === 'Audio') player.source = null;
        })
    };
    return player;
}

function emitStop(player: ReturnType<typeof htmlPlayer>, identity = player.streamInfo?.playbackIdentity) {
    Events.trigger(player, 'stopped', [{ src: undefined, playbackIdentity: identity }]);
}

function documentPlayers() {
    return ['PDF Player', 'Book Player', 'Comics Player'].map(name => ({
        name,
        id: name,
        type: 'mediaplayer',
        isLocalPlayer: true,
        canPlayMediaType: () => false,
        item: undefined as unknown,
        currentItem() { return this.item; }
    }));
}

function readyPlayer(mediaType = 'Video', playMethod = 'DirectPlay', extraPlayers: unknown[] = []) {
    const player = htmlPlayer(mediaType, playMethod);
    const documents = documentPlayers();
    pluginRegistry.players = [player, ...documents, ...extraPlayers];
    const manager = new PlaybackManager();
    manager.setActivePlayer(player);
    const transport = vi.fn(async () => ({ Outcome: 'Acknowledged', ReportKey: reportKey }));
    const port = new WebPlaybackQuiescePort(
        manager,
        { getApiClient: () => ({ getUrl: (path: string) => `/old-api/${path}` }) },
        { appName: () => 'Jellyfin Web', appVersion: () => '1', deviceName: () => 'Browser' },
        transport
    );
    return { manager, player, documents, port, transport };
}

describe('PlaybackManager profile switch stop with real bound handlers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        reports.stopped.mockClear();
        preparation.getItem.mockReset();
        pluginRegistry.players = [];
        pluginRegistry.interceptors = [];
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['Audio', 'Video'])('confirms an HTML %s stop despite manager cleanup before later listeners', async mediaType => {
        const { manager, player } = readyPlayer(mediaType);
        const stateAfterManager: unknown[] = [];
        Events.on(player, 'stopped', () => stateAfterManager.push(manager.currentItem(player)));

        const result = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        await Promise.all([expect(result).resolves.toBeUndefined(), vi.runAllTimersAsync()]);

        expect(stateAfterManager).toEqual([null]);
        expect(manager.getCurrentPlayer()).toBeNull();
        expect(player.destroy).toHaveBeenCalledOnce();
        expect(reports.stopped).not.toHaveBeenCalled();
    });

    it('waits for a real stopped event when the player promise completes first', async () => {
        const { manager, player } = readyPlayer();
        player.stop.mockResolvedValueOnce(undefined);
        let settled = false;
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old').then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);

        emitStop(player);
        await Promise.all([expect(stopping).resolves.toBeUndefined(), vi.runAllTimersAsync()]);
        expect(reports.stopped).not.toHaveBeenCalled();
    });

    it.each(['DirectPlay', 'Transcode'])('quiesces %s using the real manager with idle document plugins registered', async playMethod => {
        const { manager, player, port, transport } = readyPlayer('Video', playMethod);
        const result = port.stopAndReport(session, switchId);
        await vi.runAllTimersAsync();

        expect(await result).toEqual({ outcome: 'Acknowledged', reportKey });
        expect(manager.currentItem(player)).toBeNull();
        expect(player.currentSrc()).not.toBeNull();
        expect(transport).toHaveBeenCalledWith(
            `/old-api/ProfileSelectors/Current/Switches/${switchId}/PlaybackStopped`,
            expect.stringContaining('Token="token-old"'),
            { ItemId: item.Id, PlaySessionId: 'play-old', PositionTicks: 250_000, Failed: false, NextMediaType: null },
            10_000
        );
        expect(reports.stopped).not.toHaveBeenCalled();
    });

    it('proves absence without calling missing currentSrc on idle document plugins', async () => {
        const { player, port, transport } = readyPlayer();
        player.streamInfo = null;
        player.source = null;

        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('accepts absence after an ordinary HTML Video stop whose private source survives cleanup', async () => {
        const { manager, player, port, transport } = readyPlayer();

        await manager.stop(player);

        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ItemId: item.Id, PlaySessionId: 'play-old'
        }));
        expect(manager.currentItem(player)).toBeNull();
        expect(manager.playSessionId(player)).toBeNull();
        expect(manager.getCurrentPlayer()).toBeNull();
        expect(player.destroy).toHaveBeenCalledOnce();
        expect(manager.isPlaying(player)).toBe(true);

        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('can finish manager cleanup while the ordinary stop report is still pending', async () => {
        let acknowledgeReport!: () => void;
        reports.stopped.mockImplementationOnce(() => new Promise<void>(resolve => {
            acknowledgeReport = resolve;
        }));
        const { manager, player, port, transport } = readyPlayer();
        try {
            await manager.stop(player);

            expect(manager.currentItem(player)).toBeNull();
            expect(manager.playSessionId(player)).toBeNull();
            expect(manager.getCurrentPlayer()).toBeNull();
            expect(player.destroy).toHaveBeenCalledOnce();
            expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Pending');
            expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        } finally {
            acknowledgeReport();
        }
        await Promise.resolve();
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Idle');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
        expect(reports.stopped).toHaveBeenCalledOnce();
        expect(transport).not.toHaveBeenCalled();
    });

    it('requires verified recovery after an ordinary report rejection without an unhandled rejection or retry', async () => {
        reports.stopped.mockRejectedValueOnce(new Error('report delivery unknown'));
        const { manager, player, port, transport } = readyPlayer();
        await manager.stop(player);

        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('RecoveryRequired');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('RecoveryRequired');
        expect(reports.stopped).toHaveBeenCalledOnce();
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not publish idle while the physical stop promise is pending after cleanup', async () => {
        const { manager, player, port } = readyPlayer();
        let finishStop!: () => void;
        player.stop.mockImplementationOnce(() => {
            emitStop(player);
            return new Promise<void>(resolve => {
                finishStop = resolve;
            });
        });
        const stopping = manager.stop(player);
        expect(manager.currentItem(player)).toBeNull();
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Pending');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });

        finishStop();
        await stopping;
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
    });

    it('blocks an old cleanup receipt before the first await of a new play request', async () => {
        const { manager, player, port } = readyPlayer();
        await manager.stop(player);
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Idle');
        let rejectPreparation!: (reason: Error) => void;
        preparation.getItem.mockImplementationOnce(() => new Promise((resolve, reject) => {
            rejectPreparation = reject;
        }));

        const starting = manager.play({ serverId: 'server-old', ids: [item.Id], fullscreen: false });
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Pending');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });

        const rejected = expect(starting).rejects.toThrow('preparation failed');
        rejectPreparation(new Error('preparation failed'));
        await rejected;
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Idle');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
    });

    it('invalidates cleanup before next-track preparation on a reused player', async () => {
        const { manager, player, port } = readyPlayer();
        await manager.stop(player);
        let cancelPreparation!: () => void;
        pluginRegistry.interceptors = [{
            intercept: () => new Promise((resolve, reject) => {
                cancelPreparation = () => reject(new Error('cancelled'));
            })
        }];
        manager._playQueueManager.setPlaylist([{ ...item }]);

        manager.nextTrack(player);
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Pending');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });

        cancelPreparation();
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Unknown');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });

        player.streamInfo = stream(item, 'play-new');
        player.source = player.streamInfo.url;
        await manager.stop(player);
        expect(manager.getProfileSwitchPlaybackStatus(player)).toBe('Idle');
        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
    });

    it('rejects a non-current document player that still owns an item', async () => {
        const { player, documents, port, transport } = readyPlayer();
        player.streamInfo = null;
        player.source = null;
        documents[1].item = item;

        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(transport).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'Unknown remote', isLocalPlayer: false },
        { name: 'Google Cast', isLocalPlayer: false, isPlaying: () => false, _castPlayer: { session: {} } }
    ])('fails closed with $name registered even when the local player is absent', async remote => {
        const { player, port, transport } = readyPlayer('Video', 'DirectPlay', [remote]);
        player.streamInfo = null;
        player.source = null;

        expect(await port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('quiesces paused and buffering local playback with an item still present', async () => {
        const { player, port } = readyPlayer();
        player.paused = () => true;
        player.source = null;

        const result = port.stopAndReport(session, switchId);
        await vi.runAllTimersAsync();
        expect(await result).toEqual({ outcome: 'Acknowledged', reportKey });
        expect(player.stop).toHaveBeenCalledOnce();
    });

    it('suppresses the captured late callback after timeout', async () => {
        const { manager, player } = readyPlayer();
        player.stop.mockResolvedValueOnce(undefined);
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
        await vi.advanceTimersByTimeAsync(4_500);
        await assertion;

        emitStop(player);
        expect(reports.stopped).not.toHaveBeenCalled();
    });

    it('also bounds a hanging player promise after the stopped callback', async () => {
        const { manager, player } = readyPlayer();
        player.stop.mockImplementationOnce(() => {
            emitStop(player);
            return new Promise(() => undefined);
        });
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
        await vi.advanceTimersByTimeAsync(4_500);
        await assertion;

        expect(reports.stopped).not.toHaveBeenCalled();
        player.streamInfo = stream(item, 'play-new');
        player.source = player.streamInfo.url;
        await expect(manager.stopForProfileSwitch(player, item.Id, 'play-new')).resolves.toBeUndefined();
    });

    it('does not stop a replacement that starts before the stop is dispatched', async () => {
        const { manager, player } = readyPlayer();
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        player.streamInfo = stream(item, 'play-new');
        player.source = player.streamInfo.url;

        await expect(stopping).rejects.toThrow('Playback changed before');
        expect(player.stop).not.toHaveBeenCalled();
        emitStop(player);
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ PlaySessionId: 'play-new' }));
    });

    it('reports a new play session of the same item after an old stop timeout', async () => {
        const { manager, player } = readyPlayer();
        player.stop.mockResolvedValueOnce(undefined);
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
        await vi.advanceTimersByTimeAsync(4_500);
        await assertion;

        player.streamInfo = stream(item, 'play-new');
        player.source = player.streamInfo.url;
        emitStop(player);
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ItemId: item.Id, PlaySessionId: 'play-new'
        }));
    });

    it('does not suppress another player with the same item and play session', async () => {
        const other = htmlPlayer('Audio');
        const { manager, player } = readyPlayer('Video', 'DirectPlay', [other]);
        player.stop.mockResolvedValueOnce(undefined);
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
        await vi.advanceTimersByTimeAsync(4_500);
        await assertion;

        emitStop(other);
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ItemId: item.Id, PlaySessionId: 'play-old'
        }));
        expect(manager.currentItem(player)).toEqual(item);
    });

    it('does not acknowledge an untagged callback or suppress a re-sourced generation of the same play session', async () => {
        const { manager, player } = readyPlayer();
        const oldIdentity = player.streamInfo?.playbackIdentity;
        player.stop.mockResolvedValueOnce(undefined);
        const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
        const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
        await vi.advanceTimersByTimeAsync(1);
        Events.trigger(player, 'stopped', [{ src: undefined }]);
        expect(manager.currentItem(player)).toEqual(item);
        player.streamInfo = stream(item, 'play-old');
        emitStop(player, oldIdentity);
        expect(manager.currentItem(player)).toBe(item);
        emitStop(player);
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ PlaySessionId: 'play-old' }));
        await vi.advanceTimersByTimeAsync(4_500);
        await assertion;
    });

    it.each([
        { positionMs: 364.34, capturedTicks: undefined, expectedTicks: 3_643_400 },
        { positionMs: Number.NaN, capturedTicks: undefined, expectedTicks: undefined },
        { positionMs: Number.POSITIVE_INFINITY, capturedTicks: 1_200_000, expectedTicks: 1_200_000 },
        { positionMs: -1, capturedTicks: undefined, expectedTicks: undefined },
        { positionMs: Number.MAX_SAFE_INTEGER, capturedTicks: undefined, expectedTicks: undefined }
    ])('rejects self-managed plugins and safely reports stop position $positionMs', async ({ positionMs, capturedTicks, expectedTicks }) => {
        const player = {
            name: 'Self-managed local player',
            id: 'self-managed',
            isLocalPlayer: true,
            canPlayMediaType: () => true,
            getPlaylist: () => [],
            getPlaylistSync: () => [item],
            currentItem: () => item,
            playSessionId: () => 'play-old',
            getPlayerState: () => ({ NowPlayingItem: item, PlayState: { PlaySessionId: 'play-old', PositionTicks: capturedTicks } }),
            destroy: vi.fn(),
            stop: vi.fn()
        };
        pluginRegistry.players = [player];
        const manager = new PlaybackManager();
        Events.trigger(player, 'itemstarted', [item, null]);

        await expect(manager.stopForProfileSwitch(player, item.Id, 'play-old')).rejects.toThrow('captured local player');
        expect(player.stop).not.toHaveBeenCalled();

        Events.trigger(player, 'itemstopped', [{ item, mediaSource: null, positionMs }]);
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ItemId: item.Id, PlaySessionId: 'play-old'
        }));
        const wireBody = JSON.parse(JSON.stringify(reports.stopped.mock.calls[0][0]));
        if (expectedTicks === undefined) expect(wireBody).not.toHaveProperty('PositionTicks');
        else expect(wireBody.PositionTicks).toBe(expectedTicks);
    });

    it.each([item, { ...item, Id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' }])(
        'ignores delayed and duplicate old events after player reuse for $Id', async nextItem => {
            const { manager, player } = readyPlayer();
            const oldIdentity = player.streamInfo?.playbackIdentity;
            player.stop.mockResolvedValueOnce(undefined);
            const stopping = manager.stopForProfileSwitch(player, item.Id, 'play-old');
            const assertion = expect(stopping).rejects.toThrow('Player stop timed out.');
            await vi.advanceTimersByTimeAsync(4_500);
            await assertion;

            player.streamInfo = stream(nextItem, 'play-new');
            player.source = player.streamInfo.url;
            emitStop(player, oldIdentity);
            emitStop(player, oldIdentity);
            expect(reports.stopped).not.toHaveBeenCalled();
            expect(manager.currentItem(player)).toBe(nextItem);
            expect(player.destroy).not.toHaveBeenCalled();

            emitStop(player);
            expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                ItemId: nextItem.Id, PlaySessionId: 'play-new'
            }));
        }
    );
});
