import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('elements/emby-scroller/emby-scroller', () => ({}));
vi.mock('components/cardbuilder/cardBuilder', () => ({ default: {
    getCardsHtml: vi.fn(({ items, imagePresentation }) => items.map((item: { Id: string }, index: number) => {
        const image = imagePresentation(item, 'overflowPortrait', index);
        return `<button class="card itemAction" data-id="${item.Id}"><img data-session-image-slot="${index}" alt="" ${image.descriptor ? '' : 'hidden'}></button>`;
    }).join(''))
} }));
vi.mock('components/cardbuilder/utils/shape', () => ({
    getBackdropShape: () => 'overflowBackdrop', getPortraitShape: () => 'overflowPortrait', getSquareShape: () => 'overflowSquare'
}));
vi.mock('components/focusManager', () => ({ default: { autoFocus: vi.fn(), focus: vi.fn() } }));
vi.mock('components/layoutManager', () => ({ default: { tv: false } }));
vi.mock('components/router/appRouter', () => ({ appRouter: { getRouteUrl: vi.fn(() => '#list') } }));
vi.mock('components/shortcuts', () => ({ default: { on: vi.fn(), off: vi.fn(), onClick: vi.fn() } }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('scripts/serverNotifications', () => ({ default: {} }));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: vi.fn(), subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn()),
    getApiClient: vi.fn(() => { throw new Error('Global client recapture'); })
} }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: vi.fn(() => ({ captureBoundSessionRead: vi.fn() }))
}));
vi.mock('utils/jellyfin-apiclient/sessionReadApi', () => ({
    createSessionScopedReadApi: vi.fn((client: { read: unknown }) => client.read),
    SessionReadCancelledError: class extends Error {}
}));
vi.mock('utils/jellyfin-apiclient/sessionImageRead', () => ({ createSessionImageRead: vi.fn(() => ({ assertCurrent: vi.fn() })) }));
vi.mock('components/homesections/homeImageScope', () => ({ createHomeImageScope: vi.fn(() => ({ add: vi.fn(), dispose: vi.fn() })) }));

import cardBuilder from 'components/cardbuilder/cardBuilder';
import { createHomeImageScope } from 'components/homesections/homeImageScope';
import itemShortcuts from 'components/shortcuts';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import serverNotifications from 'scripts/serverNotifications';
import Events from 'utils/events';
import FavoritesTab from '../../controllers/favorites';

const itemId = '5dae694ba968f2676a64ceb6934f667b';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

function createView() {
    const view = document.createElement('div');
    view.innerHTML = '<div class="sections"></div>';
    document.body.append(view);
    return view;
}

function session(serverId: string, profileUserId: string, getItems?: ReturnType<typeof vi.fn>) {
    const identity = { serverId, profileUserId, sessionEpoch: 1, authorityGeneration: 'one' };
    const read = {
        identity,
        assertCurrent: vi.fn(),
        getCurrentUser: vi.fn(async () => ({ Id: profileUserId, ServerId: serverId })),
        getItems: getItems || vi.fn(async ({ includeItemTypes }) => ({ Items: includeItemTypes[0] === 'Movie' ?
            [{ Id: itemId, Name: 'Film', Type: 'Movie', ImageTags: { Primary: 'poster' } }] : [] })),
        getArtists: vi.fn(async () => ({ Items: [] })),
        getPersons: vi.fn(async () => ({ Items: [] }))
    };
    const port = { identity, assertCurrent: vi.fn() };
    const client = { serverId: () => serverId, read, port };
    return { client, port, read };
}

beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(ServerConnections, '_callbacks');
    Reflect.deleteProperty(serverNotifications, '_callbacks');
    Object.defineProperty(window, 'CustomElements', { configurable: true, value: { upgradeSubtree: vi.fn() } });
});

afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(window, 'CustomElements');
});

describe('Favorites session-owned lifecycle', () => {
    it('loads 16 sections from a single bound read and owns one aggregate image scope', async () => {
        const current = session('server-a', 'user-a');
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});

        expect(view.querySelectorAll('.verticalSection')).toHaveLength(16);
        expect(current.read.getItems).toHaveBeenCalledTimes(14);
        expect(current.read.getArtists).toHaveBeenCalledOnce();
        expect(current.read.getPersons).toHaveBeenCalledOnce();
        expect(createHomeImageScope).toHaveBeenCalledOnce();
        expect(vi.mocked(createHomeImageScope).mock.results[0].value.add).toHaveBeenCalledOnce();
        expect(view.querySelectorAll('.card')).toHaveLength(1);
        expect(cardBuilder.getCardsHtml).toHaveBeenCalled();
        controller.destroy();
    });

    it('removes A synchronously and ignores its late completion after B resumes', async () => {
        const pending = deferred<{ Items: Array<{ Id: string; Name: string; Type: string }> }>();
        const old = session('server-a', 'user-a', vi.fn(() => pending.promise));
        const next = session('server-b', 'user-b');
        let client = old.client;
        vi.mocked(ServerConnections.currentApiClient).mockImplementation(() => client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: (active: unknown) => active === old.client ? old.port : next.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        const previous = controller.onResume({});
        await vi.waitFor(() => expect(old.read.getItems).toHaveBeenCalled());
        controller.onPause();
        expect(view.querySelector('.card')).toBeNull();
        client = next.client;
        await controller.onResume({});
        pending.resolve({ Items: [{ Id: itemId, Name: 'A late item', Type: 'Movie' }] });
        await previous;

        expect(view.textContent).not.toContain('A late item');
        expect(vi.mocked(createHomeImageScope).mock.results[0].value.dispose).toHaveBeenCalledOnce();
        expect(view.querySelectorAll('.card')).toHaveLength(1);
        controller.destroy();
    });

    it('closes current cards on the durable authority signal and ignores foreign favorite notifications', async () => {
        const current = session('server-a', 'user-a');
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        let authority!: () => void;
        vi.mocked(ServerConnections.subscribeSessionSwitchEnvelope).mockImplementation((_serverId, callback) => {
            authority = callback;
            return vi.fn();
        });
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        Events.trigger(serverNotifications, 'UserDataChanged', [{ serverId: () => 'server-b' }, { Id: itemId }]);
        expect(current.read.getItems).toHaveBeenCalledTimes(14);
        current.read.assertCurrent.mockImplementation(() => {
            throw new Error('authority changed');
        });
        authority();
        expect(view.querySelector('.card')).toBeNull();
        expect(vi.mocked(createHomeImageScope).mock.results[0].value.dispose).toHaveBeenCalledOnce();
        controller.onPause();
        controller.destroy();
    });

    it('keeps the newer refresh when an older same-session response settles last', async () => {
        const pending = deferred<{ Items: Array<{ Id: string; Name: string; Type: string }> }>();
        let phase = 'initial';
        const getItems = vi.fn(({ includeItemTypes }) => {
            if (includeItemTypes[0] !== 'Movie') return Promise.resolve({ Items: [] });
            if (phase === 'old') return pending.promise;
            return Promise.resolve({ Items: [{
                Id: phase === 'new' ? '11111111111111111111111111111111' : itemId,
                Name: phase, Type: 'Movie', ImageTags: { Primary: 'poster' }
            }] });
        });
        const current = session('server-a', 'user-a', getItems);
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        phase = 'old';
        const oldRefresh = controller.refresh(controller.generation, () => current.read.assertCurrent(), current.client, current.port);
        phase = 'new';
        const newRefresh = controller.refresh(controller.generation, () => current.read.assertCurrent(), current.client, current.port);
        await newRefresh;
        pending.resolve({ Items: [{ Id: itemId, Name: 'late old', Type: 'Movie' }] });
        await oldRefresh;

        expect(view.querySelector('.card')?.getAttribute('data-id')).toBe('11111111111111111111111111111111');
        expect(vi.mocked(createHomeImageScope).mock.results[1].value.dispose).toHaveBeenCalledOnce();
        controller.destroy();
    });

    it('does not start any section or image read after a mismatched Users/Me response', async () => {
        const current = session('server-a', 'user-a');
        current.read.getCurrentUser.mockResolvedValue({ Id: 'user-b', ServerId: 'server-a' });
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});

        expect(current.read.getItems).not.toHaveBeenCalled();
        expect(createHomeImageScope).not.toHaveBeenCalled();
        expect(view.querySelector('.card')).toBeNull();
        expect(view.querySelector('.favoriteSectionsStatus')).toBeNull();
        controller.destroy();
    });

    it('shows completed sections and an error when another section times out', async () => {
        let blocked = false;
        const getItems = vi.fn(({ includeItemTypes }) => {
            if (blocked && includeItemTypes[0] === 'Series') return new Promise(() => undefined);
            return Promise.resolve({ Items: includeItemTypes[0] === 'Movie' ? [{
                Id: itemId, Name: 'Film', Type: 'Movie', ImageTags: { Primary: 'poster' }
            }] : [] });
        });
        const current = session('server-a', 'user-a', getItems);
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        blocked = true;
        vi.useFakeTimers();
        try {
            const refresh = controller.refresh(controller.generation, () => current.read.assertCurrent(), current.client, current.port);
            await vi.advanceTimersByTimeAsync(12000);
            await refresh;
            expect(view.querySelectorAll('.card')).toHaveLength(1);
            expect(view.querySelector('.favoriteSectionsStatus')?.textContent).toBe('ErrorDefault');
        } finally {
            controller.destroy();
            vi.useRealTimers();
        }
    });

    it('coalesces current favorite notifications into one bounded refresh and detaches shortcuts on pause', async () => {
        const current = session('server-a', 'user-a');
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        expect(itemShortcuts.on).toHaveBeenCalledTimes(16);
        vi.useFakeTimers();
        try {
            for (let index = 0; index < 3; index++) {
                Events.trigger(serverNotifications, 'UserDataChanged', [current.client, { Id: itemId }]);
            }
            await vi.advanceTimersByTimeAsync(100);
            expect(current.read.getItems).toHaveBeenCalledTimes(28);
            expect(current.read.getArtists).toHaveBeenCalledTimes(2);
            expect(current.read.getPersons).toHaveBeenCalledTimes(2);
            controller.onPause();
            expect(itemShortcuts.off).toHaveBeenCalledTimes(16);
            Events.trigger(serverNotifications, 'UserDataChanged', [current.client, { Id: itemId }]);
            await vi.advanceTimersByTimeAsync(100);
            expect(current.read.getItems).toHaveBeenCalledTimes(28);
        } finally {
            controller.destroy();
            vi.useRealTimers();
        }
    });

    it('allows a current card action and blocks a stale action before legacy handlers run', async () => {
        const current = session('server-a', 'user-a');
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        const card = view.querySelector('.card')!;
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(itemShortcuts.onClick).toHaveBeenCalledOnce();

        current.read.assertCurrent.mockImplementation(() => {
            throw new Error('stale');
        });
        const staleClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        expect(card.dispatchEvent(staleClick)).toBe(false);
        expect(itemShortcuts.onClick).toHaveBeenCalledOnce();
        expect(view.querySelector('.card')).toBeNull();
        controller.destroy();
    });

    it('turns a stalled Users/Me read into a visible timeout without starting section reads', async () => {
        const current = session('server-a', 'user-a');
        current.read.getCurrentUser.mockImplementation(() => new Promise(() => undefined));
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        vi.useFakeTimers();
        try {
            const pending = controller.onResume({});
            await vi.advanceTimersByTimeAsync(12000);
            await pending;
            expect(view.querySelector('.favoriteSectionsStatus')?.textContent).toBe('ErrorDefault');
            expect(current.read.getItems).not.toHaveBeenCalled();
            expect(createHomeImageScope).not.toHaveBeenCalled();
            Events.trigger(serverNotifications, 'UserDataChanged', [current.client, { Id: itemId }]);
            await vi.advanceTimersByTimeAsync(100);
            expect(current.read.getItems).not.toHaveBeenCalled();
            expect(view.querySelector('.favoriteSectionsStatus')?.textContent).toBe('ErrorDefault');
        } finally {
            controller.destroy();
            vi.useRealTimers();
        }
    });

    it('does not publish a late Users/Me error into a detached view', async () => {
        const pending = deferred<{ Id: string; ServerId: string }>();
        const current = session('server-a', 'user-a');
        current.read.getCurrentUser.mockImplementation(() => pending.promise);
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        const resume = controller.onResume({});
        view.remove();
        pending.resolve({ Id: 'user-a', ServerId: 'server-a' });
        await resume;

        expect(view.querySelector('.favoriteSectionsStatus')).toBeNull();
        expect(view.querySelector('.card')).toBeNull();
        expect(current.read.getItems).not.toHaveBeenCalled();
        controller.destroy();
    });

    it('keeps a newer same-server same-user epoch after marker and late old completion', async () => {
        const pending = deferred<{ Items: Array<{ Id: string; Name: string; Type: string }> }>();
        const oldReads = vi.fn(({ includeItemTypes }) => includeItemTypes[0] === 'Movie' ?
            pending.promise : Promise.resolve({ Items: [] }));
        const old = session('server-a', 'user-a', oldReads);
        const nextReads = vi.fn(({ includeItemTypes }) => Promise.resolve({ Items: includeItemTypes[0] === 'Movie' ?
            [{ Id: '11111111111111111111111111111111', Name: 'new epoch', Type: 'Movie' }] : [] }));
        const next = session('server-a', 'user-a', nextReads);
        next.port.identity.sessionEpoch = 2;
        next.port.identity.authorityGeneration = 'two';
        let activeClient = old.client;
        const callbacks: Array<() => void> = [];
        vi.mocked(ServerConnections.currentApiClient).mockImplementation(() => activeClient as never);
        vi.mocked(ServerConnections.subscribeSessionSwitchEnvelope).mockImplementation((_serverId, callback) => {
            callbacks.push(callback);
            return vi.fn();
        });
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({
            captureBoundSessionRead: (client: unknown) => client === old.client ? old.port : next.port
        } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        const oldResume = controller.onResume({});
        await vi.waitFor(() => expect(oldReads).toHaveBeenCalled());
        old.read.assertCurrent.mockImplementation(() => {
            throw new Error('marker invalidated old authority');
        });
        callbacks[0]();
        expect(view.querySelector('.card')).toBeNull();
        activeClient = next.client;
        await controller.onResume({});
        pending.resolve({ Items: [{ Id: itemId, Name: 'late old epoch', Type: 'Movie' }] });
        await oldResume;
        callbacks[0]();

        expect(view.querySelector('.card')?.getAttribute('data-id')).toBe('11111111111111111111111111111111');
        expect(nextReads).toHaveBeenCalledTimes(14);
        controller.destroy();
    });

    it('cancels a queued refresh if the view detaches before its debounce fires', async () => {
        const current = session('server-a', 'user-a');
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(current.client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => current.port } as never);
        const view = createView();
        const controller = new FavoritesTab(view);
        await controller.onResume({});
        vi.useFakeTimers();
        try {
            Events.trigger(serverNotifications, 'UserDataChanged', [current.client, { Id: itemId }]);
            view.remove();
            await vi.advanceTimersByTimeAsync(100);

            expect(current.read.getItems).toHaveBeenCalledTimes(14);
            expect(vi.mocked(createHomeImageScope).mock.results[0].value.dispose).toHaveBeenCalledOnce();
            expect(view.querySelector('.card')).toBeNull();
        } finally {
            controller.destroy();
            vi.useRealTimers();
        }
    });
});
