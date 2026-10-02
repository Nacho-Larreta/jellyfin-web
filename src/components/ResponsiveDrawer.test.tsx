import { createTheme, ThemeProvider } from '@mui/material/styles';
import React, { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ResponsiveDrawer from './ResponsiveDrawer';

const theme = createTheme();

describe('ResponsiveDrawer keyboard dismissal', () => {
    let root: Root;
    let container: HTMLDivElement;
    let close: ReturnType<typeof vi.fn>;
    let originalHash: string;

    const Harness = () => {
        const [ open, setOpen ] = useState(false);
        const onOpen = useCallback(() => setOpen(true), []);
        const onClose = useCallback(() => {
            close();
            setOpen(false);
        }, []);
        return (
            <ThemeProvider theme={theme}>
                <button type='button' onClick={onOpen}>Open menu</button>
                <span data-testid='drawer-state'>{open ? 'open' : 'closed'}</span>
                <ResponsiveDrawer
                    open={open}
                    onClose={onClose}
                    onOpen={onOpen}
                >
                    <a href='#/server'>Server</a>
                    <a href='#/library'>Library</a>
                </ResponsiveDrawer>
            </ThemeProvider>
        );
    };

    const state = () => container.querySelector('[data-testid="drawer-state"]')?.textContent;
    const openButton = () => container.querySelector('button') as HTMLButtonElement;
    const links = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('.MuiDrawer-paper a'));

    const openDrawer = async () => {
        await act(async () => {
            openButton().focus();
            openButton().click();
        });
        expect(state()).toBe('open');
        expect(links()).toHaveLength(2);
    };

    const press = async (element: Element, key: string, shiftKey = false) => {
        await act(async () => {
            element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
        });
    };

    beforeEach(async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        originalHash = window.location.hash;
        close = vi.fn();
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(<Harness />));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${originalHash}`);
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    it('keeps the open drawer while Tab and Shift+Tab traverse its links', async () => {
        await openDrawer();
        const [ server, library ] = links();
        server.focus();
        await press(server, 'Tab');
        expect(state()).toBe('open');
        expect(close).not.toHaveBeenCalled();

        library.focus();
        await press(library, 'Tab', true);
        expect(state()).toBe('open');
        expect(close).not.toHaveBeenCalled();
    });

    it('closes on keyboard link activation and follows the link', async () => {
        await openDrawer();
        const library = links()[1];
        library.focus();
        await press(library, 'Enter');
        await act(async () => library.click());
        expect(window.location.hash).toBe('#/library');
        expect(state()).toBe('closed');
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape and returns focus to the menu opener', async () => {
        await openDrawer();
        const server = links()[0];
        server.focus();
        await press(server, 'Escape');
        expect(state()).toBe('closed');
        expect(close).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(document.activeElement).toBe(openButton()));
    });

    it('preserves backdrop dismissal', async () => {
        await openDrawer();
        const backdrop = document.querySelector('.MuiBackdrop-root');
        expect(backdrop).not.toBeNull();
        await act(async () => backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(state()).toBe('closed');
        expect(close).toHaveBeenCalledTimes(1);
    });
});
