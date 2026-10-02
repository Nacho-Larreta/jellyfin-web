import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Events from '../../../utils/events';
import { createPlaybackIdentity } from '../../../components/htmlMediaLifecycle';
import type { PlaybackManager } from '../../../components/playback/playbackmanager';

const harness = vi.hoisted(() => ({
    manager: null as PlaybackManager | null,
    router: null as null | {
        ready: () => Promise<void>;
        back: () => Promise<void>;
        promiseShow: Promise<void> | null;
    },
    promiseShow: null as Promise<void> | null,
    historyBack: vi.fn(),
    back: vi.fn(async () => {
        if (harness.promiseShow) await harness.promiseShow;
        harness.historyBack();
    }),
    ready: vi.fn(() => harness.promiseShow || Promise.resolve()),
    players: [] as unknown[]
}));
const routerHistory = vi.hoisted(() => ({
    location: { pathname: '/video', search: '' },
    listen: vi.fn(() => () => undefined),
    back: vi.fn()
}));

vi.mock('../../../components/playback/playbackmanager', () => ({
    get playbackManager() {
        return harness.manager;
    }
}));
vi.mock('../../../components/router/appRouter', () => ({ appRouter: {
    back: () => harness.router?.back(),
    ready: () => harness.router?.ready(),
    get promiseShow() {
        return harness.router?.promiseShow;
    },
    goHome: vi.fn()
} }));
vi.mock('RootAppRouter', () => ({ history: routerHistory }));
vi.mock('../../../components/pluginManager', () => ({ pluginManager: {
    ofType: () => harness.players,
    firstOfType: () => null
} }));
vi.mock('../../../components/apphost', () => ({ appHost: { supports: () => false } }));
vi.mock('../../../components/alert', () => ({ default: () => undefined }));
vi.mock('../../../components/loading/loading', () => ({ default: { hide: vi.fn() } }));
vi.mock('hooks/useItem', () => ({ getItemQuery: vi.fn() }));
vi.mock('utils/jellyfin-apiclient/compat', () => ({ toApi: vi.fn() }));
vi.mock('utils/query/queryClient', () => ({ queryClient: {} }));
vi.mock('../../../components/mediainfo/mediainfo', () => ({ default: { getSecondaryMediaInfoHtml: () => '' } }));
vi.mock('../../../components/subtitlesync/subtitlesync', () => ({ default: class {} }));
vi.mock('../../../scripts/libraryMenu', () => ({ default: { setTitle: vi.fn() } }));
vi.mock('../../../components/focusManager', () => ({ default: {} }));
vi.mock('../../../components/layoutManager', () => ({ default: { tv: false, mobile: false } }));
vi.mock('../../../components/playback/skipsegment.ts', () => ({ bindSkipSegment: () => undefined }));
vi.mock('apps/stable/features/playback/utils/mediaSegmentManager', () => ({ bindMediaSegmentManager: () => undefined }));
vi.mock('apps/stable/features/playback/utils/mediaSessionSubscriber', () => ({ bindMediaSessionSubscriber: () => undefined }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: () => ({ reportPlaybackStopped: vi.fn(async () => undefined) })
    }
}));
vi.mock('../../../scripts/mouseManager', () => ({ default: {
    claimPointerActivity: () => () => undefined,
    showCursor: vi.fn()
} }));
vi.mock('../../../scripts/inputManager', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../../scripts/shell', () => ({ default: { enableFullscreen: vi.fn(), disableFullscreen: vi.fn() } }));
vi.mock('../../../utils/dom', () => ({ default: {
    whichTransitionEvent: () => 'transitionend',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
} }));
vi.mock('./pointerActivityController.ts', () => ({ PlayerPointerActivityController: class {
    start() { return undefined; }
    stop() { return undefined; }
} }));
vi.mock('../../../components/backdrop/backdrop', () => ({
    setBackdropTransparency: vi.fn(),
    ['TRANSPARENCY_LEVEL']: { Full: 1, None: 0 }
}));
vi.mock('../../../styles/scrollstyles.scss', () => ({}));
vi.mock('../../../styles/videoosd.scss', () => ({}));
vi.mock('../../../elements/emby-slider/emby-slider', () => ({}));
vi.mock('../../../elements/emby-button/paper-icon-button-light', () => ({}));
vi.mock('../../../elements/emby-ratingbutton/emby-ratingbutton', () => ({}));

const item = { Id: 'movie', ServerId: 'server', MediaType: 'Video' };

function stream(playItem = item, playSessionId = 'session') {
    return {
        item: playItem,
        playSessionId,
        mediaSource: null,
        playbackIdentity: createPlaybackIdentity({ item: playItem, playSessionId }),
        started: true,
        ended: false
    };
}

function htmlPlayer() {
    const player = {
        name: 'HTML Video Player',
        id: 'html-video',
        isLocalPlayer: true,
        supportsPlaybackLifecycle: true,
        canPlayMediaType: () => true,
        streamInfo: stream() as ReturnType<typeof stream> | null,
        currentSrc: () => 'video',
        currentTime: () => 25,
        duration: () => 100,
        volume: () => 100,
        isMuted: () => false,
        paused: () => false,
        maxStreamingBitrate: 120_000_000,
        destroy: vi.fn(),
        stop: vi.fn(async () => Events.trigger(player, 'stopped', [{ src: undefined, playbackIdentity: player.streamInfo?.playbackIdentity }]))
    };
    return player;
}

function videoView() {
    const view = document.createElement('div');
    const control = document.createElement('button');
    const ratingControl = document.createElement('div');
    Object.assign(control, { enableKeyboardDragging: vi.fn() });
    vi.spyOn(view, 'querySelector').mockImplementation(selector => selector === '.btnUserRating' ? ratingControl : control);
    return view;
}

async function flushNavigation() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('video route after an HTML playback stop', () => {
    let view: ReturnType<typeof videoView>;
    let manager: PlaybackManager;
    let player: ReturnType<typeof htmlPlayer>;

    beforeEach(async () => {
        harness.back.mockClear();
        harness.historyBack.mockClear();
        harness.promiseShow = null;
        harness.ready.mockReset().mockImplementation(() => harness.promiseShow || Promise.resolve());
        harness.router = {
            ready: () => harness.ready(),
            back: () => harness.back(),
            get promiseShow() {
                return harness.promiseShow;
            }
        };
        const header = document.createElement('header');
        header.className = 'skinHeader';
        document.body.replaceChildren(header);
        const { PlaybackManager } = await vi.importActual<typeof import('../../../components/playback/playbackmanager')>(
            '../../../components/playback/playbackmanager'
        );
        player = htmlPlayer();
        harness.players = [player];
        manager = new PlaybackManager();
        harness.manager = manager;
        manager.setActivePlayer(player);
        view = videoView();
        const { default: createController } = await import('./index');
        createController(view);
        const playerState = vi.spyOn(manager, 'getPlayerState').mockReturnValue({ NowPlayingItem: null });
        view.dispatchEvent(new Event('viewshow'));
        playerState.mockRestore();
    });

    afterEach(() => {
        view.dispatchEvent(new Event('viewbeforehide'));
        harness.manager = null;
        harness.router = null;
        harness.promiseShow = null;
        harness.players = [];
    });

    it.each(['explicit stop', 'natural end'])('returns once after %s cleans up before playbackstop', async ending => {
        const order: string[] = [];
        let stopInfo: unknown;
        Events.on(manager, 'playerchange', () => order.push('playerchange'));
        Events.on(manager, 'playbackstop', (_event, info) => {
            order.push('playbackstop');
            stopInfo = info;
        });
        expect(Reflect.get(player, '_callbacks').stopped).toHaveLength(1);

        if (ending === 'explicit stop') {
            await manager.stop(player);
        } else {
            Events.trigger(player, 'stopped', [{ src: undefined, playbackIdentity: player.streamInfo?.playbackIdentity }]);
        }
        await flushNavigation();

        expect(order).toEqual(['playerchange', 'playbackstop']);
        expect(stopInfo).toEqual(expect.objectContaining({ playbackIdentity: expect.any(Object) }));
        expect(harness.back).toHaveBeenCalledOnce();
        Events.trigger(manager, 'playbackstop', [stopInfo]);
        await flushNavigation();
        expect(harness.back).toHaveBeenCalledOnce();
    });

    it('ignores a stale stop after the same player starts a new generation', async () => {
        const oldIdentity = player.streamInfo?.playbackIdentity;
        player.streamInfo = stream();
        Events.trigger(player, 'playbackstart', [{ NowPlayingItem: null }]);

        Events.trigger(manager, 'playbackstop', [{ player, playbackIdentity: oldIdentity, nextMediaType: null }]);
        await flushNavigation();

        expect(harness.back).not.toHaveBeenCalled();
    });

    it('keeps the route for the next video and ignores the old player after a replacement', async () => {
        const oldIdentity = player.streamInfo?.playbackIdentity;
        Events.trigger(manager, 'playbackstop', [{ player, playbackIdentity: oldIdentity, nextMediaType: 'Video' }]);

        const nextPlayer = htmlPlayer();
        nextPlayer.id = 'next-html-video';
        const playerState = vi.spyOn(manager, 'getPlayerState').mockReturnValue({ NowPlayingItem: null });
        manager.setActivePlayer(nextPlayer);
        playerState.mockRestore();
        Events.trigger(manager, 'playbackstop', [{ player, playbackIdentity: oldIdentity, nextMediaType: null }]);
        await flushNavigation();

        expect(harness.back).not.toHaveBeenCalled();
    });

    it('cancels pending return when a newer execution starts before navigation', async () => {
        let releaseReady!: () => void;
        harness.ready.mockImplementationOnce(() => new Promise<void>(resolve => {
            releaseReady = resolve;
        }));
        const oldIdentity = player.streamInfo?.playbackIdentity;
        Events.trigger(manager, 'playbackstop', [{ player, playbackIdentity: oldIdentity, nextMediaType: null }]);
        player.streamInfo = stream();
        Events.trigger(player, 'playbackstart', [{ NowPlayingItem: null }]);
        releaseReady();
        await flushNavigation();

        expect(harness.back).not.toHaveBeenCalled();
    });

    it('does not queue a back behind a second route transition', async () => {
        const { appRouter: realRouter } = await vi.importActual<typeof import('../../../components/router/appRouter')>(
            '../../../components/router/appRouter'
        );
        harness.router = realRouter;
        routerHistory.back.mockClear();
        let finishFirst!: () => void;
        let finishSecond!: () => void;
        const firstTransition = new Promise<void>(resolve => {
            finishFirst = resolve;
        });
        const secondTransition = new Promise<void>(resolve => {
            finishSecond = resolve;
        });
        realRouter.promiseShow = firstTransition;
        void firstTransition.then(() => {
            realRouter.promiseShow = secondTransition;
        });

        Events.trigger(manager, 'playbackstop', [{
            player,
            playbackIdentity: player.streamInfo?.playbackIdentity,
            nextMediaType: null
        }]);
        finishFirst();
        await flushNavigation();

        expect(routerHistory.back).not.toHaveBeenCalled();
        finishSecond();
        await flushNavigation();
        expect(routerHistory.back).not.toHaveBeenCalled();
        realRouter.promiseShow = null;
    });

    it('does not navigate after the route is hidden', async () => {
        const identity = player.streamInfo?.playbackIdentity;
        view.dispatchEvent(new Event('viewbeforehide'));
        Events.trigger(manager, 'playbackstop', [{ player, playbackIdentity: identity, nextMediaType: null }]);
        await flushNavigation();

        expect(harness.back).not.toHaveBeenCalled();
    });

    it('removes its manager listener on repeated teardown', async () => {
        const callbacks = Reflect.get(manager, '_callbacks').playbackstop;
        expect(callbacks).toHaveLength(1);

        view.dispatchEvent(new Event('viewbeforehide'));
        view.dispatchEvent(new Event('viewbeforehide'));

        expect(callbacks).toHaveLength(0);
    });
});
