import { describe, expect, it, vi } from 'vitest';

import {
    activateProfile,
    clearProfilePin,
    setProfilePin
} from './api';

function createApiClient() {
    return {
        ajax: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) }),
        getUrl: vi.fn(path => `/api/${path}`)
    };
}

describe('Profile selector PIN API boundaries', () => {
    it('serializes a leading-zero activation PIN exactly', async () => {
        const apiClient = createApiClient();

        await activateProfile(apiClient, 'profile-id', '0012');

        expect(apiClient.ajax).toHaveBeenCalledWith(expect.objectContaining({
            data: '{"Pin":"0012"}'
        }));
    });

    it('serializes a valid set PIN exactly', async () => {
        const apiClient = createApiClient();

        await setProfilePin(apiClient, 'owner-id', 'profile-id', '01234567');

        expect(apiClient.ajax).toHaveBeenCalledWith(expect.objectContaining({
            data: '{"Pin":"01234567"}'
        }));
    });

    it('serializes a valid clear PIN exactly', async () => {
        const apiClient = createApiClient();

        await clearProfilePin(apiClient, 'owner-id', 'profile-id', '0001');

        expect(apiClient.ajax).toHaveBeenCalledWith(expect.objectContaining({
            data: '{"Pin":"0001"}'
        }));
    });

    it('preserves missing activation and clear PIN semantics without serializing an empty PIN', async () => {
        const activationClient = createApiClient();
        await activateProfile(activationClient, 'profile-id', null);
        expect(activationClient.ajax).toHaveBeenCalledWith(expect.objectContaining({ data: '{}' }));

        const clearClient = createApiClient();
        await clearProfilePin(clearClient, 'owner-id', 'profile-id', null);
        expect(clearClient.ajax).toHaveBeenCalledWith(expect.not.objectContaining({ data: expect.anything() }));
    });

    it.each([ '123', '123456789', '１２３４', '12٣4', '12a4', '12 4', '' ])('rejects invalid PIN payload %s', async pin => {
        const apiClient = createApiClient();

        await expect(setProfilePin(apiClient, 'owner-id', 'profile-id', pin)).rejects.toThrow(TypeError);
        expect(apiClient.ajax).not.toHaveBeenCalled();
    });
});
