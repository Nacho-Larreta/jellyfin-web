import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { EventType } from 'constants/eventType';
import Events from 'utils/events';

const headerState = vi.hoisted(() => ({
    client: null as null | { getUserImageUrl: (id: string) => string },
    resolveUsers: [] as Array<(user: { Id: string; Name: string; PrimaryImageTag: string }) => void>,
    browserTouch: false
}));

vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key, getIsRTL: () => false } }));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: () => headerState.client,
    getApiClient: () => headerState.client
} }));
vi.mock('lib/profileSelector/api', () => ({ getCurrentProfileSelector: vi.fn() }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({ getWebSessionSwitchApplication: () => ({
    captureBoundSessionRead: () => headerState.client ? {} : null
}) }));
vi.mock('utils/jellyfin-apiclient/sessionReadApi', () => ({ createSessionScopedReadApi: () => ({
    assertCurrent: () => undefined,
    getCurrentUser: () => new Promise(resolve => headerState.resolveUsers.push(resolve))
}) }));
vi.mock('scripts/libraryMenuViews', () => ({ createLibraryMenuViews: () => ({
    refresh: () => Promise.resolve(false), invalidate: vi.fn()
}) }));
vi.mock('components/layoutManager', () => ({ default: { desktop: true, mobile: false, tv: false } }));
vi.mock('components/Page', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('components/backdrop/backdrop', () => ({ clearBackdrop: vi.fn() }));
vi.mock('components/viewManager/viewManager', () => ({ default: { currentView: () => null } }));
vi.mock('components/router/appRouter', () => ({ appRouter: {} }));
vi.mock('components/apphost', () => ({ appHost: {} }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { getPlayerInfo: () => null } }));
vi.mock('components/pluginManager', () => ({ pluginManager: { ofType: () => [] } }));
vi.mock('plugins/syncPlay/ui/groupSelectionMenu', () => ({ default: {} }));
vi.mock('scripts/browser', () => ({ default: {
    safari: false,
    edge: false,
    get touch() {
        return headerState.browserTouch;
    }
} }));
vi.mock('utils/image', () => ({ default: {} }));
vi.mock('scripts/settings/webSettings', () => ({ getMenuLinks: () => [] }));
vi.mock('utils/dashboard', () => ({ default: {}, pageClassOn: vi.fn() }));
vi.mock('./images/imageLoader.js', () => ({ lazyChildren: vi.fn() }));
vi.mock('./images/blurhash.worker.ts', () => ({ default: class {
    addEventListener = vi.fn();
} }));

import AppHeader from './AppHeader';
import Home from '../apps/experimental/routes/home';

function createHeaderNodes() {
    const header = document.createElement('div');
    header.className = 'skinHeader';
    const drawer = document.createElement('div');
    drawer.innerHTML = '<div class="mainDrawer-scrollContainer scrollContainer"></div>';
    const handle = document.createElement('div');
    document.body.append(header, drawer, handle);
    return { header, drawer, handle };
}

describe('legacy header module lifecycle', () => {
    it('rebinds the same cached module to a new AppHeader mount', async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('__WEBPACK_SERVE__', true);
        const container = document.createElement('div');
        document.body.append(container);
        let root = createRoot(container);
        const onHeaderRendered = vi.fn();
        Events.on(document, EventType.HEADER_RENDERED, onHeaderRendered);
        try {
            await act(async () => root.render(<AppHeader />));
            await vi.waitFor(() => expect(container.querySelector('.skinHeader .headerTabs')).not.toBeNull(), { timeout: 5000 });
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));
            const oldHeader = container.querySelector('.skinHeader');

            await act(async () => root.unmount());
            expect(document.querySelectorAll('.tmla-mask')).toHaveLength(0);
            root = createRoot(container);
            await act(async () => root.render(<AppHeader />));
            await vi.waitFor(() => expect(container.querySelector('.skinHeader .headerTabs')).not.toBeNull(), { timeout: 5000 });
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));

            expect(container.querySelector('.skinHeader')).not.toBe(oldHeader);
            expect(onHeaderRendered).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => root.unmount());
            expect(document.querySelectorAll('.tmla-mask')).toHaveLength(0);
            Events.off(document, EventType.HEADER_RENDERED, onHeaderRendered);
            container.remove();
            vi.unstubAllGlobals();
        }
    });

    it('ignores an old user result after the header has rebound to a new session', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        let root = createRoot(container);
        try {
            headerState.client = { getUserImageUrl: id => `https://example.invalid/${id}` };
            await act(async () => root.render(<AppHeader />));
            await vi.waitFor(() => expect(headerState.resolveUsers).toHaveLength(1));
            await act(async () => root.unmount());

            headerState.client = { getUserImageUrl: id => `https://example.invalid/${id}` };
            root = createRoot(container);
            await act(async () => root.render(<AppHeader />));
            await vi.waitFor(() => expect(headerState.resolveUsers).toHaveLength(2));

            await act(async () => headerState.resolveUsers[0]({ Id: 'old', Name: 'Old User', PrimaryImageTag: 'old-tag' }));
            expect(container.querySelector('.headerUserButton')?.getAttribute('title')).not.toBe('Old User');

            await act(async () => headerState.resolveUsers[1]({ Id: 'new', Name: 'New User', PrimaryImageTag: 'new-tag' }));
            expect(container.querySelector('.headerUserButton')?.getAttribute('title')).toBe('New User');
        } finally {
            await act(async () => root.unmount());
            headerState.client = null;
            headerState.resolveUsers.length = 0;
            container.remove();
        }
    });

    it('does not let a late cleanup of mount A remove mount B tabs or drawer mask', async () => {
        const { mountHeader } = await import('scripts/libraryMenu');
        const createNodes = () => {
            const header = document.createElement('div');
            header.className = 'skinHeader';
            const drawer = document.createElement('div');
            const scrollContainer = document.createElement('div');
            scrollContainer.className = 'mainDrawer-scrollContainer scrollContainer';
            drawer.append(scrollContainer);
            const handle = document.createElement('div');
            document.body.append(header, drawer, handle);
            return { header, drawer, handle };
        };
        const first = createNodes();
        const second = createNodes();
        const unmountFirst = mountHeader(first.header, first.drawer, first.handle);
        const unmountSecond = mountHeader(second.header, second.drawer, second.handle);
        try {
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));
            unmountFirst();
            expect(second.header.querySelector('.headerTabs')).not.toBeNull();
            expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1);
        } finally {
            unmountSecond();
            first.header.remove();
            first.drawer.remove();
            first.handle.remove();
            second.header.remove();
            second.drawer.remove();
            second.handle.remove();
        }
        expect(document.querySelectorAll('.tmla-mask')).toHaveLength(0);
    });

    it('binds the replacement drawer edge to its own handle while both handles exist', async () => {
        const { mountHeader } = await import('scripts/libraryMenu');
        const { default: NavDrawer } = await import('../lib/navdrawer/navdrawer');
        const setEdgeSwipeEnabled = vi.spyOn(NavDrawer.prototype, 'setEdgeSwipeEnabled');
        const createNodes = () => {
            const header = document.createElement('div');
            header.className = 'skinHeader';
            const drawer = document.createElement('div');
            drawer.innerHTML = '<div class="mainDrawer-scrollContainer scrollContainer"></div>';
            const handle = document.createElement('div');
            handle.className = 'mainDrawerHandle';
            document.body.append(header, drawer, handle);
            return { header, drawer, handle };
        };
        const first = createNodes();
        const second = createNodes();
        const releaseFirst = mountHeader(first.header, first.drawer, first.handle);
        const releaseSecond = mountHeader(second.header, second.drawer, second.handle);
        try {
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));
            releaseSecond();
            const replacementDrawer = setEdgeSwipeEnabled.mock.contexts.at(-1) as InstanceType<typeof NavDrawer>;
            expect(replacementDrawer.edgeContainer).toBe(second.handle);
            expect(replacementDrawer.edgeContainer).not.toBe(first.handle);
        } finally {
            releaseFirst();
            releaseSecond();
            setEdgeSwipeEnabled.mockRestore();
            first.header.remove();
            first.drawer.remove();
            first.handle.remove();
            second.header.remove();
            second.drawer.remove();
            second.handle.remove();
        }
    });

    it('places new Home tabs on mount B when mount A remains connected', async () => {
        const { mountHeader } = await import('scripts/libraryMenu');
        const tabsManager = await import('./maintabsmanager');
        const first = createHeaderNodes();
        const second = createHeaderNodes();
        const releaseFirst = mountHeader(first.header, first.drawer, first.handle);
        const releaseSecond = mountHeader(second.header, second.drawer, second.handle);
        try {
            tabsManager.setTabs(second.header, 0, () => [{ name: 'Home B' }]);
            expect(second.header.querySelector('.tabs-viewmenubar')).not.toBeNull();
            expect(first.header.querySelector('.tabs-viewmenubar')).toBeNull();
            releaseFirst();
            expect(second.header.querySelector('.tabs-viewmenubar')).not.toBeNull();
            releaseSecond();
            expect(tabsManager.setTabs(first.header, 0, () => [{ name: 'Stale A' }]).tabsContainer).toBeNull();
            expect(first.header.querySelector('.tabs-viewmenubar')).toBeNull();
        } finally {
            releaseFirst();
            releaseSecond();
            first.header.remove();
            first.drawer.remove();
            first.handle.remove();
            second.header.remove();
            second.drawer.remove();
            second.handle.remove();
        }
    });

    it('keeps explicit and legacy drawer edge handles separate through enable and disable', async () => {
        const { default: NavDrawer } = await import('../lib/navdrawer/navdrawer');
        const createNodes = () => {
            const drawer = document.createElement('div');
            drawer.innerHTML = '<div class="mainDrawer-scrollContainer"></div>';
            const handle = document.createElement('div');
            handle.className = 'mainDrawerHandle';
            document.body.append(drawer, handle);
            return { drawer, handle };
        };
        const first = createNodes();
        const second = createNodes();
        const legacy = createNodes();
        headerState.browserTouch = true;
        const firstRemoved = vi.spyOn(first.handle, 'removeEventListener');
        const secondAdded = vi.spyOn(second.handle, 'addEventListener');
        const secondRemoved = vi.spyOn(second.handle, 'removeEventListener');
        let firstDrawer: InstanceType<typeof NavDrawer> | undefined;
        let secondDrawer: InstanceType<typeof NavDrawer> | undefined;
        let legacyDrawer: InstanceType<typeof NavDrawer> | undefined;
        try {
            firstDrawer = new NavDrawer({ target: first.drawer, edgeContainer: first.handle });
            secondDrawer = new NavDrawer({ target: second.drawer, edgeContainer: second.handle });
            expect(secondDrawer.edgeContainer).toBe(second.handle);
            firstDrawer.setEdgeSwipeEnabled(true);
            secondDrawer.setEdgeSwipeEnabled(true);
            expect(secondAdded).toHaveBeenCalledWith('touchstart', secondDrawer.onEdgeTouchStart, { passive: true });

            secondDrawer.setEdgeSwipeEnabled(false);
            expect(secondRemoved).toHaveBeenCalledWith('touchstart', secondDrawer.onEdgeTouchStart, { passive: true });
            expect(firstRemoved).not.toHaveBeenCalledWith('touchstart', firstDrawer.onEdgeTouchStart, { passive: true });

            legacyDrawer = new NavDrawer({ target: legacy.drawer });
            expect(legacyDrawer.edgeContainer).toBe(first.handle);
        } finally {
            firstDrawer?.setEdgeSwipeEnabled(false);
            secondDrawer?.setEdgeSwipeEnabled(false);
            firstDrawer?.mask?.remove();
            secondDrawer?.mask?.remove();
            legacyDrawer?.mask?.remove();
            first.drawer.remove();
            first.handle.remove();
            second.drawer.remove();
            second.handle.remove();
            legacy.drawer.remove();
            legacy.handle.remove();
            headerState.browserTouch = false;
            firstRemoved.mockRestore();
            secondAdded.mockRestore();
            secondRemoved.mockRestore();
        }
    });

    it('does not let a deferred tab reset from mount A clear mount B tabs', async () => {
        const { default: libraryMenu, mountHeader } = await import('scripts/libraryMenu');
        const tabsManager = await import('./maintabsmanager');
        const setTabs = vi.spyOn(tabsManager, 'setTabs');
        const first = createHeaderNodes();
        const second = createHeaderNodes();
        const releaseFirst = mountHeader(first.header, first.drawer, first.handle);
        libraryMenu.setTabs(null);
        const releaseSecond = mountHeader(second.header, second.drawer, second.handle);
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(setTabs).not.toHaveBeenCalled();
            expect(second.header.querySelector('.headerTabs')).not.toBeNull();
        } finally {
            setTabs.mockRestore();
            releaseFirst();
            releaseSecond();
            first.header.remove();
            first.drawer.remove();
            first.handle.remove();
            second.header.remove();
            second.drawer.remove();
            second.handle.remove();
        }
    });

    it('shares one same-node mount until its last owner releases it', async () => {
        const { mountHeader } = await import('scripts/libraryMenu');
        const header = document.createElement('div');
        header.className = 'skinHeader';
        const drawer = document.createElement('div');
        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'mainDrawer-scrollContainer scrollContainer';
        drawer.append(scrollContainer);
        const handle = document.createElement('div');
        document.body.append(header, drawer, handle);
        const releaseFirst = mountHeader(header, drawer, handle);
        const releaseSecond = mountHeader(header, drawer, handle);
        try {
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));
            releaseFirst();
            releaseFirst();
            expect(header.querySelector('.headerTabs')).not.toBeNull();
            expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1);
        } finally {
            releaseSecond();
            header.remove();
            drawer.remove();
            handle.remove();
        }
        expect(document.querySelectorAll('.tmla-mask')).toHaveLength(0);
    });

    it('leaves one drawer mask in StrictMode and none after teardown', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<React.StrictMode><AppHeader /></React.StrictMode>));
            await vi.waitFor(() => expect(container.querySelector('.skinHeader .headerTabs')).not.toBeNull());
            await vi.waitFor(() => expect(document.querySelectorAll('.tmla-mask')).toHaveLength(1));
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
        expect(document.querySelectorAll('.tmla-mask')).toHaveLength(0);
    });

    it('initializes Home tabs again after the header and route both remount', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        let root = createRoot(container);
        const renderHome = () => <><AppHeader /><MemoryRouter><Home /></MemoryRouter></>;
        try {
            await act(async () => root.render(renderHome()));
            await vi.waitFor(() => expect(container.querySelector('.tabs-viewmenubar')).not.toBeNull());
            await act(async () => root.unmount());

            root = createRoot(container);
            await act(async () => root.render(renderHome()));
            await vi.waitFor(() => expect(container.querySelector('.tabs-viewmenubar')).not.toBeNull());
            expect(container.querySelector('#homeTab')).not.toBeNull();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
