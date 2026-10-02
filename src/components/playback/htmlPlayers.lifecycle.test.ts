import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Events from '../../utils/events';
import browser from '../../scripts/browser';

const reports = vi.hoisted(() => ({ stopped: vi.fn(async (info: unknown) => JSON.stringify(info)), progress: vi.fn(async () => undefined) }));
const registry = vi.hoisted(() => ({ players: [] as unknown[] }));
vi.mock('../apphost', () => ({ appHost: { supports: () => false } }));
vi.mock('../alert', () => ({ default: () => undefined }));
vi.mock('../pluginManager', () => ({ pluginManager: { ofType: () => registry.players } }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: { getApiClient: () => ({
        reportPlaybackStopped: reports.stopped, reportPlaybackProgress: reports.progress,
        getCurrentUserId: () => 'user', getSavedEndpointInfo: () => ({})
    }) }
}));
vi.mock('apps/stable/features/playback/utils/mediaSegmentManager', () => ({ bindMediaSegmentManager: () => undefined }));
vi.mock('apps/stable/features/playback/utils/mediaSessionSubscriber', () => ({ bindMediaSessionSubscriber: () => undefined }));
vi.mock('./skipsegment.ts', () => ({ bindSkipSegment: () => undefined }));
vi.mock('apps/stable/features/playback/utils/subtitleStyles', () => ({ useCustomSubtitles: () => false }));
vi.mock('../subtitlesettings/subtitleappearancehelper', () => ({ default: {} }));
vi.mock('../router/appRouter', () => ({ appRouter: {} }));
vi.mock('../backdrop/backdrop', async importOriginal => ({
    ...await importOriginal<typeof import('../backdrop/backdrop')>(),
    setBackdropTransparency: () => undefined
}));
vi.mock('../../scripts/settings/webSettings', () => ({ getIncludeCorsCredentials: async () => false }));
vi.mock('../../scripts/settings/userSettings', async importOriginal => ({
    ...await importOriginal<typeof import('../../scripts/settings/userSettings')>(),
    selectAudioNormalization: () => 'Off'
}));

import HtmlAudioPlayer from '../../plugins/htmlAudioPlayer/plugin';
import HtmlVideoPlayer from '../../plugins/htmlVideoPlayer/plugin';
import { mediaPlaybackFor } from '../htmlMediaLifecycle';
import { PlaybackManager } from './playbackmanager';

const item = { Id: 'item', ServerId: 'server', MediaType: 'Video' };
const cleanups: Array<() => void> = [];

function options(playSessionId: string, mediaType: string) {
    return {
        item: { ...item, MediaType: mediaType }, playSessionId, mediaType,
        url: '/same-source', playMethod: 'DirectPlay', started: true, ended: false,
        mediaSource: { MediaStreams: [], RunTimeTicks: 100_000_000, Container: 'mp4' },
        fullscreen: false, playerStartPositionTicks: 0
    };
}

function fixture(kind: 'Audio' | 'Video') {
    const player = Object.assign(kind === 'Audio' ? new HtmlAudioPlayer() : new HtmlVideoPlayer(), {
        streamInfo: null as ReturnType<typeof options> | null, isLocalPlayer: true
    });
    registry.players = [player];
    const manager = new PlaybackManager();
    cleanups.push(() => player.destroy());
    const start = async (sessionId: string) => {
        const streamInfo = options(sessionId, kind);
        manager.assignPlaybackIdentity(player, streamInfo);
        player.streamInfo = streamInfo;
        await player.play(streamInfo);
        manager.setActivePlayer(player);
        const element = document.querySelector<HTMLMediaElement>(kind === 'Audio' ? 'audio' : 'video');
        if (!element) throw new Error('Real plugin did not create a media element.');
        return { element, streamInfo, identity: mediaPlaybackFor(element).identity };
    };
    return { player, manager, start };
}

describe('real HTML players and manager execution ownership', () => {
    beforeEach(() => {
        reports.stopped.mockClear();
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    });
    afterEach(() => {
        cleanups.splice(0).forEach(cleanup => {
            cleanup();
        });
        document.body.replaceChildren();
        vi.useRealTimers();
    });

    it.each(['Audio', 'Video'] as const)('%s native ended from a retired element cannot stop the new same-item same-URL session', async kind => {
        const bindings = vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');
        const { player, manager, start } = fixture(kind);
        const old = await start('old');
        const bindingIndex = bindings.mock.calls.findIndex((args, index) => args[0] === 'ended' && bindings.mock.contexts[index] === old.element);
        const ended = bindings.mock.calls[bindingIndex][1];
        const deliverOldEnded = () => {
            const event = new Event('ended');
            Object.defineProperty(event, 'target', { value: old.element });
            if (typeof ended !== 'function') throw new Error('Expected the real plugin ended listener.');
            ended.call(old.element, event);
        };
        const next = await start('new');
        expect(next.element).not.toBe(old.element);
        const pause = vi.spyOn(next.element, 'pause');
        const hls = { destroy: vi.fn() };
        Reflect.set(player, '_hlsPlayer', hls);
        const stopped = vi.fn();
        Events.on(player, 'stopped', stopped);

        deliverOldEnded();
        deliverOldEnded();
        expect(reports.stopped).not.toHaveBeenCalled();
        expect(pause).not.toHaveBeenCalled();
        expect(hls.destroy).not.toHaveBeenCalled();
        expect(manager.playSessionId(player)).toBe('new');
        expect(Reflect.get(player, '_currentPlayOptions')).toBe(next.streamInfo);
        expect(stopped).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
            playbackIdentity: old.identity
        }));
        if (kind === 'Video') expect(stopped.mock.calls[0][1].src).toBeUndefined();

        next.element.currentTime = 25;
        next.element.muted = true;
        next.element.playbackRate = 1.5;
        next.element.dispatchEvent(new Event('ended'));
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ItemId: item.Id, PlaySessionId: 'new', PositionTicks: 250_000_000,
            IsMuted: true, PlaybackRate: 1.5
        }));
        expect(hls.destroy).toHaveBeenCalledOnce();
        expect(manager.currentItem(player)).toBeNull();
    });

    it('Video manual stop serializes a paused fractional position as integer ticks', async () => {
        const { player, manager, start } = fixture('Video');
        const { element } = await start('manual-stop');
        element.currentTime = 0.36434;
        const stopped = vi.fn();
        Events.on(player, 'stopped', stopped);

        await manager.stop(player);

        expect(stopped).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            positionMs: 364.34
        }));
        expect(reports.stopped).toHaveBeenCalledOnce();
        const wireBody = await reports.stopped.mock.results[0].value;
        expect(JSON.parse(wireBody).PositionTicks).toBe(3_643_400);
        expect(Number.isInteger(JSON.parse(wireBody).PositionTicks)).toBe(true);
        expect(manager.currentItem(player)).toBeNull();
    });

    it.each(['Audio', 'Video'] as const)('%s preserves media settings while allocating a fresh source generation', async kind => {
        const { start } = fixture(kind);
        const old = await start('same-session');
        old.element.volume = 0.25;
        old.element.muted = true;
        old.element.playbackRate = 1.25;
        const next = await start('same-session');
        expect(next.identity.generation).not.toBe(old.identity.generation);
        expect(next.element).not.toBe(old.element);
        expect(next.element.volume).toBe(0.25);
        expect(next.element.muted).toBe(true);
        expect(next.element.playbackRate).toBe(1.25);
    });

    it('Video assigns its source without waiting for the fullscreen entrance animation', async () => {
        vi.spyOn(browser, 'supportsCssAnimation').mockReturnValue(true);
        const { player, manager } = fixture('Video');
        const streamInfo = { ...options('fullscreen', 'Video'), fullscreen: true };
        manager.assignPlaybackIdentity(player, streamInfo);
        player.streamInfo = streamInfo;

        const playing = player.play(streamInfo);
        await vi.waitFor(() => {
            const element = document.querySelector<HTMLVideoElement>('video');
            expect(element).not.toBeNull();
            expect(document.querySelector<HTMLElement>('.videoPlayerContainer')?.style.animation).toContain('htmlvideoplayer-zoomin');
            expect(element?.getAttribute('src')).toBe('/same-source');
        }, { timeout: 1000 });
        await playing;
        expect(player.currentSrc()).toBe('/same-source');
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();

        const container = document.querySelector<HTMLElement>('.videoPlayerContainer');
        if (!container) throw new Error('Real plugin did not create a video container.');
        container.dispatchEvent(new Event('animationcancel'));
        container.dispatchEvent(new Event('animationend'));
        expect(player.currentSrc()).toBe('/same-source');
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    });

    it('Audio deferred fade only completes its captured generation after a new play', async () => {
        const { player, manager, start } = fixture('Audio');
        const old = await start('old');
        vi.useFakeTimers();
        const stopping = manager.stop(player);
        const next = await start('new');
        expect(next.element).not.toBe(old.element);
        const pause = vi.spyOn(next.element, 'pause');
        const audio = player as HtmlAudioPlayer;
        const hls = { destroy: vi.fn() };
        Reflect.set(audio, '_hlsPlayer', hls);

        await vi.runAllTimersAsync();
        await stopping;
        expect(pause).not.toHaveBeenCalled();
        expect(hls.destroy).not.toHaveBeenCalled();
        expect(reports.stopped).not.toHaveBeenCalled();
        expect(manager.playSessionId(player)).toBe('new');
        expect(Reflect.get(audio, '_currentPlayOptions')).toBe(next.streamInfo);
        expect(Reflect.get(audio, '_isFadingOut')).toBe(false);

        next.element.dispatchEvent(new Event('ended'));
        expect(reports.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ PlaySessionId: 'new' }));
    });

    it.each([
        ['Audio', 'stopped'], ['Video', 'stopped'],
        ['Audio', 'playbackstop'], ['Video', 'playbackstop']
    ] as const)('%s never cleans up a new play started by a synchronous %s listener', async (kind, event) => {
        const { player, manager, start } = fixture(kind);
        await start('old');
        let next: ReturnType<typeof start> | undefined;
        Events.on(event === 'stopped' ? player : manager, event, () => {
            next = start('new');
        });
        await player.stop(false);
        const started = await next;
        expect(started?.element.isConnected).toBe(true);
        expect(player.currentSrc()).toBe('/same-source');
        expect(Reflect.get(player, '_currentPlayOptions')).toBe(started?.streamInfo);
        expect(player.streamInfo).toBe(started?.streamInfo);
    });
});
