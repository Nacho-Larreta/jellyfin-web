import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from 'jellyfin-apiclient';

import { LegacyProfileSwitchApi } from './api';
import { CommitUnknownError, DeterministicSwitchRejectionError } from './model';

function createClient() {
    return {
        ajax: vi.fn().mockResolvedValue({
            headers: { get: vi.fn(() => 'Tue, 01 Jan 2030 00:00:00 GMT') },
            json: vi.fn().mockResolvedValue({
                SwitchId: 'switch-1',
                TargetProfileUserId: 'target-1',
                State: 'Prepared',
                PreparedExpiresUtc: '2030-01-01T00:01:00Z',
                AuthenticationResult: null
            })
        }),
        getUrl: vi.fn((path: string) => `/api/${path}`)
    };
}

describe('LegacyProfileSwitchApi', () => {
    it('sends Prepare with the exact switch id, target and leading-zero PIN', async () => {
        const client = createClient();
        const api = new LegacyProfileSwitchApi(client);

        await api.prepare({ switchId: 'switch-1', targetProfileUserId: 'target-1', pin: '0012' });

        const deadline = (await api.status('switch-1')).preparedExpiresAtMs;
        expect(deadline).toBeGreaterThan(Date.now() + 58_000);
        expect(deadline).toBeLessThanOrEqual(Date.now() + 59_000);

        expect(client.ajax).toHaveBeenCalledWith({
            type: 'POST',
            url: '/api/ProfileSelectors/Current/Switches/switch-1/Prepare',
            contentType: 'application/json',
            data: '{"TargetProfileUserId":"target-1","Pin":"0012"}'
        });
    });

    it('maps committed authentication without exposing any additional response fields', async () => {
        const client = createClient();
        client.ajax.mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                SwitchId: 'switch-1',
                TargetProfileUserId: 'target-1',
                State: 'Committed',
                AuthenticationResult: {
                    AccessToken: 'target-token',
                    User: { Id: 'target-1', Name: 'Target' },
                    ServerId: 'ignored'
                }
            })
        });

        const result = await new LegacyProfileSwitchApi(client).commit('switch-1');

        expect(result.authentication).toEqual({ accessToken: 'target-token', userId: 'target-1' });
        expect(result).not.toHaveProperty('ServerId');
    });

    it('does not authorize a playback stop when server Date is unavailable', async () => {
        const client = createClient();
        client.ajax.mockResolvedValueOnce({
            json: vi.fn().mockResolvedValue({
                SwitchId: 'switch-1', TargetProfileUserId: 'target-1', State: 'Prepared',
                PreparedExpiresUtc: '2030-01-01T00:01:00Z', AuthenticationResult: null
            })
        });

        await expect(new LegacyProfileSwitchApi(client).status('switch-1'))
            .resolves.toMatchObject({ preparedExpiresAtMs: null, preparedExpiresAtMonotonicMs: null });
    });

    it('receives Date through the pinned legacy API client Response, not an auto-parsed JSON value', async () => {
        const nativeFetch = globalThis.fetch;
        const fetch = vi.fn(async () => ({
            status: 200,
            headers: { get: (name: string) => name === 'Date' ? 'Tue, 01 Jan 2030 00:00:00 GMT' : 'application/json' },
            json: async () => ({
                SwitchId: 'switch-1', TargetProfileUserId: 'target-1', State: 'Prepared',
                PreparedExpiresUtc: '2030-01-01T00:01:00Z', AuthenticationResult: null
            })
        }));
        vi.stubGlobal('fetch', fetch);
        try {
            const client = new ApiClient('http://local.test', 'Jellyfin Web', '1', 'Browser', 'device-1');
            const result = await new LegacyProfileSwitchApi(client).status('switch-1');
            expect(result.preparedExpiresAtMs).toBeGreaterThan(Date.now() + 58_000);
            expect(fetch).toHaveBeenCalledOnce();
        } finally {
            vi.stubGlobal('fetch', nativeFetch);
        }
    });

    it.each([
        [ 'network loss', new TypeError('network') ],
        [ 'timeout response', { status: 408 } ],
        [ 'server error', { status: 503 } ],
        [ 'cancellation after send', { name: 'AbortError' } ]
    ])('classifies %s after Commit send as CommitUnknown', async (_label, failure) => {
        const client = createClient();
        client.ajax.mockRejectedValue(failure);

        await expect(new LegacyProfileSwitchApi(client).commit('switch-1'))
            .rejects.toBeInstanceOf(CommitUnknownError);
    });

    it('keeps a deterministic 4xx rejection distinct from CommitUnknown', async () => {
        const client = createClient();
        client.ajax.mockRejectedValue({ status: 409 });

        await expect(new LegacyProfileSwitchApi(client).commit('switch-1'))
            .rejects.toEqual(expect.objectContaining<Partial<DeterministicSwitchRejectionError>>({
                name: 'DeterministicSwitchRejectionError',
                status: 409
            }));
    });

    it('rejects malformed committed responses instead of installing partial credentials', async () => {
        const client = createClient();
        client.ajax.mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                SwitchId: 'switch-1',
                TargetProfileUserId: 'target-1',
                State: 'Committed',
                AuthenticationResult: { User: { Id: 'target-1' } }
            })
        });

        await expect(new LegacyProfileSwitchApi(client).status('switch-1')).rejects.toThrow(TypeError);
    });
});
