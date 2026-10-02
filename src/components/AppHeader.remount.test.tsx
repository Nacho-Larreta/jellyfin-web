import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('scripts/libraryMenu', () => {
    return {
        mountHeader(header: HTMLElement) {
            const tabs = document.createElement('div');
            tabs.className = 'headerTabs';
            header.append(tabs);
            return () => tabs.remove();
        }
    };
});
vi.mock('elements/emby-tabs/emby-tabs', () => ({}));
vi.mock('elements/emby-button/emby-button', () => ({}));

import AppHeader from './AppHeader';

describe('legacy header remount', () => {
    it('initializes legacy tabs on each mounted header, not only on first module import', async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        const container = document.createElement('div');
        document.body.append(container);
        let root = createRoot(container);
        try {
            await act(async () => root.render(<AppHeader />));
            expect(container.querySelector('.skinHeader .headerTabs')).not.toBeNull();

            await act(async () => root.unmount());
            root = createRoot(container);
            await act(async () => root.render(<AppHeader />));

            expect(container.querySelector('.skinHeader .headerTabs')).not.toBeNull();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('does not retain the first header tabs as the manager target after replacement', async () => {
        vi.resetModules();
        const firstHeader = document.createElement('div');
        firstHeader.className = 'skinHeader';
        const firstTabs = document.createElement('div');
        firstTabs.className = 'headerTabs';
        firstHeader.append(firstTabs);
        document.body.append(firstHeader);

        const nextHeader = document.createElement('div');
        try {
            const tabsManager = await import('./maintabsmanager');
            expect(tabsManager.setTabs(null).tabsContainer).toBe(firstTabs);

            firstHeader.remove();
            nextHeader.className = 'skinHeader';
            const nextTabs = document.createElement('div');
            nextTabs.className = 'headerTabs';
            nextHeader.append(nextTabs);
            document.body.append(nextHeader);

            expect(tabsManager.setTabs(null).tabsContainer).toBe(nextTabs);
        } finally {
            firstHeader.remove();
            nextHeader.remove();
        }
    });
});
