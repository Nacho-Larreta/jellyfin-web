import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: { getApiClient: vi.fn() } }));
vi.mock('scripts/browser', () => ({ default: { slow: false, tv: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlayingLocally: vi.fn(() => false) } }));
vi.mock('scripts/settings/userSettings', () => ({ enableBackdrops: vi.fn(() => true) }));
vi.mock('utils/dom', () => ({ default: { getScreenWidth: () => 1920 } }));

import browser from '../../scripts/browser';
import { playbackManager } from '../playback/playbackmanager';
import * as userSettings from '../../scripts/settings/userSettings';
import { acquireBackdropOwner, clearBackdrop, setBackdrop, setBackdropImages, setBackdrops } from './backdrop';

const loads = [];

class ControlledImage {
    constructor() {
        loads.push(this);
    }

    set src(value) {
        this.url = value;
    }

    load() {
        this.onload?.();
    }
}

function visibleUrls() {
    return Array.from(document.querySelectorAll('.backdropImage')).map(element => element.getAttribute('data-url'));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', ControlledImage);
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>';
    clearBackdrop();
    loads.length = 0;
    browser.tv = false;
    vi.mocked(playbackManager.isPlayingLocally).mockReturnValue(false);
    vi.mocked(userSettings.enableBackdrops).mockReturnValue(true);
});

afterEach(() => {
    clearBackdrop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('shared backdrop owner', () => {
    it('disposes a visible owner after its React containers unmount without recreating them', () => {
        const onInvalidate = vi.fn();
        const owner = acquireBackdropOwner(() => true, onInvalidate);
        owner.setImages(['blob:old'], ['blob:old']);
        loads[0].load();
        const detachedBackdrop = document.querySelector('.backdropContainer');
        const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
            expect(detachedBackdrop.querySelector('.backdropImage')).toBeNull();
        });
        const queued = loads[0].onload;
        document.body.replaceChildren();

        try {
            expect(() => owner.dispose()).not.toThrow();
            owner.dispose();
            queued();
            expect(document.querySelector('.backdropContainer')).toBeNull();
            expect(document.querySelector('.backgroundContainer')).toBeNull();
            expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:old');
            expect(onInvalidate).toHaveBeenCalledOnce();
        } finally {
            document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>';
        }

        setBackdrop('successor');
        loads[1].load();
        expect(visibleUrls()).toEqual(['successor']);
        expect(document.querySelector('.backgroundContainer').classList.contains('withBackdrop')).toBe(true);
    });

    it('removes old pixels before successor and ignores queued old Image callbacks', () => {
        const revoked = vi.spyOn(URL, 'revokeObjectURL');
        const old = acquireBackdropOwner(() => true);
        old.setImages(['blob:A'], ['blob:A']);
        loads[0].load();
        expect(visibleUrls()).toEqual(['blob:A']);
        const queued = loads[0].onload;

        const successor = acquireBackdropOwner(() => true);
        expect(visibleUrls()).toEqual([]);
        expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:A');
        successor.setImages(['blob:B'], ['blob:B']);
        loads[1].load();
        queued();
        old.dispose();
        vi.advanceTimersByTime(1600);

        expect(visibleUrls()).toEqual(['blob:B']);
        expect(revoked).not.toHaveBeenCalledWith('blob:B');
        successor.dispose();
        successor.dispose();
        expect(revoked.mock.calls.filter(([url]) => url === 'blob:B')).toHaveLength(1);
    });

    it('transfers ownership for identical legacy URLs and preserves disabled no-op', () => {
        const old = acquireBackdropOwner(() => true);
        old.setImages(['same']);
        const queued = loads[0].onload;
        setBackdropImages(['same']);
        queued();
        loads[1].load();
        expect(visibleUrls()).toEqual(['same']);
        expect(old.isCurrent()).toBe(false);

        vi.mocked(userSettings.enableBackdrops).mockReturnValue(false);
        setBackdrops([]);
        expect(visibleUrls()).toEqual(['same']);
    });

    it('does not let old rotation or delayed removal erase a successor, and respects video pause and TV mode', () => {
        const first = acquireBackdropOwner(() => true);
        first.setImages(['one', 'two']);
        loads[0].load();
        vi.mocked(playbackManager.isPlayingLocally).mockReturnValue(true);
        vi.advanceTimersByTime(10000);
        expect(loads).toHaveLength(1);
        vi.mocked(playbackManager.isPlayingLocally).mockReturnValue(false);
        vi.advanceTimersByTime(10000);
        loads[1].load();
        expect(visibleUrls()).toEqual(['one', 'two']);

        const second = acquireBackdropOwner(() => true);
        second.setImages(['successor']);
        loads[2].load();
        vi.advanceTimersByTime(12000);
        expect(visibleUrls()).toEqual(['successor']);

        browser.tv = true;
        const tv = acquireBackdropOwner(() => true);
        tv.setImages(['tv-one', 'tv-two']);
        loads[3].load();
        vi.advanceTimersByTime(20000);
        expect(loads).toHaveLength(4);
        expect(visibleUrls()).toEqual(['tv-one']);
    });

    it('permanently retires an owner whose authority predicate throws', () => {
        let valid = true;
        const old = acquireBackdropOwner(() => {
            if (!valid) throw new Error('stale');
        });
        old.setImages(['blob:old'], ['blob:old']);
        loads[0].load();
        valid = false;
        expect(old.setImages(['blob:late'])).toBe(false);
        expect(old.isCurrent()).toBe(false);
        expect(visibleUrls()).toEqual([]);
        valid = true;
        expect(old.setImages(['blob:resurrected'])).toBe(false);
    });

    it('keeps the legacy single-backdrop behavior while local video is playing', () => {
        vi.mocked(playbackManager.isPlayingLocally).mockReturnValue(true);
        setBackdrop('direct-background');
        expect(loads).toHaveLength(1);
        loads[0].load();
        expect(visibleUrls()).toEqual(['direct-background']);
    });
});
