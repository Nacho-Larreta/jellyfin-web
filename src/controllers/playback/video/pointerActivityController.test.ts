import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PlayerPointerActivityController,
    PLAYER_AUTOHIDE_DELAY_MS
} from './pointerActivityController';

describe('PlayerPointerActivityController', () => {
    const reveal = vi.fn();
    const conceal = vi.fn();
    const showCursor = vi.fn();
    let canAutohide = true;
    let controller: PlayerPointerActivityController;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        canAutohide = true;
        controller = new PlayerPointerActivityController({
            reveal,
            conceal,
            showCursor,
            canAutohide: () => canAutohide
        });
    });

    afterEach(() => {
        controller.stop();
        vi.useRealTimers();
    });

    it('keeps cursor and controls on one clock across fullscreen lifecycle', () => {
        controller.start();

        expect(reveal).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        controller.onFullscreenChange();
        expect(reveal).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(PLAYER_AUTOHIDE_DELAY_MS);
        expect(conceal).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        controller.onPointerMove({ screenX: 100, screenY: 100 });
        expect(reveal).toHaveBeenCalledTimes(3);
        expect(showCursor).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(PLAYER_AUTOHIDE_DELAY_MS - 1);
        controller.onPointerMove({ screenX: 101, screenY: 100 });
        expect(reveal).toHaveBeenCalledTimes(4);
        expect(showCursor).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(PLAYER_AUTOHIDE_DELAY_MS - 1);
        expect(conceal).toHaveBeenCalledTimes(1);

        controller.onControlsActivity();
        expect(reveal).toHaveBeenCalledTimes(5);
        expect(showCursor).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        controller.onFullscreenChange();
        controller.onFullscreenChange();
        expect(reveal).toHaveBeenCalledTimes(7);
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(PLAYER_AUTOHIDE_DELAY_MS);
        expect(conceal).toHaveBeenCalledTimes(2);
    });

    it('ignores stationary and touch pointer events without disrupting their owners', () => {
        controller.start();
        reveal.mockClear();

        controller.onPointerMove({ screenX: 20, screenY: 30 });
        controller.onPointerMove({ screenX: 20, screenY: 30 });
        controller.onPointerMove({ screenX: 21, screenY: 30 });
        controller.onPointerMove({ screenX: 22, screenY: 30, pointerType: 'touch' });

        expect(reveal).toHaveBeenCalledTimes(2);
        expect(showCursor).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('cancels the clock while controls cannot autohide and resumes with one clock', () => {
        controller.start();
        canAutohide = false;
        controller.resetAutohideClock();

        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(PLAYER_AUTOHIDE_DELAY_MS);
        expect(conceal).not.toHaveBeenCalled();

        canAutohide = true;
        controller.onControlsActivity();
        controller.onControlsActivity();

        expect(vi.getTimerCount()).toBe(1);

        controller.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
