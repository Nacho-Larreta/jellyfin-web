import { beforeEach, describe, expect, it, vi } from 'vitest';
import eventsUtils from './events';

describe('Utils: events', () => {
    describe('Method: on', () => {
        it('should throw error if object is null', () => {
            const call = () => eventsUtils.on(null, 'testEvent', vi.fn());

            expect(call).toThrowError(new Error('obj cannot be null!'));
        });

        it('should init object callbacks with testEvent type if it does not exist', () => {
            const obj = {};
            const callback = vi.fn();

            eventsUtils.on(obj, 'testEvent', callback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [callback]
            });
        });

        it('should add callback to existing object callbacks', () => {
            const initialCallback = vi.fn();
            const obj = {
                _callbacks: { testEvent: [initialCallback] }
            };
            const otherCallback = vi.fn();

            eventsUtils.on(obj, 'testEvent', otherCallback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback, otherCallback]
            });
        });
    });

    describe('Method: off', () => {
        let obj: object;
        let initialCallback: ReturnType<typeof vi.fn>;
        beforeEach(() => {
            initialCallback = vi.fn();
            obj = {
                _callbacks: {
                    testEvent: [initialCallback]
                }
            };
        });

        it('should remove existing callbacks', () => {
            eventsUtils.off(obj, 'testEvent', initialCallback);

            expect(obj).toHaveProperty('_callbacks', { testEvent: [] });
        });
        it('should not remove callback if it is not registered for the given event', () => {
            eventsUtils.off(obj, 'otherEvent', initialCallback);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback],
                otherEvent: []
            });
        });
        it('should not remove callback if it is not registered', () => {
            const callbackToRemove = vi.fn();

            eventsUtils.off(obj, 'testEvent', callbackToRemove);

            expect(obj).toHaveProperty('_callbacks', {
                testEvent: [initialCallback]
            });
        });
    });

    describe('Method: trigger', () => {
        it('should trigger registered callback with given parameters', () => {
            const obj = {};
            const callback = vi.fn();
            eventsUtils.on(obj, 'testEvent', callback);

            eventsUtils.trigger(obj, 'testEvent', ['testValue1', 'testValue2']);

            expect(callback).toHaveBeenCalledWith(
                { type: 'testEvent' },
                'testValue1',
                'testValue2'
            );
        });
    });

    describe('Method: triggerGuarded', () => {
        it('preserves receiver, arguments, order and the callback snapshot while current', () => {
            const obj = {};
            const received: string[] = [];
            const late = vi.fn();
            const first = vi.fn(function (this: object, event: { type: string }, value: string) {
                expect(this).toBe(obj);
                expect(event).toEqual({ type: 'testEvent' });
                expect(value).toBe('value');
                received.push('first');
                eventsUtils.on(obj, 'testEvent', late);
                eventsUtils.off(obj, 'testEvent', second);
            });
            const second = vi.fn(function (this: object) {
                expect(this).toBe(obj);
                received.push('second');
            });
            eventsUtils.on(obj, 'testEvent', first);
            eventsUtils.on(obj, 'testEvent', second);

            eventsUtils.triggerGuarded(obj, 'testEvent', ['value'], () => true);

            expect(received).toEqual(['first', 'second']);
            expect(late).not.toHaveBeenCalled();
        });

        it('stops permanently before the next listener when authority is revoked or throws', () => {
            const obj = {};
            const second = vi.fn();
            let current = true;
            eventsUtils.on(obj, 'testEvent', () => {
                current = false;
            });
            eventsUtils.on(obj, 'testEvent', second);

            eventsUtils.triggerGuarded(obj, 'testEvent', [], () => current);
            expect(second).not.toHaveBeenCalled();

            current = true;
            eventsUtils.triggerGuarded(obj, 'testEvent', [], () => {
                throw new Error('denied');
            });
            expect(second).not.toHaveBeenCalled();
            eventsUtils.trigger(obj, 'testEvent');
            expect(second).toHaveBeenCalledOnce();
        });

        it('delivers nothing on initial denial and preserves listener exceptions', () => {
            const obj = {};
            const first = vi.fn(() => {
                throw new Error('listener failure');
            });
            const second = vi.fn();
            eventsUtils.on(obj, 'testEvent', first);
            eventsUtils.on(obj, 'testEvent', second);

            eventsUtils.triggerGuarded(obj, 'testEvent', [], () => false);
            expect(first).not.toHaveBeenCalled();
            expect(() => eventsUtils.triggerGuarded(obj, 'testEvent', [], () => true))
                .toThrow('listener failure');
            expect(second).not.toHaveBeenCalled();
        });
    });
});
