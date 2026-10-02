import { readFileSync } from 'node:fs';
import type { Router } from '@remix-run/router';
import React, { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    history: null as unknown,
    client: null as unknown,
    publish: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
    viewHides: vi.fn()
}));

vi.mock('RootAppRouter', () => ({
    get history() {
        return harness.history;
    }
}));
vi.mock('lib/jellyfin-apiclient', () => ({
    ConnectionState: {
        ServerSignIn: 'ServerSignIn',
        SignedIn: 'SignedIn',
        ServerMismatch: 'ServerMismatch',
        ServerUpdateNeeded: 'ServerUpdateNeeded',
        Unavailable: 'Unavailable'
    },
    ServerConnections: {
        firstConnection: true,
        currentApiClient: () => harness.client,
        getOrCreateApiClient: () => harness.client,
        captureLoginAuthority: () => 0,
        publishLoginAuthentication: harness.publish
    }
}));
vi.mock('components/router/appRouter', () => ({
    appRouter: { ready: () => Promise.resolve(), canGoBack: () => true, back: () => (harness.history as { back: () => void }).back() }
}));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: {} }));
vi.mock('components/apphost', () => ({ appHost: { supports: () => true } }));
vi.mock('components/cardbuilder/utils/builder', () => ({ getDefaultBackgroundClass: () => 'background' }));
vi.mock('components/layoutManager', () => ({ default: { tv: false, mobile: false } }));
vi.mock('components/loading/loading', () => ({ default: { show: vi.fn(), hide: vi.fn() }, hide: vi.fn() }));
vi.mock('components/loading/LoadingComponent', () => ({ default: () => 'Loading' }));
vi.mock('components/ConnectionErrorPage', () => ({ default: () => 'Connection error' }));
vi.mock('components/dialog/dialog.template.html', () => ({ default: `
    <div class="formDialogHeaderTitle"></div>
    <div class="formDialogContent"><div class="dialogContentInner"><div class="text"></div></div></div>
    <div class="formDialogFooter"></div>
` }));
vi.mock('components/scrollHelper', () => ({ default: { centerFocus: { on: vi.fn(), off: vi.fn() } } }));
vi.mock('scripts/browser', () => ({ default: {
    tv: false, touch: false, slow: false, edge: false, supportsCssAnimation: () => false
} }));
vi.mock('scripts/libraryMenu', () => ({ default: { setTransparentMenu: vi.fn() } }));
vi.mock('scripts/settings/appSettings', () => ({ default: { enableAutoLogin: () => true } }));
vi.mock('lib/globalize', () => ({ default: {
    translate: (key: string) => key,
    translateHtml: (html: string) => html
} }));
vi.mock('lib/profileSelector/navigation', () => ({ resolveProfileSelectorRoute: () => Promise.resolve('/home') }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({ getWebSessionSwitchApplication: vi.fn() }));
vi.mock('utils/dashboard', () => ({ default: {
    navigate: harness.navigate,
    onServerChanged: vi.fn(),
    selectServer: vi.fn(),
    alert: vi.fn()
} }));
vi.mock('components/toast/toast', () => ({ default: vi.fn() }));
vi.mock('elements/emby-checkbox/emby-checkbox', () => ({}));

import ConnectionRequired from 'components/ConnectionRequired';
import { createRouterHistory } from 'components/router/routerHistory';
import { handleCommand } from 'scripts/inputManager';
import createLoginController from './index';

const loginHtml = readFileSync('src/controllers/session/login/index.html', 'utf8');

function LoginView() {
    const element = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const view = element.current!;
        view.innerHTML = loginHtml;
        createLoginController(view, { serverid: 'fixture-server' });
        view.dispatchEvent(new CustomEvent('viewshow'));
        return () => {
            harness.viewHides();
            view.dispatchEvent(new CustomEvent('viewhide'));
        };
    }, []);

    return <div ref={element} data-testid='legacy-login-view' />;
}

let router: Router;
let root: Root;
let container: HTMLDivElement;
let poll: ReturnType<typeof vi.fn>;

async function flush() {
    await act(async () => {
        await Promise.resolve();
    });
}

async function openPairing() {
    const button = container.querySelector<HTMLButtonElement>('.btnQuick')!;
    await act(async () => {
        button.click();
    });
    await flush();
    const dialog = document.querySelector('.dialogContainer .dialog.opened');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    return button;
}

describe('Quick Connect with the real dialog and route history', () => {
    beforeEach(async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
            return this.parentElement;
        });
        harness.publish.mockClear();
        harness.navigate.mockClear();
        harness.viewHides.mockClear();
        harness.client = {
            serverId: () => 'fixture-server',
            isLoggedIn: () => false,
            accessToken: () => 'fixture-token',
            getCurrentUserId: () => 'fixture-user',
            getUrl: (path: string) => `https://fixture.invalid${path}`,
            getQuickConnect: () => Promise.resolve(true),
            getPublicUsers: () => Promise.resolve([]),
            getJSON: () => Promise.resolve({}),
            setRequestHeaders: vi.fn(),
            ajax: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ Secret: 'fixture-secret', Code: '000000' }) })
        };
        poll = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ Authenticated: false }) });
        vi.stubGlobal('fetch', poll);
        vi.stubGlobal('Request', class {
            url: string;
            signal: AbortSignal | undefined;
            method: string;

            constructor(url: string, init?: RequestInit) {
                this.url = url;
                this.signal = init?.signal ?? undefined;
                this.method = init?.method ?? 'GET';
            }
        });
        router = createMemoryRouter([
            { path: '/origin', element: <div>Origin</div> },
            { element: <ConnectionRequired level='public' />, children: [
                { path: '/login', element: <LoginView /> },
                { path: '/other', element: <div>Other</div> }
            ] }
        ], { initialEntries: [ '/origin', '/login' ] });
        harness.history = createRouterHistory(router);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => {
            root.render(<RouterProvider router={router} />);
        });
        await flush();
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        router.dispose();
        container.remove();
        for (const element of document.querySelectorAll('.dialogContainer, .dialogBackdrop')) {
            element.remove();
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps the same login route and polls while the pairing dialog is open', async () => {
        const initialKey = router.state.location.key;
        vi.useFakeTimers();

        await openPairing();

        expect(router.state.location.key).toBe(initialKey);
        expect(router.state.location.pathname).toBe('/login');
        expect(harness.viewHides).not.toHaveBeenCalled();
        expect(document.querySelector('.dialogContainer .dialog.opened')).not.toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(poll).toHaveBeenCalledOnce();
    });

    it('dismisses through the pairing button and returns focus to its initiator', async () => {
        vi.useFakeTimers();
        const initiatingButton = container.querySelector<HTMLButtonElement>('.btnQuick')!;
        initiatingButton.focus();
        await openPairing();

        await act(async () => {
            document.querySelector<HTMLButtonElement>('.dialogContainer .btnOption')!.click();
        });
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(document.activeElement).toBe(initiatingButton);
        expect(router.state.location.pathname).toBe('/login');
        expect(poll).not.toHaveBeenCalled();
    });

    it('cancels through the app Back command without navigating', async () => {
        vi.useFakeTimers();
        await openPairing();
        const initialKey = router.state.location.key;

        await act(async () => {
            handleCommand('back');
        });
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(router.state.location.key).toBe(initialKey);
        expect(poll).not.toHaveBeenCalled();
    });

    it('dismisses with Escape from the focused dialog control', async () => {
        vi.useFakeTimers();
        await openPairing();
        const dialogButton = document.querySelector<HTMLButtonElement>('.dialogContainer .btnOption')!;
        dialogButton.focus();

        await act(async () => {
            dialogButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await flush();

        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(router.state.location.pathname).toBe('/login');
    });

    it('cancels an in-flight poll on route departure and starts fresh on return', async () => {
        let resolvePoll!: (response: unknown) => void;
        poll.mockImplementationOnce(() => new Promise(resolve => {
            resolvePoll = resolve;
        }));
        vi.useFakeTimers();
        await openPairing();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(poll).toHaveBeenCalledOnce();

        await act(async () => {
            await router.navigate('/other');
        });
        expect(harness.viewHides).toHaveBeenCalledOnce();
        expect(document.querySelector('.dialogContainer')).toBeNull();
        resolvePoll({ ok: true, json: () => Promise.resolve({ Authenticated: true, Secret: 'retired-secret' }) });
        await flush();
        expect(harness.publish).not.toHaveBeenCalled();

        await act(async () => {
            await router.navigate('/login');
        });
        await openPairing();
        expect(document.querySelector('.dialogContainer')).not.toBeNull();
        expect(harness.viewHides).toHaveBeenCalledOnce();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(poll).toHaveBeenCalledTimes(2);
    });

    it('treats browser Back as a real route departure', async () => {
        vi.useFakeTimers();
        await openPairing();

        await act(async () => {
            await router.navigate(-1);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(router.state.location.pathname).toBe('/origin');
        expect(harness.viewHides).toHaveBeenCalledOnce();
        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(poll).not.toHaveBeenCalled();
        expect(harness.publish).not.toHaveBeenCalled();
    });

    it('discards an Initiate result that arrives after leaving login', async () => {
        let resolveInitiate!: (response: unknown) => void;
        (harness.client as { ajax: ReturnType<typeof vi.fn> }).ajax.mockImplementationOnce(() => (
            new Promise(resolve => {
                resolveInitiate = resolve;
            })
        ));
        vi.useFakeTimers();
        const button = container.querySelector<HTMLButtonElement>('.btnQuick')!;
        await act(async () => {
            button.click();
        });
        await act(async () => {
            await router.navigate('/other');
        });
        resolveInitiate({ json: () => Promise.resolve({ Secret: 'retired-secret', Code: '000000' }) });
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(poll).not.toHaveBeenCalled();
        expect(harness.publish).not.toHaveBeenCalled();
    });

    it('discards authentication that completes after route departure', async () => {
        let resolveAuthentication!: (response: unknown) => void;
        (harness.client as { ajax: ReturnType<typeof vi.fn> }).ajax.mockImplementation((request: { url: string }) => {
            if (request.url.includes('AuthenticateWithQuickConnect')) {
                return new Promise(resolve => {
                    resolveAuthentication = resolve;
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({ Secret: 'fixture-secret', Code: '000000' }) });
        });
        poll.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ Authenticated: true, Secret: 'fixture-secret' }) });
        vi.useFakeTimers();
        await openPairing();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        await act(async () => {
            await router.navigate('/other');
        });
        resolveAuthentication({ User: { Id: 'retired-user' }, AccessToken: 'retired-token' });
        await flush();

        expect(harness.publish).not.toHaveBeenCalled();
        expect(harness.navigate).not.toHaveBeenCalled();
        expect(document.querySelector('.dialogContainer')).toBeNull();
    });

    it('does not let a replaced attempt show an error over the newer dialog', async () => {
        let rejectPoll!: (error: Error) => void;
        poll.mockImplementationOnce(() => new Promise((_resolve, reject) => {
            rejectPoll = reject;
        }));
        vi.useFakeTimers();
        await openPairing();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        await openPairing();
        const currentDialog = document.querySelector('.dialogContainer .dialog.opened');

        rejectPoll(new Error('retired request'));
        await flush();

        expect(document.querySelector('.dialogContainer .dialog.opened')).toBe(currentDialog);
        expect(document.querySelectorAll('.dialogContainer .dialog.opened')).toHaveLength(1);
        expect(harness.publish).not.toHaveBeenCalled();
    });

    it('closes its own dialog while successfully publishing authentication', async () => {
        poll.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ Authenticated: true, Secret: 'fixture-secret' }) });
        (harness.client as { ajax: ReturnType<typeof vi.fn> }).ajax.mockImplementation((request: { url: string }) => {
            if (request.url.includes('AuthenticateWithQuickConnect')) {
                return Promise.resolve({ User: { Id: 'fixture-user' }, AccessToken: 'fixture-token' });
            }
            return Promise.resolve({ json: () => Promise.resolve({ Secret: 'fixture-secret', Code: '000000' }) });
        });
        vi.useFakeTimers();
        await openPairing();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        await flush();

        expect(harness.publish).toHaveBeenCalledOnce();
        expect(harness.navigate).toHaveBeenCalledWith('/home');
        expect(document.querySelector('.dialogContainer')).toBeNull();
    });

    it('keeps the owned error dialog off history and dismisses normally', async () => {
        poll.mockRejectedValueOnce(new Error('fixture failure'));
        vi.useFakeTimers();
        const initialKey = router.state.location.key;
        const initiatingButton = container.querySelector<HTMLButtonElement>('.btnQuick')!;
        initiatingButton.focus();
        await openPairing();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
        });
        await flush();

        const errorDialog = document.querySelector<HTMLElement>('.dialogContainer .dialog.opened');
        expect(errorDialog?.id).toMatch(/-error$/);
        expect(errorDialog?.hasAttribute('data-history')).toBe(false);
        expect(router.state.location.key).toBe(initialKey);
        await act(async () => {
            errorDialog!.querySelector<HTMLButtonElement>('.btnOption')!.click();
        });
        await flush();
        expect(document.querySelector('.dialogContainer')).toBeNull();
        expect(document.activeElement === initiatingButton).toBe(true);
    });
});
