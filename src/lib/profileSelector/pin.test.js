import { describe, expect, it, vi } from 'vitest';

import {
    assertValidProfilePin,
    isValidProfilePin,
    requestValidProfilePin
} from './pin';

describe('Profile selector PIN validation', () => {
    it.each([
        [ '123', false ],
        [ '0123', true ],
        [ '01234567', true ],
        [ '012345678', false ],
        [ '１２３４', false ],
        [ '12٣4', false ],
        [ '12a4', false ],
        [ '12 4', false ],
        [ '', false ],
        [ null, false ],
        [ undefined, false ]
    ])('accepts only 4 to 8 ASCII digits: %s', (pin, expected) => {
        expect(isValidProfilePin(pin)).toBe(expected);
    });

    it('preserves a valid PIN verbatim', () => {
        expect(assertValidProfilePin('0012')).toBe('0012');
    });

    it('rejects empty and invalid PIN values without coercion', () => {
        expect(() => assertValidProfilePin('')).toThrow(TypeError);
        expect(() => assertValidProfilePin('١٢٣٤')).toThrow(TypeError);
        expect(() => assertValidProfilePin(' 1234')).toThrow(TypeError);
    });

    it('keeps prompting after an invalid value and returns the valid string exactly', async () => {
        const requestPin = vi.fn()
            .mockResolvedValueOnce('123')
            .mockResolvedValueOnce('0012');
        const onInvalidPin = vi.fn().mockResolvedValue(undefined);

        await expect(requestValidProfilePin(requestPin, onInvalidPin)).resolves.toBe('0012');
        expect(onInvalidPin).toHaveBeenCalledOnce();
    });

    it('returns null when the PIN prompt is cancelled', async () => {
        await expect(requestValidProfilePin(vi.fn().mockRejectedValue(new Error('cancelled')), vi.fn())).resolves.toBeNull();
    });
});
