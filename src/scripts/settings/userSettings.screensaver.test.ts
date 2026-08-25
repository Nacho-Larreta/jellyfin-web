import { describe, expect, it, vi } from 'vitest';

import { UserSettings } from './userSettings';

describe('UserSettings screensaver age ceiling', () => {
    it.each([
        [ undefined, 0 ],
        [ null, 0 ],
        [ 'invalid', 0 ],
        [ '13.5', 0 ],
        [ '4', 0 ],
        [ '0', 0 ],
        [ '14', 14 ],
        [ '-1', -1 ]
    ])('normalizes persisted value %s to %s', (persisted, expected) => {
        const settings = new UserSettings();
        vi.spyOn(settings, 'get').mockReturnValue(persisted ?? null);

        expect(settings.screensaverAgeCeiling()).toBe(expected);
        expect(settings.get).toHaveBeenCalledWith('screensaverAgeCeiling', false);
    });

    it('normalizes and persists the setting in device-local storage', () => {
        const settings = new UserSettings();
        const set = vi.spyOn(settings, 'set').mockReturnValue(undefined);

        expect(settings.screensaverAgeCeiling('05')).toBe(0);
        expect(set).toHaveBeenLastCalledWith('screensaverAgeCeiling', '0', false);

        expect(settings.screensaverAgeCeiling(16)).toBe(16);
        expect(set).toHaveBeenLastCalledWith('screensaverAgeCeiling', '16', false);
    });
});
