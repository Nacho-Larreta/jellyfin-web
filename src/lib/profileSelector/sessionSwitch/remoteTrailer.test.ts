import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';
import type { ApiClient } from 'jellyfin-apiclient';
import { describe, expect, it, vi } from 'vitest';

import type { BoundSessionReadPort } from './boundRequests';
import { playBoundTrailer } from './remoteTrailer';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

const client = {} as ApiClient;
const item = { Id: 'movie-a', ServerId: 'server-a', Name: 'Movie A' } as BaseItemDto;

function createHarness() {
    let current = true;
    const delivery = { isCurrent: () => current };
    const port = {
        binding: { serverId: 'server-a', profileUserId: 'user-a' },
        assertCurrent: () => {
            if (!current) throw new Error('stale');
        }
    } as BoundSessionReadPort;
    const captureRead = vi.fn(() => port);
    const play = vi.fn();
    const read = vi.fn();
    const createRead = vi.fn(() => ({ getItems: read }));
    const run = () => playBoundTrailer(client, 'movie-a', delivery, captureRead, play, createRead);
    return { captureRead, createRead, play, read, run, revoke: () => {
        current = false;
    } };
}

describe('playBoundTrailer', () => {
    it('uses one bound user and plays only the exact server item', async () => {
        const harness = createHarness();
        harness.read.mockResolvedValue({ Items: [item], TotalRecordCount: 1 });

        await harness.run();

        expect(harness.read).toHaveBeenCalledWith({
            userId: 'user-a', ids: ['movie-a'], limit: 2
        });
        expect(harness.play).toHaveBeenCalledOnce();
        expect(harness.play).toHaveBeenCalledWith(item);
    });

    it('rejects a late result after switch or logout', async () => {
        const harness = createHarness();
        const pending = deferred<{ Items: BaseItemDto[]; TotalRecordCount: number }>();
        harness.read.mockReturnValue(pending.promise);
        const continuation = harness.run();
        harness.revoke();
        pending.resolve({ Items: [item], TotalRecordCount: 1 });
        await continuation;

        expect(harness.play).not.toHaveBeenCalled();
    });

    it.each([
        { Items: [], TotalRecordCount: 0 },
        { Items: [item, item], TotalRecordCount: 2 },
        { Items: [item], TotalRecordCount: 2 },
        { Items: [{ ...item, Id: 'other' }], TotalRecordCount: 1 },
        { Items: [{ ...item, ServerId: 'server-b' }], TotalRecordCount: 1 }
    ])('rejects missing, ambiguous or wrong-binding results %#', async result => {
        const harness = createHarness();
        harness.read.mockResolvedValue(result);

        await harness.run();

        expect(harness.play).not.toHaveBeenCalled();
    });

    it('does not expose a stale read failure to the successor', async () => {
        const harness = createHarness();
        harness.read.mockRejectedValue(new Error('old read failed'));
        await expect(harness.run()).resolves.toBeUndefined();
        expect(harness.play).not.toHaveBeenCalled();
    });
});
