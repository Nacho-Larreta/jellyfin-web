import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lib/jellyfin-apiclient', () => ({
    ConnectionState: {
        SignedIn: 'SignedIn',
        ServerMismatch: 'ServerMismatch',
        ServerSignIn: 'ServerSignIn',
        ServerSelection: 'ServerSelection',
        ServerUpdateNeeded: 'ServerUpdateNeeded',
        Unavailable: 'Unavailable'
    },
    ServerConnections: {
        connect: vi.fn(),
        currentApiClient: vi.fn(),
        firstConnection: false,
        getApiClient: vi.fn(),
        setLocalApiClient: vi.fn()
    }
}));
vi.mock('components/loading/LoadingComponent', () => ({ default: () => 'Loading' }));
vi.mock('components/ConnectionErrorPage', () => ({ default: () => 'Connection error' }));
vi.mock('lib/profileSelector/navigation', () => ({ resolveProfileSelectorRoute: vi.fn() }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: vi.fn()
}));

import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';

import ConnectionRequired from './ConnectionRequired';

type TestClient = {
    isLoggedIn: () => boolean;
    serverAddress: () => string;
    serverId: () => string | undefined;
};

const address = 'https://jellyfin.example/web';
const provisional: TestClient = {
    isLoggedIn: () => false,
    serverAddress: () => address,
    serverId: () => undefined
};
const identified: TestClient = {
    isLoggedIn: () => false,
    serverAddress: () => address,
    serverId: () => 'discovered-server'
};

let currentClient: TestClient;
let root: Root;
let container: HTMLDivElement;

const connections = ServerConnections as unknown as {
    connect: ReturnType<typeof vi.fn>;
    currentApiClient: ReturnType<typeof vi.fn>;
    firstConnection: boolean;
    getApiClient: ReturnType<typeof vi.fn>;
    setLocalApiClient: ReturnType<typeof vi.fn>;
};

async function renderLoginRoute() {
    await act(async () => root.render(
        <MemoryRouter initialEntries={[ '/login' ]}>
            <Routes>
                <Route element={<ConnectionRequired level='public' />}>
                    <Route path='/login' element={<div>Login ready</div>} />
                </Route>
            </Routes>
        </MemoryRouter>
    ));
}

describe('first-server login route', () => {
    beforeEach(() => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        currentClient = provisional;
        connections.firstConnection = false;
        connections.connect.mockReset().mockResolvedValue({
            State: ConnectionState.ServerSignIn,
            ApiClient: identified,
            Servers: [{ Id: 'discovered-server', ManualAddress: address }]
        });
        connections.currentApiClient.mockReset().mockImplementation(() => currentClient);
        connections.getApiClient.mockReset().mockReturnValue(identified);
        connections.setLocalApiClient.mockReset().mockImplementation((client: TestClient) => {
            currentClient = client;
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ StartupWizardCompleted: true })
        }));
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });

    it('selects the confirmed registered client before authorizing login', async () => {
        await renderLoginRoute();

        expect(container.textContent).toContain('Login ready');
        expect(connections.getApiClient).toHaveBeenCalledWith('discovered-server');
        expect(connections.setLocalApiClient).toHaveBeenCalledWith(identified);
        expect(currentClient).toBe(identified);
    });

    it('keeps an already selected canonical saved-server client on the login route', async () => {
        currentClient = identified;

        await renderLoginRoute();

        expect(container.textContent).toContain('Login ready');
        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
    });

    it('does not replace an authenticated successor that appears during the public-info request', async () => {
        const successor: TestClient = {
            isLoggedIn: () => true,
            serverAddress: () => address,
            serverId: () => 'newer-server'
        };
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
            currentClient = successor;
            return { ok: true, json: async () => ({ StartupWizardCompleted: true }) };
        }));

        await renderLoginRoute();

        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
        expect(currentClient).toBe(successor);
        expect(container.textContent).not.toContain('Login ready');
    });

    it('does not select a response whose registered client or confirmed base path differs', async () => {
        connections.getApiClient.mockReturnValue(provisional);
        await renderLoginRoute();
        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Connection error');

        await act(async () => root.unmount());
        root = createRoot(container);
        connections.firstConnection = false;
        connections.getApiClient.mockReturnValue(identified);
        connections.connect.mockResolvedValue({
            State: ConnectionState.ServerSignIn,
            ApiClient: identified,
            Servers: [{ Id: 'discovered-server', ManualAddress: 'https://jellyfin.example/other' }]
        });
        await renderLoginRoute();

        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Connection error');
    });

    it('ignores an obsolete discovery response after the route unmounts', async () => {
        let resolveConnection: ((value: unknown) => void) | undefined;
        connections.connect.mockReturnValue(new Promise(resolve => {
            resolveConnection = resolve;
        }));
        await renderLoginRoute();

        await act(async () => root.unmount());
        root = createRoot(container);
        await act(async () => resolveConnection?.({
            State: ConnectionState.ServerSignIn,
            ApiClient: identified,
            Servers: [{ Id: 'discovered-server', ManualAddress: address }]
        }));

        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
    });

    it('keeps failed discovery closed without selecting a client', async () => {
        connections.connect.mockResolvedValue({ State: ConnectionState.ServerMismatch });

        await renderLoginRoute();

        expect(container.textContent).toContain('Connection error');
        expect(connections.setLocalApiClient).not.toHaveBeenCalled();
    });
});
