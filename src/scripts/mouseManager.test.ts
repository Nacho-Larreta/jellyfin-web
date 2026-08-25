import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mouseManager pointer activity ownership', () => {
    const eventHandlers = new Map<string, EventListener>();
    const notifyMouseMove = vi.fn();
    const addEventListener = vi.fn((_target, eventName: string, handler: EventListener) => {
        eventHandlers.set(eventName, handler);
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.clearAllMocks();
        eventHandlers.clear();

        vi.doMock('./inputManager', () => ({
            default: { notifyMouseMove }
        }));
        vi.doMock('../components/focusManager', () => ({
            default: { focus: vi.fn(), focusableParent: vi.fn() }
        }));
        vi.doMock('./browser', () => ({
            default: { tv: false, web0s: false }
        }));
        vi.doMock('../components/layoutManager', () => ({
            default: { mobile: false, tv: false }
        }));
        vi.doMock('../utils/dom', () => ({
            default: {
                addEventListener,
                removeEventListener: vi.fn()
            }
        }));
        vi.doMock('../utils/events.ts', () => ({
            default: { on: vi.fn(), trigger: vi.fn() }
        }));
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('suspends the global idle clock while the player owns pointer activity', async () => {
        const mouseManager = await import('./mouseManager');
        const pointerActivityOwner = vi.fn(() => true);

        expect(vi.getTimerCount()).toBe(1);

        const releaseOwnership = mouseManager.claimPointerActivity(pointerActivityOwner);

        expect(vi.getTimerCount()).toBe(0);

        const pointerMoveHandler = eventHandlers.get('pointermove') ?? eventHandlers.get('mousemove');
        pointerMoveHandler?.({
            pointerType: 'mouse',
            screenX: 10,
            screenY: 20
        } as unknown as Event);

        expect(pointerActivityOwner).toHaveBeenCalledTimes(1);
        expect(notifyMouseMove).toHaveBeenCalledTimes(1);
        expect(() => mouseManager.claimPointerActivity(vi.fn())).toThrow(
            'Pointer activity already has an owner'
        );

        releaseOwnership();

        expect(vi.getTimerCount()).toBe(1);
    });
});
