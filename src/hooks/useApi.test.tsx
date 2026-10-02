import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectionErrorPage from 'components/ConnectionErrorPage';
import ConnectionRequired from 'components/ConnectionRequired';
import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';
import { createActiveProfileSession, type SessionSwitchCompletionReceipt, type SessionSwitchEnvelope } from 'lib/profileSelector/sessionSwitch/model';
import { createSessionSwitchEnvelope } from 'lib/profileSelector/sessionSwitch/store';
import events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { queryClient } from 'utils/query/queryClient';

import { ApiProvider, useApi } from './useApi';

const routeBootstrap = vi.hoisted(() => ({ prepare: vi.fn(), capture: vi.fn() }));

vi.mock('lib/jellyfin-apiclient', () => ({
    ConnectionState: {
        ServerMismatch: 'ServerMismatch',
        ServerUpdateNeeded: 'ServerUpdateNeeded',
        ServerSelection: 'ServerSelection',
        ServerSignIn: 'ServerSignIn',
        SignedIn: 'SignedIn',
        Unavailable: 'Unavailable'
    },
    ServerConnections: {
        connect: vi.fn(),
        currentApiClient: vi.fn(),
        firstConnection: false,
        getApiClient: vi.fn(),
        getSessionSwitchEnvelope: vi.fn(),
        subscribeSessionSwitchEnvelope: vi.fn()
    }
}));
vi.mock('components/loading/LoadingComponent', () => ({ default: () => 'Loading' }));
vi.mock('components/apphost', () => ({ appHost: { supports: () => true } }));
vi.mock('components/autoFocuser', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('components/layoutManager', () => ({ default: { tv: false } }));
vi.mock('components/router/appRouter', () => ({ appRouter: { show: vi.fn() } }));
vi.mock('components/toast/toast', () => ({ default: vi.fn() }));
vi.mock('components/viewContainer', () => ({ default: { reset: vi.fn() } }));
vi.mock('components/viewManager/viewManager', () => ({ default: { hideView: vi.fn() } }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => ({
        prepareProtectedRoute: routeBootstrap.prepare,
        captureBoundSessionRead: routeBootstrap.capture
    })
}));
vi.mock('scripts/shell', () => ({ default: { openUrl: vi.fn() } }));
vi.mock('utils/jellyfin-apiclient/compat', () => ({
    toApi: vi.fn((client: { accessToken(): string }) => ({ token: client.accessToken() }))
}));

const receipt: SessionSwitchCompletionReceipt = {
    switchId: 'switch-1',
    serverId: 'server-1',
    profileUserId: 'new-user',
    sessionEpoch: 1
};

function sessionEnvelope(
    completed: boolean,
    completion: SessionSwitchCompletionReceipt = receipt,
    token = 'new-token'
): SessionSwitchEnvelope {
    const active = createActiveProfileSession('server-1', 'device-1', completion.profileUserId, token, completion.sessionEpoch);
    return {
        ...createSessionSwitchEnvelope(active, null),
        revision: 3,
        marker: completed ? null : {
            kind: 'CommittedPendingCleanup',
            phase: 'Completing',
            switchId: completion.switchId,
            serverId: completion.serverId,
            deviceId: 'device-1',
            oldProfileUserId: 'old-user',
            oldEpoch: 0,
            targetProfileUserId: completion.profileUserId,
            coordinatorId: 'coordinator-1',
            fencingToken: 1,
            leaseExpiresAtMs: 1000,
            updatedAtMs: 0
        },
        lastCompletion: completed ? completion : null
    };
}

function oldSessionEnvelope(): SessionSwitchEnvelope {
    return {
        ...createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 0),
            null
        ),
        revision: 1
    };
}

function apiClient(userId: string, token: string, serverId = 'server-1') {
    return {
        appName: () => 'Web',
        appVersion: () => '1',
        deviceName: () => 'Browser',
        deviceId: () => 'device-1',
        accessToken: () => token,
        getCurrentUser: vi.fn(async () => ({ Id: userId, ServerId: serverId })),
        getCurrentUserId: () => userId,
        isLoggedIn: () => true,
        serverId: () => serverId
    };
}

function deferredUser() {
    let release: ((user: { Id: string; ServerId: string }) => void) | undefined;
    const promise = new Promise<{ Id: string; ServerId: string }>(resolve => {
        release = resolve;
    });
    return {
        promise,
        release: (user: { Id: string; ServerId: string }) => {
            if (!release) throw new Error('Deferred user was not initialized.');
            release(user);
        }
    };
}

const oldClient = apiClient('old-user', 'old-token');
const newClient = apiClient('new-user', 'new-token');
const subscribers = new Set<(envelope: SessionSwitchEnvelope | null) => void>();
let currentClient = oldClient;
let envelope: SessionSwitchEnvelope | null = null;
let root: Root;
let container: HTMLDivElement;

const connections = ServerConnections as unknown as {
    connect: ReturnType<typeof vi.fn>;
    currentApiClient: ReturnType<typeof vi.fn>;
    firstConnection: boolean;
    getApiClient: ReturnType<typeof vi.fn>;
    getSessionSwitchEnvelope: ReturnType<typeof vi.fn>;
    subscribeSessionSwitchEnvelope: ReturnType<typeof vi.fn>;
};

function Snapshot() {
    const { api, user } = useApi();
    return <div>{user?.Id || 'no-user'}:{Reflect.get(api || {}, 'token') || 'no-token'}</div>;
}

function ReadSnapshot() {
    const { api, sessionScopedReadApi, sessionQueryIdentity } = useApi();
    return <div>{Reflect.get(api || {}, 'token')}:{sessionScopedReadApi ? sessionQueryIdentity?.sessionEpoch : 'no-read'}</div>;
}

async function mount(reloadPage?: () => void, content: React.ReactNode = <Snapshot />) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ApiProvider reloadPage={reloadPage}>{content}</ApiProvider>));
}

async function complete(next: SessionSwitchCompletionReceipt = receipt) {
    if (envelope?.activeSession.profileUserId === 'old-user') {
        envelope = sessionEnvelope(false, next);
    }
    await act(async () => events.trigger(ServerConnections, 'sessionswitchcompleted', [ next ]));
}

async function publishEnvelope(next: SessionSwitchEnvelope) {
    envelope = next;
    await act(async () => {
        subscribers.forEach(listener => {
            listener(next);
        });
    });
}

beforeEach(() => {
    Reflect.set(globalThis, [ 'IS', 'REACT', 'ACT', 'ENVIRONMENT' ].join('_'), true);
    window.location.hash = '/home';
    currentClient = oldClient;
    envelope = oldSessionEnvelope();
    subscribers.clear();
    connections.currentApiClient.mockImplementation(() => currentClient);
    connections.connect.mockImplementation(async () => ({ State: 'SignedIn', ApiClient: currentClient }));
    connections.firstConnection = false;
    connections.getApiClient.mockImplementation(() => currentClient);
    connections.getSessionSwitchEnvelope.mockImplementation(serverId => serverId === 'server-1' ? envelope : null);
    connections.subscribeSessionSwitchEnvelope.mockImplementation((_serverId, listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
    });
    routeBootstrap.prepare.mockReset();
    routeBootstrap.capture.mockReset();
    routeBootstrap.capture.mockReturnValue(null);
    routeBootstrap.prepare.mockImplementation(async () => {
        if (envelope?.marker) throw new Error('Pending durable session switch');
        return { selector: null, activeSession: envelope?.activeSession || null };
    });
    vi.mocked(toApi).mockReset();
    vi.mocked(toApi).mockImplementation(client => ({ token: client.accessToken() } as unknown as ReturnType<typeof toApi>));
    queryClient.clear();
});

afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    queryClient.clear();
    vi.useRealTimers();
});

describe('ApiProvider session completion', () => {
    it('keeps the anonymous provider empty while a public server route resolves', async () => {
        connections.currentApiClient.mockImplementation(() => undefined);
        connections.connect.mockResolvedValue({ State: 'ServerSelection' });
        await mount(undefined, (
            <MemoryRouter initialEntries={[ '/selectserver' ]}>
                <Routes>
                    <Route element={<ConnectionRequired level='public' />}>
                        <Route path='/selectserver' element={<div>Server selection <Snapshot /></div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        ));

        expect(container.textContent).toContain('Server selection no-user:no-token');
        expect(routeBootstrap.capture).not.toHaveBeenCalled();
    });

    it('shows connection unavailable only when anonymous connect reports it', async () => {
        connections.currentApiClient.mockImplementation(() => undefined);
        connections.connect.mockResolvedValue({ State: 'Unavailable' });
        await mount(undefined, (
            <MemoryRouter initialEntries={[ '/selectserver' ]}>
                <Routes>
                    <Route element={<ConnectionRequired level='public' />}>
                        <Route path='/selectserver' element={<div>Server selection</div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        ));

        expect(container.textContent).toContain('HeaderServerUnavailable');
        expect(routeBootstrap.capture).not.toHaveBeenCalled();
    });

    it('publishes the bound Search read beside the ordinary API', async () => {
        const active = oldSessionEnvelope().activeSession;
        routeBootstrap.capture.mockReturnValue({
            binding: active,
            basePath: 'https://jellyfin.example',
            identity: { serverId: active.serverId, profileUserId: active.profileUserId, sessionEpoch: active.sessionEpoch, authorityGeneration: 4 },
            assertCurrent: vi.fn(),
            acquire: vi.fn()
        });
        await mount(undefined, <ReadSnapshot />);
        expect(container.textContent).toBe('old-token:0');
        expect(routeBootstrap.capture).toHaveBeenCalledWith(oldClient);
    });

    it('hides old actions until the matching durable completion and rebuilds SDK auth', async () => {
        await mount();
        expect(container.textContent).toBe('old-user:old-token');
        queryClient.setQueryData([ 'old-profile' ], 'private');
        currentClient = newClient;

        await complete();
        expect(container.textContent).toBe('Loading');
        expect(queryClient.getQueryData([ 'old-profile' ])).toBeUndefined();

        await publishEnvelope(sessionEnvelope(true));
        expect(container.textContent).toBe('new-user:new-token');
        expect(subscribers.size).toBe(0);
    });

    it('does not publish a foreign receipt or a late user response after logout', async () => {
        await mount();
        currentClient = newClient;
        await complete();
        await publishEnvelope({ ...sessionEnvelope(true), lastCompletion: { ...receipt, switchId: 'foreign' } });
        expect(container.textContent).toBe('Loading');

        const pendingUser = deferredUser();
        newClient.getCurrentUser.mockImplementationOnce(() => pendingUser.promise);
        await publishEnvelope(sessionEnvelope(true));
        await act(async () => events.trigger(ServerConnections, 'localusersignedout'));
        await act(async () => pendingUser.release({ Id: 'new-user', ServerId: 'server-1' }));
        expect(container.textContent).toBe('no-user:no-token');
    });

    it('uses subscribe-before-read when the envelope already resolved', async () => {
        await mount();
        currentClient = newClient;
        envelope = sessionEnvelope(true);
        await complete();
        expect(container.textContent).toBe('new-user:new-token');
        expect(connections.subscribeSessionSwitchEnvelope).toHaveBeenCalled();
        expect(subscribers.size).toBe(0);
    });

    it('recreates the SDK when the same legacy ApiClient receives the new token', async () => {
        await mount();
        vi.spyOn(oldClient, 'accessToken').mockReturnValue('new-token');
        vi.spyOn(oldClient, 'getCurrentUserId').mockReturnValue('new-user');
        oldClient.getCurrentUser.mockResolvedValueOnce({ Id: 'new-user', ServerId: 'server-1' });

        await complete();
        await publishEnvelope(sessionEnvelope(true));
        expect(container.textContent).toBe('new-user:new-token');

        await act(async () => events.trigger(ServerConnections, 'localusersignedin', [
            { Id: 'old-user', ServerId: 'server-1' }
        ]));
        expect(container.textContent).toBe('new-user:new-token');
    });

    it('does not reopen the previous UI for an older sign-in event while completion is pending', async () => {
        await mount();
        currentClient = newClient;
        await complete();

        await act(async () => events.trigger(ServerConnections, 'localusersignedin', [
            { Id: 'old-user', ServerId: 'server-1' }
        ]));
        expect(container.textContent).toBe('Loading');

        await publishEnvelope(sessionEnvelope(true));
        expect(container.textContent).toBe('new-user:new-token');
    });

    it('rejects an old sign-in event after completion resolves with the new token', async () => {
        await mount();
        currentClient = newClient;
        await complete();
        await publishEnvelope(sessionEnvelope(true));
        expect(container.textContent).toBe('new-user:new-token');

        await act(async () => events.trigger(ServerConnections, 'localusersignedin', [
            { Id: 'old-user', ServerId: 'server-1' }
        ]));
        expect(container.textContent).toBe('new-user:new-token');
    });

    it('fences a late identity probe when a newer completion wins', async () => {
        await mount();
        currentClient = newClient;
        const pendingUser = deferredUser();
        newClient.getCurrentUser.mockImplementationOnce(() => pendingUser.promise);
        await complete();
        await publishEnvelope(sessionEnvelope(true));

        const newer = { ...receipt, switchId: 'switch-2', profileUserId: 'third-user', sessionEpoch: 2 };
        const newerClient = apiClient('third-user', 'third-token');
        currentClient = newerClient;
        envelope = sessionEnvelope(true, newer, 'third-token');
        await complete(newer);
        await act(async () => pendingUser.release({ Id: 'new-user', ServerId: 'server-1' }));
        expect(container.textContent).toBe('third-user:third-token');
    });

    it('fails closed on a completion that never becomes durable and releases its subscription', async () => {
        vi.useFakeTimers();
        await mount();
        currentClient = newClient;
        await complete();
        expect(container.textContent).toBe('Loading');

        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(container.textContent).toContain('HeaderServerUnavailable');
        expect(subscribers.size).toBe(0);
    });

    it('does not resurrect the user when the identity probe returns after timeout', async () => {
        vi.useFakeTimers();
        await mount();
        currentClient = newClient;
        const pendingUser = deferredUser();
        newClient.getCurrentUser.mockImplementationOnce(() => pendingUser.promise);
        envelope = sessionEnvelope(true);
        await complete();

        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(container.textContent).toContain('HeaderServerUnavailable');
        await act(async () => pendingUser.release({ Id: 'new-user', ServerId: 'server-1' }));
        expect(container.textContent).toContain('HeaderServerUnavailable');
    });

    it('shows unavailable if SDK reconstruction fails after identity verification', async () => {
        await mount();
        currentClient = newClient;
        vi.mocked(toApi).mockImplementationOnce(() => {
            throw new Error('SDK construction failed');
        });
        envelope = sessionEnvelope(true);

        await complete();
        expect(container.textContent).toContain('HeaderServerUnavailable');
    });

    it('restarts at public server selection without publishing old credentials or opening Home', async () => {
        const reloadPage = vi.fn();
        await mount(reloadPage);
        currentClient = newClient;
        vi.mocked(toApi).mockImplementationOnce(() => {
            throw new Error('SDK construction failed');
        });
        envelope = sessionEnvelope(true);
        await complete();

        const selectionLink = container.querySelector('a[href="#"]');
        expect(selectionLink?.textContent).toBe('ButtonChangeServer');
        await act(async () => {
            selectionLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(window.location.hash).toBe('#/selectserver');
        expect(reloadPage).toHaveBeenCalledOnce();

        await act(async () => root.unmount());
        container.remove();
        currentClient = oldClient;
        envelope = sessionEnvelope(false);
        connections.firstConnection = false;
        await mount(reloadPage, (
            <MemoryRouter initialEntries={[ '/selectserver' ]}>
                <Routes>
                    <Route element={<ConnectionRequired level='public' />}>
                        <Route path='/selectserver' element={<div>Server selection <Snapshot /><Link to='/home'>Home</Link><Link to='/login'>Login</Link></div>} />
                        <Route path='/login' element={<div>Login route <Snapshot /></div>} />
                    </Route>
                    <Route element={<ConnectionRequired level='user' />}>
                        <Route path='/home' element={<div>Protected Home</div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        ));

        expect(container.textContent).toContain('Server selection no-user:no-token');
        expect(container.textContent).not.toContain('old-user');
        await act(async () => events.trigger(ServerConnections, 'localusersignedin', [
            { Id: 'old-user', ServerId: 'server-1' }
        ]));
        expect(container.textContent).toContain('Server selection no-user:no-token');
        const homeLink = container.querySelector('a[href="/home"]');
        await act(async () => {
            homeLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(routeBootstrap.prepare).toHaveBeenCalled();
        expect(container.textContent).not.toContain('Protected Home');

        await act(async () => root.unmount());
        container.remove();
        await mount(reloadPage, (
            <MemoryRouter initialEntries={[ '/selectserver' ]}>
                <Routes>
                    <Route element={<ConnectionRequired level='public' />}>
                        <Route path='/selectserver' element={<Link to='/login'>Login</Link>} />
                        <Route path='/login' element={<div>Login route <Snapshot /></div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        ));
        const loginLink = container.querySelector('a[href="/login"]');
        await act(async () => {
            loginLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(container.textContent).toContain('Login route no-user:no-token');

        currentClient = apiClient('other-user', 'other-token', 'server-2');
        await act(async () => events.trigger(ServerConnections, 'localusersignedin', [
            { Id: 'other-user', ServerId: 'server-2' }
        ]));
        expect(container.textContent).toContain('Login route other-user:other-token');
    });

    it('preserves ordinary error-page navigation without the recovery callback', async () => {
        await mount(undefined, <ConnectionErrorPage state={ConnectionState.Unavailable} />);
        expect(container.querySelector('a[href="/selectserver"]')).not.toBeNull();
    });

    it('releases the pending subscription on unmount', async () => {
        await mount();
        await complete();
        expect(subscribers.size).toBe(1);

        await act(async () => root.unmount());
        expect(subscribers.size).toBe(0);
    });
});
