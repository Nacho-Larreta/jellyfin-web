import { describe, expect, it, vi } from 'vitest';

import { UserSettings } from './userSettings';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('UserSettings login publication', () => {
    it('ignores preferences from a previous user after a newer binding wins', async () => {
        const settings = new UserSettings();
        const oldPreferences = deferred<{ CustomPrefs: { theme: string } }>();
        const newPreferences = deferred<{ CustomPrefs: { theme: string } }>();
        const oldClient = { getDisplayPreferences: vi.fn(() => oldPreferences.promise) };
        const newClient = { getDisplayPreferences: vi.fn(() => newPreferences.promise) };

        const oldPublication = settings.setUserInfo('old-user', oldClient);
        const newPublication = settings.setUserInfo('new-user', newClient);
        oldPreferences.resolve({ CustomPrefs: { theme: 'old' } });
        await oldPublication;
        expect(settings.displayPrefs).toBeNull();

        newPreferences.resolve({ CustomPrefs: { theme: 'new' } });
        await newPublication;
        expect(settings.currentUserId).toBe('new-user');
        expect(settings.displayPrefs?.CustomPrefs.theme).toBe('new');
    });

    it('does not restore preferences after logout or invalidated authority', async () => {
        const settings = new UserSettings();
        const preferences = deferred<{ CustomPrefs: { theme: string } }>();
        const client = { getDisplayPreferences: vi.fn(() => preferences.promise) };
        const publication = settings.setUserInfo('old-user', client);

        await settings.setUserInfo(null, null);
        preferences.resolve({ CustomPrefs: { theme: 'old' } });
        await publication;
        expect(settings.currentUserId).toBeNull();
        expect(settings.displayPrefs).toBeNull();

        const invalidated = deferred<{ CustomPrefs: { theme: string } }>();
        client.getDisplayPreferences.mockReturnValue(invalidated.promise);
        const guarded = settings.setUserInfo('old-user', client, () => {
            throw new Error('authority revoked');
        });
        invalidated.resolve({ CustomPrefs: { theme: 'old' } });
        await expect(guarded).rejects.toThrow('authority revoked');
        expect(settings.displayPrefs).toBeNull();
    });
});
