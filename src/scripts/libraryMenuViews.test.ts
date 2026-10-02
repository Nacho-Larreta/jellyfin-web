import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLibraryMenuViews } from './libraryMenuViews';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

function read(epoch: number, getUserViews: ReturnType<typeof vi.fn>, getCurrentUser = vi.fn(async () => ({
    Id: 'user-a', ServerId: 'server-a'
}))) {
    return {
        identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: epoch, authorityGeneration: `${epoch}:new` },
        assertCurrent: vi.fn(),
        getCurrentUser,
        getUserViews
    };
}

describe('legacy library menu bound views', () => {
    let container: HTMLElement;

    afterEach(() => container?.remove());

    function harness() {
        container = document.createElement('div');
        document.body.append(container);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        let activeRead: ReturnType<typeof read> | null = null;
        let onAuthorityChanged: (() => void) | undefined;
        const renderUser = vi.fn((target: HTMLElement, user: { Id: string }) => {
            const libraries = document.createElement('div');
            libraries.className = 'libraryMenuOptions';
            libraries.dataset.user = user.Id;
            target.replaceChildren(libraries);
            return { libraries: target.querySelector('.libraryMenuOptions'), links: null };
        });
        const renderViews = vi.fn((target: HTMLElement, result: { Items?: { Name?: string }[] }) => {
            target.textContent = result.Items?.[0]?.Name || '';
        });
        const menu = createLibraryMenuViews({
            captureRead: () => activeRead,
            prepareDrawer: async () => container,
            currentDrawer: () => container,
            clear: () => { container.replaceChildren(); },
            renderUser,
            renderViews,
            getLinks: async () => [],
            renderLinks: vi.fn(),
            subscribeAuthority: (_read: ReturnType<typeof read>, listener: () => void) => {
                onAuthorityChanged = listener;
                return () => {
                    onAuthorityChanged = undefined;
                };
            },
            queryClient,
            onError: vi.fn()
        });
        return { menu, queryClient, renderUser, renderViews, authorityChanged: () => onAuthorityChanged?.(), setRead: (value: ReturnType<typeof read> | null) => {
            activeRead = value;
        } };
    }

    it('clears painted A immediately and never paints late A over same-user new epoch B', async () => {
        const { menu, queryClient, renderViews, setRead } = harness();
        const first = read(1, vi.fn(async () => ({ Items: [{ Name: 'A' }] })));
        setRead(first);
        await menu.refresh();
        expect(container.textContent).toBe('A');

        const pending = deferred<{ Items: { Name: string }[] }>();
        const delayed = read(2, vi.fn(() => pending.promise));
        setRead(delayed);
        const oldRequest = menu.refresh();
        expect(container.textContent).toBe('');
        await vi.waitFor(() => expect(delayed.getUserViews).toHaveBeenCalled());

        const current = read(3, vi.fn(async () => ({ Items: [{ Name: 'B' }] })));
        setRead(current);
        await menu.refresh();
        expect(container.textContent).toBe('B');
        pending.resolve({ Items: [{ Name: 'late A' }] });
        await oldRequest;
        expect(container.textContent).toBe('B');
        expect(renderViews).toHaveBeenCalledTimes(2);
        expect(queryClient.getQueryCache().getAll().map(query => query.queryKey)).toEqual(expect.arrayContaining([
            expect.arrayContaining([ 'BoundUserViews', first.identity, 'user-a' ]),
            expect.arrayContaining([ 'BoundUserViews', delayed.identity, 'user-a' ]),
            expect.arrayContaining([ 'BoundUserViews', current.identity, 'user-a' ])
        ]));
    });

    it('fails closed without a port or when bound Users/Me returns another user', async () => {
        const { menu, renderUser, setRead } = harness();
        const good = read(1, vi.fn(async () => ({ Items: [{ Name: 'A' }] })));
        setRead(good);
        await menu.refresh();
        expect(container.textContent).toBe('A');

        setRead(null);
        await menu.refresh();
        expect(container.textContent).toBe('');

        const wrong = read(2, vi.fn(), vi.fn(async () => ({ Id: 'other-user', ServerId: 'server-a' })));
        setRead(wrong);
        await menu.refresh();
        expect(wrong.getUserViews).not.toHaveBeenCalled();
        expect(renderUser).toHaveBeenCalledTimes(1);
        expect(container.textContent).toBe('');
    });

    it('drops an old Users/Me result and clears on explicit invalidation', async () => {
        const { menu, renderUser, setRead } = harness();
        const pending = deferred<{ Id: string; ServerId: string }>();
        const old = read(1, vi.fn(), vi.fn(() => pending.promise));
        setRead(old);
        const oldRequest = menu.refresh();
        menu.invalidate();
        pending.resolve({ Id: 'user-a', ServerId: 'server-a' });
        await oldRequest;
        expect(renderUser).not.toHaveBeenCalled();
        expect(container.textContent).toBe('');
    });

    it('clears already painted views when the bound authority subscription invalidates', async () => {
        const { menu, authorityChanged, setRead } = harness();
        const current = read(1, vi.fn(async () => ({ Items: [{ Name: 'A' }] })));
        setRead(current);
        await menu.refresh();
        expect(container.textContent).toBe('A');

        current.assertCurrent.mockImplementation(() => {
            throw new Error('stale');
        });
        authorityChanged();
        expect(container.textContent).toBe('');
    });

    it('ignores same-value notifications and never revives a cleared selector generation', async () => {
        const { menu, authorityChanged, setRead } = harness();
        let selectorEnabled = false;
        const current = read(1, vi.fn(async () => ({ Items: [{ Name: 'A' }] })));
        current.assertCurrent.mockImplementation(() => {
            if (selectorEnabled) throw new Error('stale');
        });
        setRead(current);
        await menu.refresh();
        authorityChanged();
        expect(container.textContent).toBe('A');

        selectorEnabled = true;
        authorityChanged();
        expect(container.textContent).toBe('');
        selectorEnabled = false;
        authorityChanged();
        expect(container.textContent).toBe('');
        expect(current.getUserViews).toHaveBeenCalledTimes(1);
    });
});
