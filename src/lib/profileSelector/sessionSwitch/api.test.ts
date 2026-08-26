import { describe, expect, it, vi } from 'vitest';

import { LegacyProfileSwitchApi } from './api';
import { CommitUnknownError, DeterministicSwitchRejectionError } from './model';

function createClient() {
    return {
        ajax: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                SwitchId: 'switch-1',
                TargetProfileUserId: 'target-1',
                State: 'Prepared',
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
