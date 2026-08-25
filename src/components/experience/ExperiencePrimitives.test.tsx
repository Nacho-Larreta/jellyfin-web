import React, { act, type FC, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@mui/material/styles';

import appTheme from 'themes';
import { ExperienceAction } from './ExperienceAction';
import { ExperienceAvatar } from './ExperienceAvatar';
import { ExperienceChip } from './ExperienceChip';
import { ExperienceMediaCard } from './ExperienceMediaCard';
import { ExperienceOverlay } from './ExperienceOverlay';
import { ExperiencePrimitivesFixture } from './ExperiencePrimitivesFixture';
import { ExperienceProgress } from './ExperienceProgress';
import { WEB_EXPERIENCE_COMPONENT_MANIFEST } from './componentManifest';

interface MountedComponent {
    container: HTMLDivElement;
    root: Root;
}

const mounted: MountedComponent[] = [];

const mount = async (component: React.ReactNode): Promise<MountedComponent> => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ThemeProvider theme={appTheme}>{component}</ThemeProvider>));
    const mountedComponent = { container, root };
    mounted.push(mountedComponent);
    return mountedComponent;
};

const dispatch = async (element: Element, event: Event) => {
    await act(async () => {
        element.dispatchEvent(event);
    });
};

const flushAnimationFrame = async () => {
    await act(async () => {
        await new Promise(resolve => window.setTimeout(resolve, 0));
    });
};

beforeEach(() => {
    Reflect.set(globalThis, [ 'IS', 'REACT', 'ACT', 'ENVIRONMENT' ].join('_'), true);
    window.requestAnimationFrame = callback => window.setTimeout(callback, 0);
    window.cancelAnimationFrame = handle => window.clearTimeout(handle);
});

afterEach(async () => {
    while (mounted.length) {
        const component = mounted.pop();
        if (!component) continue;
        await act(async () => component.root.unmount());
        component.container.remove();
    }
    document.body.replaceChildren();
});

describe('experience primitives semantics', () => {
    it('publishes the versioned primitive and evidence ownership manifest', () => {
        expect(WEB_EXPERIENCE_COMPONENT_MANIFEST.contractVersion).toBe('2.0.0');
        expect(WEB_EXPERIENCE_COMPONENT_MANIFEST.componentIds).toEqual(expect.arrayContaining([
            'atom.action',
            'atom.focus-indicator',
            'molecule.media-card',
            'molecule.modal-layer'
        ]));
        expect(WEB_EXPERIENCE_COMPONENT_MANIFEST.requiredAvailabilityStates).toEqual(expect.arrayContaining([
            'loading', 'empty', 'error', 'disabled', 'restricted', 'locked'
        ]));
    });

    it('uses native controls with explicit names, selection and availability', async () => {
        const { container } = await mount(
            <>
                <ExperienceAction label='Play' onActivate={vi.fn()} selected />
                <ExperienceAction availability='loading' label='Loading' onActivate={vi.fn()} />
                <ExperienceChip count={4} label='Movies' onActivate={vi.fn()} selected />
                <ExperienceMediaCard availability='locked' onActivate={vi.fn()} title='Family movie' />
            </>
        );

        expect(container.querySelectorAll('button')).toHaveLength(4);
        expect(container.querySelector('[aria-pressed="true"]')).not.toBeNull();
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(container.querySelector('button:disabled')).not.toBeNull();
        expect(container.querySelector('[aria-label="Family movie, Locked"]')).not.toBeNull();
        expect(container.querySelector('[aria-label="4 items"]')).not.toBeNull();
    });

    it('bounds progress input and exposes one range value', () => {
        const html = renderToStaticMarkup(
            <ExperienceProgress bufferedValue={125} label='Playback progress' max={100} value={-5} />
        );

        expect(html).toContain('role="progressbar"');
        expect(html).toContain('aria-valuemin="0"');
        expect(html).toContain('aria-valuemax="100"');
        expect(html).toContain('aria-valuenow="0"');
        expect(html).toContain('--jf-component-progress-buffered:100%');
        expect(html).toContain('--jf-component-progress-played:0%');
    });

    it('keeps avatar artwork decorative while standalone avatars expose state', () => {
        const html = renderToStaticMarkup(
            <>
                <ExperienceAvatar availability='restricted' name='Kids' />
                <ExperienceAvatar decorative name='Artwork' src='/image.jpg' />
            </>
        );

        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label="Kids, Restricted"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('<img alt=""');
    });

    it('renders the complete isolated state fixture without a product screen dependency', async () => {
        const { container } = await mount(<ExperiencePrimitivesFixture />);

        expect(container.querySelector('[data-contract-version="2.0.0"]')).not.toBeNull();
        expect(container.querySelector('[data-availability="loading"]')).not.toBeNull();
        expect(container.querySelector('[data-availability="empty"]')).not.toBeNull();
        expect(container.querySelector('[data-availability="error"]')).not.toBeNull();
        expect(container.querySelector('[data-availability="restricted"]')).not.toBeNull();
        expect(container.querySelector('[data-availability="locked"]')).not.toBeNull();
    });
});

describe('experience primitives input protocol', () => {
    it('dispatches one action on matching key-up and ignores repeat/generated click', async () => {
        const onActivate = vi.fn();
        const { container } = await mount(<ExperienceAction label='Play' onActivate={onActivate} />);
        const button = container.querySelector('button');
        expect(button).not.toBeNull();
        if (!button) return;

        await dispatch(button, new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        await dispatch(button, new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', repeat: true }));
        expect(onActivate).not.toHaveBeenCalled();

        await act(async () => {
            button.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
            button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        });
        expect(onActivate).toHaveBeenCalledTimes(1);

        await flushAnimationFrame();
        await dispatch(button, new MouseEvent('click', { bubbles: true, detail: 1 }));
        expect(onActivate).toHaveBeenCalledTimes(2);
    });

    it('cancels an unfinished press when focus leaves the control', async () => {
        const onActivate = vi.fn();
        const { container } = await mount(<ExperienceChip label='Movies' onActivate={onActivate} />);
        const button = container.querySelector('button');
        expect(button).not.toBeNull();
        if (!button) return;

        await dispatch(button, new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        await dispatch(button, new FocusEvent('blur', { bubbles: true }));
        await dispatch(button, new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
        expect(onActivate).not.toHaveBeenCalled();
    });
});

describe('experience overlay focus protocol', () => {
    const OverlayHarness: FC = () => {
        const [open, setOpen] = useState(false);
        const openOverlay = useCallback(() => setOpen(true), []);
        const closeOverlay = useCallback(() => setOpen(false), []);
        return (
            <>
                <button id='fallback-control' type='button'>Fallback</button>
                <button id='overlay-trigger' onClick={openOverlay} type='button'>Open</button>
                <ExperienceOverlay
                    initialFocusId='overlay-first'
                    label='Settings'
                    onClose={closeOverlay}
                    open={open}
                    restoreFallbackIds={[ 'fallback-control' ]}
                    triggerId='overlay-trigger'
                >
                    <button id='overlay-first' type='button'>First setting</button>
                </ExperienceOverlay>
            </>
        );
    };

    it('contains the modal layer and restores the stable trigger on Back', async () => {
        const { container } = await mount(<OverlayHarness />);
        const trigger = container.querySelector<HTMLElement>('#overlay-trigger');
        expect(trigger).not.toBeNull();
        if (!trigger) return;

        trigger.focus();
        await dispatch(trigger, new MouseEvent('click', { bubbles: true, detail: 1 }));
        await flushAnimationFrame();

        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(document.activeElement?.id).toBe('overlay-first');
        if (!dialog) return;

        await dispatch(dialog, new KeyboardEvent('keydown', { bubbles: true, key: 'BrowserBack' }));
        await act(async () => {
            await new Promise(resolve => window.setTimeout(resolve, 300));
        });
        await flushAnimationFrame();

        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
