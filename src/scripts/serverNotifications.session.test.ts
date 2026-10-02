import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, notify, play, queue, setVolume } = vi.hoisted(() => ({
    client: {
        getCurrentUserId: () => 'user-a',
        serverInfo: () => ({ Id: 'server-1' })
    },
    notify: vi.fn(),
    play: vi.fn(),
    queue: vi.fn(),
    setVolume: vi.fn()
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: { getApiClients: () => [client] }
}));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => ({ captureBoundSessionRead: () => null })
}));
vi.mock('lib/profileSelector/sessionSwitch/remoteTrailer', () => ({ playBoundTrailer: vi.fn() }));
vi.mock('components/alert', () => ({ default: vi.fn() }));
vi.mock('components/focusManager', () => ({ default: { sendText: vi.fn() } }));
vi.mock('components/playback/playbackmanager', () => ({
    playbackManager: { play, queue, setVolume, isPlayingLocally: () => false }
}));
vi.mock('components/pluginManager', () => ({ pluginManager: { firstOfType: () => null } }));
vi.mock('components/router/appRouter', () => ({ appRouter: { showItem: vi.fn() } }));
vi.mock('components/toast/toast', () => ({ default: vi.fn() }));
vi.mock('scripts/inputManager', () => ({ default: { notify, handleCommand: vi.fn() } }));

import Events from 'utils/events';
import serverNotifications from './serverNotifications';

function deliver(message: Record<string, unknown>, isCurrent: () => boolean) {
    Events.trigger(client, 'message', [message, { isCurrent }]);
}

describe('serverNotifications captured delivery', () => {
    beforeEach(() => {
        notify.mockReset();
        play.mockReset();
        queue.mockReset();
        setVolume.mockReset();
        Reflect.deleteProperty(serverNotifications, '_callbacks');
        Reflect.deleteProperty(document.body.dataset, 'staleNotification');
    });

    it('does not dispatch an already stale remote Play command', () => {
        deliver({ MessageType: 'Play', Data: { ItemIds: ['movie-a'] } }, () => false);
        expect(notify).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
    });

    it('rechecks authority after a synchronous notification side effect', () => {
        let current = true;
        notify.mockImplementation(() => {
            current = false;
        });
        deliver({ MessageType: 'Play', Data: { ItemIds: ['movie-a'] } }, () => current);
        expect(play).not.toHaveBeenCalled();

        current = true;
        deliver({
            MessageType: 'GeneralCommand', Data: { Name: 'SetVolume', Arguments: { Volume: 42 } }
        }, () => current);
        expect(setVolume).not.toHaveBeenCalled();
    });

    it('stops a UserDataChanged batch when the first listener switches session', () => {
        let current = true;
        const observed = vi.fn((...args: unknown[]) => {
            if (args.length > 0) current = false;
        });
        Events.on(serverNotifications, 'UserDataChanged', observed);
        deliver({
            MessageType: 'UserDataChanged',
            Data: { UserId: 'user-a', UserDataList: [{ Id: 'first' }, { Id: 'second' }] }
        }, () => current);

        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0][2]).toEqual({ Id: 'first' });
    });

    it('forwards a current generic event with the original delivery context', () => {
        const observed = vi.fn();
        Events.on(serverNotifications, 'LibraryChanged', observed);
        const isCurrent = () => true;
        deliver({ MessageType: 'LibraryChanged', Data: { Id: 'library-a' } }, isCurrent);

        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0][3].isCurrent).toBe(isCurrent);
    });

    it.each([
        ['UserDataChanged', { UserId: 'user-a', UserDataList: [{ Id: 'first' }, { Id: 'second' }] }],
        ['LibraryChanged', { Id: 'library-a' }]
    ])('does not deliver %s to a second legacy DOM listener after synchronous revocation', (messageType, data) => {
        let current = true;
        const second = vi.fn(() => {
            document.body.dataset.staleNotification = 'delivered';
        });
        Events.on(serverNotifications, messageType, () => {
            current = false;
        });
        Events.on(serverNotifications, messageType, second);

        deliver({ MessageType: messageType, Data: data }, () => current);

        expect(second).not.toHaveBeenCalled();
        expect(document.body.dataset.staleNotification).toBeUndefined();
    });

    it('delivers a current notification to every subscriber with its original context', () => {
        const first = vi.fn();
        const second = vi.fn();
        const isCurrent = () => true;
        Events.on(serverNotifications, 'LibraryChanged', first);
        Events.on(serverNotifications, 'LibraryChanged', second);

        deliver({ MessageType: 'LibraryChanged', Data: { Id: 'library-a' } }, isCurrent);

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(first.mock.calls[0]).toEqual(second.mock.calls[0]);
        expect(first.mock.calls[0][3].isCurrent).toBe(isCurrent);
    });
});
