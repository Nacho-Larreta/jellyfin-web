import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { type BaseItemDtoQueryResult } from '@jellyfin/sdk/lib/generated-client';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type JellyfinApiContext } from 'hooks/useApi';
import { SessionAdmissionBarrier } from 'lib/profileSelector/sessionSwitch/barrier';
import { createBoundSessionReadPort, type FreshSessionAuthority } from 'lib/profileSelector/sessionSwitch/boundRequests';
import { SessionReadCancelledError, type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

import { useSearchItems } from './useSearchItems';
import { useSearchSuggestions } from './useSearchSuggestions';
import { useLiveTvSearch } from './useLiveTvSearch';

const serverId = 'server-1';
const profileUserId = 'user-1';
const movie = (name: string) => ({ Id: name, Name: name, Type: BaseItemKind.Movie });
let publishedContext: JellyfinApiContext;

vi.mock('hooks/useApi', () => ({ useApi: () => publishedContext }));

function sessionContext(
    epoch: number,
    authorityGeneration: string,
    getItems: SessionScopedReadApi['getItems'],
    assertCurrent: () => void,
    boundServerId = serverId,
    boundUserId = profileUserId
): JellyfinApiContext {
    const identity = { serverId: boundServerId, profileUserId: boundUserId, sessionEpoch: epoch, authorityGeneration };
    return {
        user: { Id: boundUserId },
        sessionQueryIdentity: identity,
        sessionScopedReadApi: {
            identity,
            assertCurrent,
            getItems,
            getArtists: async () => ({ Items: [] }),
            getPersons: async () => ({ Items: [] })
        }
    };
}

function SearchSnapshot() {
    const result = useSearchItems(undefined, CollectionType.Movies, 'movie');
    const suggestions = useSearchSuggestions();
    return <div>{result.data?.topResult?.Name ?? 'pending'}:{suggestions.data?.[0]?.Name ?? 'pending'}</div>;
}

function SuggestionsSnapshot() {
    const suggestions = useSearchSuggestions();
    return <div>{suggestions.data?.[0]?.Name ?? 'pending'}</div>;
}

function AllSearchQueries() {
    useSearchItems(undefined, CollectionType.Movies, 'term');
    useLiveTvSearch(undefined, CollectionType.Livetv, 'term');
    useSearchSuggestions();
    return <div>search-ready</div>;
}

function LiveTvSnapshot() {
    const result = useLiveTvSearch(undefined, CollectionType.Livetv, 'term');
    return <div>{result.data ? 'ready' : 'pending'}</div>;
}

describe('session namespaced Search queries', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

    beforeEach(() => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        notifyManager.setNotifyFunction(callback => act(callback));
    });

    afterEach(async () => {
        if (root) await act(async () => root!.unmount());
        container?.remove();
        root = undefined;
        container = undefined;
        notifyManager.setNotifyFunction(callback => callback());
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    it('isolates main and auxiliary Search data and fences a late composed result', async () => {
        let finishOld!: (result: BaseItemDtoQueryResult) => void;
        let currentEpoch = 1;
        const oldItems = vi.fn<SessionScopedReadApi['getItems']>(params => {
            if (params.limit === 20) return Promise.resolve({ Items: [movie('old-suggestion')] });
            return new Promise(resolve => {
                finishOld = resolve;
            });
        });
        const newItems = vi.fn<SessionScopedReadApi['getItems']>(async params => ({
            Items: [movie(params.limit === 20 ? 'new-suggestion' : 'new-movie')]
        }));
        const old = sessionContext(1, '10:old', oldItems, () => {
            if (currentEpoch !== 1) throw new SessionReadCancelledError();
        });
        const current = sessionContext(2, '11:new', newItems, () => undefined);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);

        const render = async (context: JellyfinApiContext) => {
            publishedContext = context;
            await act(async () => root!.render(
                <QueryClientProvider client={queryClient}>
                    <SearchSnapshot />
                </QueryClientProvider>
            ));
        };
        await render(old);
        await vi.waitFor(() => expect(oldItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 800 }), expect.anything()));

        currentEpoch = 2;
        await render(current);
        await vi.waitFor(() => expect(container?.textContent).toBe('new-movie:new-suggestion'));
        await act(async () => finishOld({ Items: [movie('late-old-movie')] }));
        expect(container?.textContent).toBe('new-movie:new-suggestion');

        const queries = queryClient.getQueryCache().getAll();
        const keys = queries.map(query => query.queryKey);
        expect(keys).toContainEqual(expect.arrayContaining(['Search', old.sessionQueryIdentity, 'Items']));
        expect(keys).toContainEqual(expect.arrayContaining(['Search', current.sessionQueryIdentity, 'Items']));
        expect(keys).toContainEqual(expect.arrayContaining(['Search', old.sessionQueryIdentity, 'People']));
        expect(keys).toContainEqual(expect.arrayContaining(['Search', current.sessionQueryIdentity, 'People']));
        expect(keys).toContainEqual(['SearchSuggestions', old.sessionQueryIdentity, { parentId: undefined }]);
        expect(keys).toContainEqual(['SearchSuggestions', current.sessionQueryIdentity, { parentId: undefined }]);
        const oldMain = queries.find(query => query.queryKey[0] === 'Search'
            && query.queryKey[1] === old.sessionQueryIdentity && query.queryKey[2] === 'Items');
        expect(oldMain?.state.data).toBeUndefined();
    });

    it('keeps suggestions separate for each server, profile, epoch and authority generation', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        const cases = [
            { expected: 'server-1', context: sessionContext(1, '10:base', async () => ({ Items: [movie('server-1')] }), () => undefined) },
            { expected: 'server-2', context: sessionContext(1, '10:base', async () => ({ Items: [movie('server-2')] }), () => undefined, 'server-2') },
            { expected: 'user-2', context: sessionContext(1, '10:base', async () => ({ Items: [movie('user-2')] }), () => undefined, serverId, 'user-2') },
            { expected: 'epoch-2', context: sessionContext(2, '10:base', async () => ({ Items: [movie('epoch-2')] }), () => undefined) },
            { expected: 'generation-11', context: sessionContext(1, '11:changed', async () => ({ Items: [movie('generation-11')] }), () => undefined) }
        ];

        for (const { context, expected } of cases) {
            publishedContext = context;
            await act(async () => root!.render(
                <QueryClientProvider client={queryClient}><SuggestionsSnapshot /></QueryClientProvider>
            ));
            await vi.waitFor(() => expect(container?.textContent).toBe(expected));
        }

        const suggestions = queryClient.getQueryCache().getAll()
            .filter(query => query.queryKey[0] === 'SearchSuggestions');
        expect(suggestions).toHaveLength(cases.length);
        expect(suggestions.map(query => query.state.data)).toEqual(cases.map(({ expected }) => [movie(expected)]));
    });

    it('does not publish cached results after delete and re-add resets the durable revision', async () => {
        const tokenBefore = 'private-before';
        const tokenAfter = 'private-after';
        const makeClient = (token: string) => ({
            serverId: () => serverId,
            serverAddress: () => 'https://jellyfin.example',
            deviceId: () => 'device-1',
            getCurrentUserId: () => profileUserId,
            accessToken: () => token
        });
        const before = makeClient(tokenBefore);
        const after = makeClient(tokenAfter);
        let installed: typeof before | null = before;
        let persisted: FreshSessionAuthority | null = {
            serverId, userId: profileUserId, accessToken: tokenBefore,
            selectorEnabled: false, authorityRevision: 1, envelope: null
        };
        const connections = {
            getApiClient: () => installed,
            currentApiClient: () => installed,
            getSessionDeviceId: () => 'device-1',
            readFreshSessionAuthority: () => persisted
        };
        const barrier = new SessionAdmissionBarrier();
        const firstPort = createBoundSessionReadPort(before, connections, barrier, persisted)!;
        const contextFor = (port: typeof firstPort, label: string): JellyfinApiContext => ({
            user: { Id: profileUserId },
            sessionQueryIdentity: port.identity,
            sessionScopedReadApi: {
                identity: port.identity,
                assertCurrent: port.assertCurrent,
                getItems: async () => ({ Items: [movie(label)] }),
                getArtists: async () => ({ Items: [] }),
                getPersons: async () => ({ Items: [] })
            }
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        const render = async (context: JellyfinApiContext) => {
            publishedContext = context;
            await act(async () => root!.render(
                <QueryClientProvider client={queryClient}><SuggestionsSnapshot /></QueryClientProvider>
            ));
        };

        await render(contextFor(firstPort, 'cached-before'));
        await vi.waitFor(() => expect(container?.textContent).toBe('cached-before'));
        installed = null;
        persisted = null;
        expect(() => firstPort.assertCurrent()).toThrow();
        installed = after;
        persisted = {
            serverId, userId: profileUserId, accessToken: tokenAfter,
            selectorEnabled: false, authorityRevision: 1, envelope: null
        };
        const nextPort = createBoundSessionReadPort(after, connections, barrier, persisted)!;
        await render(contextFor(nextPort, 'fresh-after'));
        await vi.waitFor(() => expect(container?.textContent).toBe('fresh-after'));
        expect(queryClient.getQueryCache().getAll()
            .filter(query => query.queryKey[0] === 'SearchSuggestions')).toHaveLength(2);
        expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.queryKey)))
            .not.toContain(tokenBefore);
        expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.queryKey)))
            .not.toContain(tokenAfter);
    });

    it('namespaces all seven Search consumers across server, profile, epoch and generation', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const cases = [
            sessionContext(1, '1:base', async () => ({ Items: [] }), () => undefined),
            sessionContext(1, '1:base', async () => ({ Items: [] }), () => undefined, 'server-2'),
            sessionContext(1, '1:base', async () => ({ Items: [] }), () => undefined, serverId, 'user-2'),
            sessionContext(2, '1:base', async () => ({ Items: [] }), () => undefined),
            sessionContext(1, '1:replaced', async () => ({ Items: [] }), () => undefined)
        ];
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        for (const context of cases) {
            publishedContext = context;
            await act(async () => root!.render(
                <QueryClientProvider client={queryClient}><AllSearchQueries /></QueryClientProvider>
            ));
        }

        const keys = queryClient.getQueryCache().getAll().map(query => query.queryKey);
        for (const context of cases) {
            for (const name of ['Items', 'Artists', 'People', 'Video', 'Programs', 'LiveTv']) {
                expect(keys).toContainEqual(expect.arrayContaining(['Search', context.sessionQueryIdentity, name]));
            }
            expect(keys).toContainEqual(['SearchSuggestions', context.sessionQueryIdentity, { parentId: undefined }]);
        }
    });

    it('fences a delayed composed Live TV result after the active identity changes', async () => {
        let finishOld!: (result: BaseItemDtoQueryResult) => void;
        let oldCurrent = true;
        const oldPending = new Promise<BaseItemDtoQueryResult>(resolve => {
            finishOld = resolve;
        });
        const oldItems = vi.fn<SessionScopedReadApi['getItems']>(() => oldPending);
        const old = sessionContext(1, '1:old', oldItems, () => {
            if (!oldCurrent) throw new SessionReadCancelledError();
        });
        const current = sessionContext(2, '2:new', async () => ({ Items: [] }), () => undefined);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        const render = async (context: JellyfinApiContext) => {
            publishedContext = context;
            await act(async () => root!.render(
                <QueryClientProvider client={queryClient}><LiveTvSnapshot /></QueryClientProvider>
            ));
        };
        await render(old);
        await vi.waitFor(() => expect(oldItems).toHaveBeenCalledTimes(7));
        oldCurrent = false;
        await render(current);
        await vi.waitFor(() => expect(container?.textContent).toBe('ready'));
        await act(async () => finishOld({ Items: [] }));
        expect(container?.textContent).toBe('ready');
        const oldQuery = queryClient.getQueryCache().getAll().find(query =>
            query.queryKey[0] === 'Search' && query.queryKey[1] === old.sessionQueryIdentity
            && query.queryKey[2] === 'LiveTv');
        expect(oldQuery?.state.data).toBeUndefined();
    });
});
