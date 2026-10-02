import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JellyfinApiContext } from 'hooks/useApi';
import { SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';

import {
    useClearSearchHistory,
    useExploreGenres,
    useRecordSearchHistory,
    useSearchHistory
} from './useSearchDiscovery';

let publishedContext: JellyfinApiContext;

type SelectorState = {
    IsEnabled: boolean;
    OwnerUserId: string;
    CurrentDeviceProfileUserId: string;
    Profiles: { ProfileUserId: string; IsActive: boolean; IsVisible: boolean }[];
};

const selectorRequest = vi.hoisted(() => vi.fn<() => Promise<SelectorState | null>>());

vi.mock('hooks/useApi', () => ({ useApi: () => publishedContext }));
vi.mock('lib/profileSelector/api', () => ({ getCurrentProfileSelector: selectorRequest }));
vi.mock('utils/query/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn() } }));

const serverId = 'server-1';
const profileUserId = 'child-1';
const historyPath = 'Users/owner-1/Profiles/child-1/Search/History';

const selector: SelectorState = {
    IsEnabled: true,
    OwnerUserId: 'owner-1',
    CurrentDeviceProfileUserId: profileUserId,
    Profiles: [{ ProfileUserId: profileUserId, IsActive: true, IsVisible: true }]
};

const createClient = () => ({
    serverId: () => serverId,
    getUrl: vi.fn((path: string) => path),
    getJSON: vi.fn(async (path: string) => {
        if (path.includes('/Explore/Genres')) return { Items: [{ Name: 'Drama' }] };
        if (path.includes('/Search/History')) return [{ SearchTerm: 'Drama', HitCount: 1, LastSearchedUtc: '2026-10-02' }];
        throw new Error('Unexpected request');
    }),
    ajax: vi.fn(async (): Promise<void> => undefined)
});

type Client = ReturnType<typeof createClient>;

function published(client: Client, epoch: number, assertCurrent: () => void): JellyfinApiContext {
    const identity = { serverId, profileUserId, sessionEpoch: epoch, authorityGeneration: `${epoch}:current` };
    return {
        __legacyApiClient__: client as unknown as JellyfinApiContext['__legacyApiClient__'],
        api: {} as JellyfinApiContext['api'],
        user: { Id: profileUserId },
        sessionQueryIdentity: identity,
        sessionScopedReadApi: { identity, assertCurrent } as JellyfinApiContext['sessionScopedReadApi']
    };
}

let snapshot: {
    history: ReturnType<typeof useSearchHistory>;
    record: ReturnType<typeof useRecordSearchHistory>;
    clear: ReturnType<typeof useClearSearchHistory>;
    genres: ReturnType<typeof useExploreGenres>;
};

function SearchDiscoveryProbe() {
    snapshot = {
        history: useSearchHistory(),
        record: useRecordSearchHistory(),
        clear: useClearSearchHistory(),
        genres: useExploreGenres()
    };
    return <div>{snapshot.genres.data?.Items?.[0]?.Name ?? 'pending'}</div>;
}

describe('Search history capability', () => {
    let root: Root;
    let container: HTMLDivElement;
    let client: Client;
    let queries: QueryClient;

    beforeEach(() => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        notifyManager.setNotifyFunction(callback => act(callback));
        client = createClient();
        queries = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        selectorRequest.mockReset();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        queries.clear();
        notifyManager.setNotifyFunction(callback => callback());
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    const render = async (context: JellyfinApiContext) => {
        publishedContext = context;
        await act(async () => root.render(
            <QueryClientProvider client={queries}><SearchDiscoveryProbe /></QueryClientProvider>
        ));
    };

    it('keeps ordinary discovery but sends no history request for a missing selector, even on manual actions', async () => {
        selectorRequest.mockResolvedValue(null);
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(container.textContent).toBe('Drama'));
        expect(snapshot.record.isReady).toBe(false);
        expect(snapshot.clear.isReady).toBe(false);
        expect(snapshot.history.isPending).toBe(false);
        expect(snapshot.history.data).toEqual([]);
        expect(client.getJSON).toHaveBeenCalledWith(expect.stringContaining('Users/child-1/Explore/Genres'), true);
        expect(client.getJSON).not.toHaveBeenCalledWith(expect.stringContaining('/Search/History'), true);

        await act(async () => {
            await snapshot.history.refetch();
        });
        await expect(snapshot.record.mutateAsync('Drama')).rejects.toThrow();
        await expect(snapshot.clear.mutateAsync()).rejects.toThrow();
        expect(client.getJSON).not.toHaveBeenCalledWith(expect.stringContaining('/Search/History'), true);
        expect(client.ajax).not.toHaveBeenCalled();
    });

    it('uses the real selector owner and member for history reads and writes', async () => {
        selectorRequest.mockResolvedValue(selector);
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(snapshot.history.data?.[0]?.SearchTerm).toBe('Drama'));
        expect(snapshot.record.isReady).toBe(true);
        expect(snapshot.clear.isReady).toBe(true);
        expect(client.getJSON).toHaveBeenCalledWith(historyPath, true);

        await act(async () => snapshot.record.mutateAsync('Drama'));
        await act(async () => snapshot.clear.mutateAsync());
        expect(client.ajax).toHaveBeenCalledWith(expect.objectContaining({ type: 'POST', url: historyPath }));
        expect(client.ajax).toHaveBeenCalledWith(expect.objectContaining({ type: 'DELETE', url: historyPath }));
    });

    it('does not turn a real history 403 into empty success', async () => {
        const forbidden = { status: 403 };
        selectorRequest.mockResolvedValue(selector);
        client.getJSON.mockImplementation(async path => {
            if (path.includes('/Explore/Genres')) return { Items: [{ Name: 'Drama' }] };
            throw forbidden;
        });
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(snapshot.history.isError).toBe(true));
        expect(snapshot.history.error).toBe(forbidden);
        expect(container.textContent).toBe('Drama');
    });

    it('surfaces a non-404 selector failure without attempting history', async () => {
        const forbidden = { status: 403 };
        selectorRequest.mockRejectedValue(forbidden);
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(snapshot.history.isError).toBe(true));
        expect(snapshot.history.error).toBe(forbidden);
        expect(snapshot.record.isReady).toBe(false);
        expect(client.getJSON).not.toHaveBeenCalledWith(expect.stringContaining('/Search/History'), true);
    });

    it('does not reuse an old history capability after logout and same-user relogin', async () => {
        let epoch = 1;
        selectorRequest.mockResolvedValueOnce(selector).mockResolvedValue(null);
        await render(published(client, 1, () => {
            if (epoch !== 1) throw new SessionReadCancelledError();
        }));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(true));
        const oldRecord = snapshot.record.mutateAsync;
        const oldHistoryRequests = client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History')).length;

        epoch = 2;
        await render(published(client, 2, () => undefined));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(false));
        await expect(oldRecord('stale')).rejects.toThrow();
        await act(async () => snapshot.history.refetch());
        expect(client.ajax).not.toHaveBeenCalled();
        expect(client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History'))).toHaveLength(oldHistoryRequests);
    });

    it('rejects an in-flight history write after the old authority is revoked', async () => {
        let epoch = 1;
        let resolveWrite: (() => void) | undefined;
        const write = new Promise<void>(resolve => {
            resolveWrite = resolve;
        });
        client.ajax.mockReturnValue(write);
        selectorRequest.mockResolvedValue(selector);
        await render(published(client, 1, () => {
            if (epoch !== 1) throw new SessionReadCancelledError();
        }));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(true));

        const pendingWrite = snapshot.record.mutateAsync('Drama');
        await vi.waitFor(() => expect(client.ajax).toHaveBeenCalledTimes(1));
        epoch = 2;
        await render(published(client, 2, () => undefined));
        resolveWrite?.();
        await expect(pendingWrite).rejects.toThrow(SessionReadCancelledError);
    });

    it('does not infer a history capability from an unlinked selector member', async () => {
        selectorRequest.mockResolvedValue({
            ...selector,
            Profiles: [{ ProfileUserId: 'another-user', IsActive: true, IsVisible: true }]
        });
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(container.textContent).toBe('Drama'));
        expect(snapshot.record.isReady).toBe(false);
        expect(snapshot.history.data).toEqual([]);
        expect(client.getJSON).not.toHaveBeenCalledWith(expect.stringContaining('/Search/History'), true);
    });

    it('revokes cached history and captured actions after a same-epoch selector 403', async () => {
        const forbidden = { status: 403 };
        let selectorStatus: 'linked' | 'forbidden' = 'linked';
        selectorRequest.mockImplementation(async () => {
            if (selectorStatus === 'forbidden') throw forbidden;
            return selector;
        });
        const context = published(client, 1, () => undefined);
        await render(context);
        await vi.waitFor(() => expect(snapshot.history.data?.[0]?.SearchTerm).toBe('Drama'));
        const capturedRefetch = snapshot.history.refetch;
        const capturedRecord = snapshot.record.mutateAsync;
        const capturedClear = snapshot.clear.mutateAsync;
        const historyReads = client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History')).length;

        selectorStatus = 'forbidden';
        await act(async () => queries.refetchQueries({ queryKey: ['SearchDiscovery', 'ProfileContext'] }));
        await vi.waitFor(() => expect(snapshot.history.isError).toBe(true));

        expect(snapshot.history.error).toBe(forbidden);
        expect(snapshot.history.data).toEqual([]);
        expect(snapshot.record.isReady).toBe(false);
        expect(snapshot.clear.isReady).toBe(false);
        expect(snapshot.genres.data?.Items?.[0]?.Name).toBe('Drama');
        expect(queries.getQueryData(['SearchDiscovery', 'History', serverId, 'owner-1', profileUserId, context.sessionQueryIdentity]))
            .toBeUndefined();
        await act(async () => capturedRefetch());
        await expect(capturedRecord('stale')).rejects.toThrow();
        await expect(capturedClear()).rejects.toThrow();
        expect(client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History'))).toHaveLength(historyReads);
        expect(client.ajax).not.toHaveBeenCalled();
    });

    it('revokes captured same-epoch history actions when the selector disappears with 404', async () => {
        let linked = true;
        selectorRequest.mockImplementation(async () => linked ? selector : null);
        const context = published(client, 1, () => undefined);
        await render(context);
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(true));
        const capturedRefetch = snapshot.history.refetch;
        const capturedRecord = snapshot.record.mutateAsync;
        const capturedClear = snapshot.clear.mutateAsync;
        const historyReads = client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History')).length;

        linked = false;
        await act(async () => queries.refetchQueries({ queryKey: ['SearchDiscovery', 'ProfileContext'] }));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(false));

        expect(snapshot.history.data).toEqual([]);
        expect(snapshot.clear.isReady).toBe(false);
        expect(snapshot.genres.data?.Items?.[0]?.Name).toBe('Drama');
        expect(queries.getQueryData(['SearchDiscovery', 'History', serverId, 'owner-1', profileUserId, context.sessionQueryIdentity]))
            .toBeUndefined();
        await act(async () => capturedRefetch());
        await expect(capturedRecord('stale')).rejects.toThrow();
        await expect(capturedClear()).rejects.toThrow();
        expect(client.getJSON.mock.calls.filter(([path]) => path.includes('/Search/History'))).toHaveLength(historyReads);
        expect(client.ajax).not.toHaveBeenCalled();
    });

    it('rejects a history write that settles after same-epoch selector authority fails', async () => {
        const forbidden = { status: 403 };
        let selectorStatus: 'linked' | 'forbidden' = 'linked';
        selectorRequest.mockImplementation(async () => {
            if (selectorStatus === 'forbidden') throw forbidden;
            return selector;
        });
        let finishWrite!: () => void;
        client.ajax.mockReturnValue(new Promise<void>(resolve => {
            finishWrite = resolve;
        }));
        await render(published(client, 1, () => undefined));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(true));

        const pendingWrite = snapshot.record.mutateAsync('Drama');
        await vi.waitFor(() => expect(client.ajax).toHaveBeenCalledOnce());
        selectorStatus = 'forbidden';
        await act(async () => queries.refetchQueries({ queryKey: ['SearchDiscovery', 'ProfileContext'] }));
        await vi.waitFor(() => expect(snapshot.record.isReady).toBe(false));
        finishWrite();

        await expect(pendingWrite).rejects.toThrow('Search profile context is not ready.');
        expect(snapshot.history.data).toEqual([]);
        expect(snapshot.genres.data?.Items?.[0]?.Name).toBe('Drama');
    });

    it('does not repopulate cached history from a late same-epoch GET after selector revocation', async () => {
        const forbidden = { status: 403 };
        let selectorStatus: 'linked' | 'forbidden' = 'linked';
        selectorRequest.mockImplementation(async () => {
            if (selectorStatus === 'forbidden') throw forbidden;
            return selector;
        });
        let finishHistory!: (entries: { SearchTerm: string; HitCount: number; LastSearchedUtc: string }[]) => void;
        let historyReads = 0;
        client.getJSON.mockImplementation(async path => {
            if (path.includes('/Explore/Genres')) return { Items: [{ Name: 'Drama' }] };
            if (path.includes('/Search/History')) {
                historyReads++;
                if (historyReads === 1) return [{ SearchTerm: 'Drama', HitCount: 1, LastSearchedUtc: '2026-10-02' }];
                return new Promise(resolve => {
                    finishHistory = resolve;
                });
            }
            throw new Error('Unexpected request');
        });
        const context = published(client, 1, () => undefined);
        await render(context);
        await vi.waitFor(() => expect(snapshot.history.data?.[0]?.SearchTerm).toBe('Drama'));
        const lateRead = snapshot.history.refetch();
        await vi.waitFor(() => expect(historyReads).toBe(2));

        selectorStatus = 'forbidden';
        await act(async () => queries.refetchQueries({ queryKey: ['SearchDiscovery', 'ProfileContext'] }));
        await vi.waitFor(() => expect(snapshot.history.isError).toBe(true));
        finishHistory([{ SearchTerm: 'stale late', HitCount: 2, LastSearchedUtc: '2026-10-02' }]);
        await act(async () => lateRead);

        expect(snapshot.history.data).toEqual([]);
        expect(queries.getQueryData(['SearchDiscovery', 'History', serverId, 'owner-1', profileUserId, context.sessionQueryIdentity]))
            .toBeUndefined();
        expect(snapshot.genres.data?.Items?.[0]?.Name).toBe('Drama');
    });
});
