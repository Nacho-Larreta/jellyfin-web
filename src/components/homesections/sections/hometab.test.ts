import { CancelledError } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('components/focusManager', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('components/homesections/sections/tvHomeHero', () => ({
    destroyTvHomeHero: vi.fn((element: HTMLElement) => {
        element.innerHTML = '';
        element.classList.add('hide');
    }),
    loadTvHomeHero: vi.fn(async () => undefined)
}));
vi.mock('components/homesections/sections/tvHomeDashboard', () => ({
    destroyTvHomeDashboard: vi.fn((element: HTMLElement) => {
        element.innerHTML = '';
        element.classList.add('hide');
    }),
    loadTvHomeDashboard: vi.fn(async () => undefined),
    showUnavailableTvHomeDashboard: vi.fn((element: HTMLElement) => { element.textContent = 'Home unavailable'; })
}));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: { currentApiClient: vi.fn() } }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: vi.fn(() => ({ captureBoundSessionRead: vi.fn() }))
}));
vi.mock('utils/jellyfin-apiclient/sessionReadApi', async importOriginal => ({
    ...await importOriginal<typeof import('utils/jellyfin-apiclient/sessionReadApi')>(),
    createSessionScopedReadApi: vi.fn()
}));
vi.mock('elements/emby-itemscontainer/emby-itemscontainer', () => ({}));

import { loadTvHomeDashboard, showUnavailableTvHomeDashboard } from 'components/homesections/sections/tvHomeDashboard';
import { loadTvHomeHero } from 'components/homesections/sections/tvHomeHero';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

import HomeTab from '../../../controllers/hometab';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

function view() {
    const element = document.createElement('div');
    const hero = document.createElement('div');
    hero.className = 'tvHomeHero hide';
    const dashboard = document.createElement('div');
    dashboard.className = 'tvHomeDashboard hide';
    element.append(hero, dashboard);
    return element;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('HomeTab bound read resume', () => {
    it('clears an already rendered A hero and dashboard synchronously on pause', () => {
        const element = view();
        const hero = element.querySelector('.tvHomeHero')!;
        const dashboard = element.querySelector('.tvHomeDashboard')!;
        hero.textContent = 'A hero';
        dashboard.textContent = 'A dashboard';
        hero.classList.remove('hide');
        dashboard.classList.remove('hide');
        expect(hero.textContent).toBe('A hero');
        expect(dashboard.textContent).toBe('A dashboard');

        new HomeTab(element).onPause();

        expect(hero.innerHTML).toBe('');
        expect(dashboard.innerHTML).toBe('');
        expect(hero.classList.contains('hide')).toBe(true);
        expect(dashboard.classList.contains('hide')).toBe(true);
    });

    it('captures a fresh port on the stable entry and renders a current Home', async () => {
        const client = { serverId: () => 'server-a' };
        const port = { identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 0 } };
        const capture = vi.fn(() => port);
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: capture } as never);
        vi.mocked(createSessionScopedReadApi).mockReturnValue({
            identity: port.identity,
            assertCurrent: vi.fn(),
            getCurrentUser: vi.fn(async () => ({ Id: 'user-a', ServerId: 'server-a' }))
        } as never);

        const controller = new HomeTab(view());
        await controller.onResume({});

        expect(capture).toHaveBeenCalledWith(client);
        expect(loadTvHomeHero).toHaveBeenCalledOnce();
        expect(loadTvHomeDashboard).toHaveBeenCalledOnce();
        expect(showUnavailableTvHomeDashboard).not.toHaveBeenCalled();
    });

    it('rejects late A user completion after pause and a successful B resume', async () => {
        const oldUser = deferred<{ Id: string; ServerId: string }>();
        const oldClient = { serverId: () => 'server-a' };
        const nextClient = { serverId: () => 'server-b' };
        const oldPort = { identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1 } };
        const nextPort = { identity: { serverId: 'server-b', profileUserId: 'user-b', sessionEpoch: 2 } };
        vi.mocked(ServerConnections.currentApiClient)
            .mockReturnValueOnce(oldClient as never)
            .mockReturnValue(nextClient as never);
        const capture = vi.fn().mockReturnValueOnce(oldPort).mockReturnValue(nextPort);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: capture } as never);
        vi.mocked(createSessionScopedReadApi)
            .mockReturnValueOnce({
                identity: oldPort.identity,
                assertCurrent: vi.fn(),
                getCurrentUser: () => oldUser.promise
            } as never)
            .mockReturnValue({
                identity: nextPort.identity,
                assertCurrent: vi.fn(),
                getCurrentUser: async () => ({ Id: 'user-b', ServerId: 'server-b' })
            } as never);

        const controller = new HomeTab(view());
        const previous = controller.onResume({});
        controller.onPause();
        await controller.onResume({});
        oldUser.resolve({ Id: 'user-a', ServerId: 'server-a' });
        await previous;

        expect(loadTvHomeDashboard).toHaveBeenCalledOnce();
        expect(vi.mocked(loadTvHomeDashboard).mock.calls[0][1].user.Id).toBe('user-b');
    });

    it('shows the existing error state when no fresh authority port is available', async () => {
        const client = { serverId: () => 'server-a' };
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => null } as never);

        const controller = new HomeTab(view());
        await controller.onResume({});

        expect(showUnavailableTvHomeDashboard).toHaveBeenCalledOnce();
        expect(loadTvHomeHero).not.toHaveBeenCalled();
        expect(loadTvHomeDashboard).not.toHaveBeenCalled();
    });

    it('does not turn a base cancellation into a legacy fallback or error state', async () => {
        const client = { serverId: () => 'server-a' };
        const port = { identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1 } };
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => port } as never);
        vi.mocked(createSessionScopedReadApi).mockReturnValue({
            identity: port.identity,
            assertCurrent: vi.fn(),
            getCurrentUser: async () => {
                throw new CancelledError();
            }
        } as never);

        const controller = new HomeTab(view());
        await controller.onResume({});

        expect(showUnavailableTvHomeDashboard).not.toHaveBeenCalled();
        expect(loadTvHomeDashboard).not.toHaveBeenCalled();
    });

    it('does not log an authenticated Users/Me error object', async () => {
        const secret = 'secret-authorization-marker';
        const failure = Object.assign(new Error('private transport detail'), {
            config: { headers: { Authorization: secret } }
        });
        const client = { serverId: () => 'server-a' };
        const port = { identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1 } };
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client as never);
        vi.mocked(getWebSessionSwitchApplication).mockReturnValue({ captureBoundSessionRead: () => port } as never);
        vi.mocked(createSessionScopedReadApi).mockReturnValue({
            identity: port.identity,
            assertCurrent: vi.fn(),
            getCurrentUser: async () => {
                throw failure;
            }
        } as never);
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await new HomeTab(view()).onResume({});

            expect(log).toHaveBeenCalledOnce();
            expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
            expect(JSON.stringify(log.mock.calls)).not.toContain('config');
        } finally {
            log.mockRestore();
        }
    });
});
