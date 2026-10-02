import { type BaseItemDtoQueryResult } from '@jellyfin/sdk/lib/generated-client';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import React, { act, useInsertionEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerConnections as DurableServerConnections } from 'lib/jellyfin-apiclient/ServerConnections';
import { getBoundUserViewsQuery } from 'utils/jellyfin-apiclient/boundUserViewsQuery';

import { type JellyfinApiContext } from './useApi';
import { useUserViews } from './useUserViews';

let publishedContext: JellyfinApiContext;
let durableConnections: DurableServerConnections | undefined;
const envelopeListeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock('components/apphost', () => ({ appHost: {
    appName: () => 'test', appVersion: () => '1', deviceName: () => 'test', deviceId: () => 'device'
} }));
vi.mock('scripts/settings/appSettings', () => ({ default: {} }));
vi.mock('scripts/settings/userSettings', () => ({ setUserInfo: vi.fn() }));
vi.mock('utils/dashboard', () => ({ default: { capabilities: () => ({}) } }));
vi.mock('utils/jellyfin-apiclient/compat', () => ({ toApi: vi.fn() }));
vi.mock('./useApi', () => ({ useApi: () => publishedContext }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        subscribeSessionSwitchEnvelope: (serverId: string, listener: () => void) => {
            if (durableConnections) return durableConnections.subscribeSessionSwitchEnvelope(serverId, listener);
            envelopeListeners.set(serverId, listener);
            return () => {
                envelopeListeners.delete(serverId);
            };
        }
    }
}));

function UserViewsSnapshot({ userId }: Readonly<{ userId?: string }>) {
    const { data } = useUserViews(userId);
    return <div>{data?.Items?.[0]?.Name ?? 'empty'}</div>;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

describe('bound React user views', () => {
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
        envelopeListeners.clear();
        durableConnections = undefined;
    });

    const context = (
        epoch: number,
        authorityGeneration: string,
        getUserViews: (params: { userId?: string }, signal?: AbortSignal) => Promise<BaseItemDtoQueryResult>,
        assertCurrent: () => void = () => undefined
    ): JellyfinApiContext => {
        const identity = { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: epoch, authorityGeneration };
        return {
            user: { Id: 'user-a' },
            sessionQueryIdentity: identity,
            sessionScopedUserViewsReadApi: { identity, getUserViews, assertCurrent }
        };
    };

    const mount = async (queryClient: QueryClient, current: JellyfinApiContext, userId = 'user-a') => {
        publishedContext = current;
        if (!container) {
            container = document.createElement('div');
            document.body.append(container);
            root = createRoot(container);
        }
        await act(async () => root!.render(
            <QueryClientProvider client={queryClient}><UserViewsSnapshot userId={userId} /></QueryClientProvider>
        ));
    };

    it('isolates a late old result when the same user gains a new epoch and generation', async () => {
        const oldPending = deferred<BaseItemDtoQueryResult>();
        let activeEpoch = 1;
        const oldRead = vi.fn(() => oldPending.promise);
        const newRead = vi.fn(async () => ({ Items: [{ Name: 'new-view' }] }));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        const old = context(1, '10:old', oldRead, () => {
            if (activeEpoch !== 1) throw new Error('stale');
        });
        const current = context(2, '11:new', newRead);

        await mount(queryClient, old);
        await vi.waitFor(() => expect(oldRead).toHaveBeenCalledWith({ userId: 'user-a' }, expect.anything()));
        activeEpoch = 2;
        await mount(queryClient, current);
        await vi.waitFor(() => expect(container?.textContent).toBe('new-view'));
        await act(async () => oldPending.resolve({ Items: [{ Name: 'old-view' }] }));
        expect(container?.textContent).toBe('new-view');
        expect(queryClient.getQueryCache().getAll().map(query => query.queryKey)).toEqual(expect.arrayContaining([
            expect.arrayContaining([ 'BoundUserViews', old.sessionQueryIdentity, 'user-a' ]),
            expect.arrayContaining([ 'BoundUserViews', current.sessionQueryIdentity, 'user-a' ])
        ]));
    });

    it('sends no request or cached data for a wrong requested user or missing authority', async () => {
        const read = vi.fn(async () => ({ Items: [{ Name: 'private-view' }] }));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const current = context(1, '10:current', read);

        await mount(queryClient, current);
        await vi.waitFor(() => expect(container?.textContent).toBe('private-view'));
        await mount(queryClient, current, 'other-user');
        expect(container?.textContent).toBe('empty');
        expect(read).toHaveBeenCalledTimes(1);

        await mount(queryClient, { api: {} as JellyfinApiContext['api'], user: { Id: 'user-a' } });
        expect(container?.textContent).toBe('empty');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('removes already visible cached views synchronously on an authority notification', async () => {
        let revoked = false;
        const read = vi.fn(async () => ({ Items: [{ Name: 'private-view' }] }));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await mount(queryClient, context(1, '10:current', read, () => {
            if (revoked) throw new Error('stale');
        }));
        await vi.waitFor(() => expect(container?.textContent).toBe('private-view'));

        revoked = true;
        act(() => envelopeListeners.get('server-a')?.());
        expect(container?.textContent).toBe('empty');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('keeps an invalidated generation hidden after a selector false-to-true-to-false cycle', async () => {
        let selectorEnabled = false;
        const read = vi.fn(async () => ({ Items: [{ Name: 'private-view' }] }));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await mount(queryClient, context(1, '10:current', read, () => {
            if (selectorEnabled) throw new Error('stale');
        }));
        await vi.waitFor(() => expect(container?.textContent).toBe('private-view'));

        act(() => envelopeListeners.get('server-a')?.());
        expect(container?.textContent).toBe('private-view');
        selectorEnabled = true;
        act(() => envelopeListeners.get('server-a')?.());
        expect(container?.textContent).toBe('empty');
        selectorEnabled = false;
        act(() => envelopeListeners.get('server-a')?.());
        expect(container?.textContent).toBe('empty');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('clears cached React views from a real durable selector setter notification', async () => {
        const key = 'bound-views-test';
        let credentials = { Servers: [{
            Id: 'server-a', UserId: 'user-a', AccessToken: 'test-token',
            ProfileSelectorEnabled: false, SessionSwitchEnvelope: null,
            SessionSwitchAuthorityRevision: 0
        }] };
        const storage = new Map([[ key, JSON.stringify(credentials) ]]);
        const provider = {
            key,
            appStorage: {
                getItem: (name: string) => storage.get(name) ?? null,
                setItem: (name: string, value: string) => storage.set(name, value)
            },
            credentials(next?: typeof credentials) {
                if (next) {
                    credentials = next;
                    storage.set(key, JSON.stringify(next));
                }
                return credentials;
            }
        };
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: { request: (_name: string, _options: unknown, operation: (lock: object) => unknown) => operation({}) }
        });
        durableConnections = new DurableServerConnections(provider, 'test', '1', 'test', 'device', {});
        const read = vi.fn(async () => ({ Items: [{ Name: 'private-view' }] }));
        const assertCurrent = () => {
            if (durableConnections?.readFreshSessionAuthority('server-a')?.selectorEnabled !== false) {
                throw new Error('stale');
            }
        };
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await mount(queryClient, context(1, '10:current', read, assertCurrent));
        await vi.waitFor(() => expect(container?.textContent).toBe('private-view'));

        await act(async () => durableConnections!.setProfileSelectorAvailability('server-a', true));
        expect(durableConnections.readFreshSessionAuthority('server-a')?.selectorEnabled).toBe(true);
        expect(container?.textContent).toBe('empty');
        await act(async () => durableConnections!.setProfileSelectorAvailability('server-a', false));
        expect(container?.textContent).toBe('empty');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('rechecks authority before paint when it changes after render but before subscription', async () => {
        let revoked = false;
        const read = vi.fn(async () => ({ Items: [{ Name: 'private-view' }] }));
        const current = context(1, '10:current', read, () => {
            if (revoked) throw new Error('stale');
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(
            getBoundUserViewsQuery(current.sessionScopedUserViewsReadApi, 'user-a').queryKey,
            { Items: [{ Name: 'private-view' }] }
        );
        publishedContext = current;
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        function FlipBeforeSubscription() {
            const { data } = useUserViews('user-a');
            useInsertionEffect(() => {
                revoked = true;
            }, []);
            return <div>{data?.Items?.[0]?.Name ?? 'empty'}</div>;
        }

        act(() => {
            flushSync(() => root!.render(
                <QueryClientProvider client={queryClient}><FlipBeforeSubscription /></QueryClientProvider>
            ));
            expect(container!.textContent).toBe('empty');
        });
        expect(read).not.toHaveBeenCalled();
    });
});
