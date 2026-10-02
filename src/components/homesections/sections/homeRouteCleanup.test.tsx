import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mainTabsManager from 'components/maintabsmanager';

vi.mock('components/Page', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('components/backdrop/backdrop', () => ({ clearBackdrop: vi.fn() }));
vi.mock('components/layoutManager', () => ({ default: { tv: false } }));
vi.mock('components/maintabsmanager', () => ({ setTabs: vi.fn(), selectedTabIndex: vi.fn() }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('scripts/libraryMenu', () => ({ default: { setTitle: vi.fn() } }));
vi.mock('elements/emby-tabs/emby-tabs', () => ({}));
vi.mock('elements/emby-button/emby-button', () => ({}));
vi.mock('elements/emby-scroller/emby-scroller', () => ({}));

import Home from '../../../apps/experimental/routes/home';

describe('React Home route cleanup', () => {
    let root: Root;
    let container: HTMLDivElement;
    let header: HTMLDivElement;

    beforeEach(() => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        header = document.createElement('div');
        header.className = 'skinHeader headerTabs';
        document.body.append(header, container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        header.remove();
    });

    it('finishes cleanup when the header disappears before Home unmounts', async () => {
        await act(async () => root.render(<MemoryRouter><Home /></MemoryRouter>));
        expect(header.classList.contains('noHomeButtonHeader')).toBe(true);

        header.remove();
        await act(async () => root.unmount());

        expect(container.innerHTML).toBe('');
    });

    it('removes the Home-only header class during ordinary unmount', async () => {
        await act(async () => root.render(<MemoryRouter><Home /></MemoryRouter>));
        expect(header.classList.contains('noHomeButtonHeader')).toBe(true);

        await act(async () => root.unmount());

        expect(header.classList.contains('noHomeButtonHeader')).toBe(false);
    });

    it('does not decorate a successor header after Home unmounts', async () => {
        vi.mocked(mainTabsManager.setTabs).mockClear();
        act(() => root.render(<MemoryRouter><Home /></MemoryRouter>));
        act(() => root.unmount());
        header.remove();
        const successor = document.createElement('div');
        successor.className = 'skinHeader';
        document.body.append(successor);

        await act(async () => Promise.resolve());

        expect(successor.classList.contains('noHomeButtonHeader')).toBe(false);
        expect(mainTabsManager.setTabs).not.toHaveBeenCalled();
        successor.remove();
    });
});
