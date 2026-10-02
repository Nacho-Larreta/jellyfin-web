import { CancelledError, QueryClient } from '@tanstack/react-query';
import { type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { SessionAdmissionBarrier } from 'lib/profileSelector/sessionSwitch/barrier';
import { createBoundSessionReadPort, type FreshSessionAuthority } from 'lib/profileSelector/sessionSwitch/boundRequests';
import { createActiveProfileSession } from 'lib/profileSelector/sessionSwitch/model';
import { createSessionSwitchEnvelope } from 'lib/profileSelector/sessionSwitch/store';

import { createSessionScopedReadApi, relativeSessionReadPath } from './sessionReadApi';

const serverId = 'server-1';
const deviceId = 'device-1';
const userId = 'user-1';
const token = 'secret-token';

function setup(selectorEnabled = true) {
    const session = createActiveProfileSession(serverId, deviceId, userId, token, 1);
    const barrier = new SessionAdmissionBarrier();
    let authority: FreshSessionAuthority = {
        serverId,
        userId,
        accessToken: token,
        selectorEnabled,
        authorityRevision: 2,
        envelope: selectorEnabled ? createSessionSwitchEnvelope(session) : null
    };
    const client = {
        serverId: () => serverId,
        serverAddress: () => 'https://localhost:8096/jellyfin',
        deviceId: () => deviceId,
        getCurrentUserId: () => userId,
        accessToken: () => token,
        appName: () => 'Web',
        appVersion: () => '1',
        deviceName: () => 'Browser'
    };
    const connections = {
        getApiClient: () => client,
        currentApiClient: () => client,
        getSessionDeviceId: () => deviceId,
        readFreshSessionAuthority: () => authority
    };
    barrier.synchronize(authority.envelope);
    const createPort = () => createBoundSessionReadPort(client, connections, barrier, authority)!;
    const setAuthority = (next: FreshSessionAuthority) => {
        authority = next;
    };
    return { client, connections, barrier, createPort, setAuthority, getAuthority: () => authority };
}

function successTransport() {
    return vi.fn<AxiosAdapter>(async config => ({
        data: { Items: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config
    }));
}

describe('session scoped Search SDK transport', () => {
    it('accepts only exact descendants of the captured server base path', () => {
        expect(relativeSessionReadPath('/jellyfin/Items', '/jellyfin')).toBe('/Items');
        expect(relativeSessionReadPath('/jellyfin/Items', '/jellyfin/')).toBe('/Items');
        expect(relativeSessionReadPath('/Items', '/')).toBe('/Items');
        expect(relativeSessionReadPath('/jellyfin-other/Items', '/jellyfin')).toBeNull();
        expect(relativeSessionReadPath('/another/Items', '/jellyfin')).toBeNull();
    });

    it('does not reuse a query generation when a server is removed and re-added at the same revision', () => {
        const removed = setup(false);
        const previous = removed.createPort();
        const readded = setup(false);
        const current = readded.createPort();

        expect(previous.identity).toMatchObject({
            serverId, profileUserId: userId, sessionEpoch: 0
        });
        expect(current.identity).toMatchObject({
            serverId, profileUserId: userId, sessionEpoch: 0
        });
        expect(previous.identity.authorityGeneration).not.toBe(current.identity.authorityGeneration);
    });

    it('uses the generated SDK and denies an old captured API before network', async () => {
        const scope = setup();
        const transport = successTransport();
        const old = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        await expect(old.getItems({ userId })).resolves.toHaveProperty('Items', []);
        expect(transport).toHaveBeenCalledTimes(1);

        scope.setAuthority({ ...scope.getAuthority(), authorityRevision: 3 });
        await expect(old.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).toHaveBeenCalledTimes(1);

        const current = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        await expect(current.getItems({ userId })).resolves.toHaveProperty('Items', []);
        expect(transport).toHaveBeenCalledTimes(2);
    });

    it('routes only the three inspected generated Search GET operations', async () => {
        const scope = setup();
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        await read.getItems({ userId });
        await read.getArtists({ userId });
        await read.getPersons({ userId });

        const paths = transport.mock.calls.map(([config]) => new URL(config.url!).pathname);
        expect(paths).toEqual(['/jellyfin/Items', '/jellyfin/Artists', '/jellyfin/Persons']);
        expect(transport.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
        expect(transport.mock.calls.every(([config]) => {
            const authorization = config.headers.get('Authorization');
            return typeof authorization === 'string' && authorization.includes('Token=');
        })).toBe(true);
    });

    it('routes only the four inspected Home GET operations under the captured user', async () => {
        const scope = setup();
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);

        await read.getUserViews({ userId });
        await read.getResumeItems({ userId });
        await read.getNextUp({ userId });
        await read.getLatestMedia({ userId });

        expect(transport.mock.calls.map(([config]) => new URL(config.url!).pathname)).toEqual([
            '/jellyfin/UserViews',
            '/jellyfin/UserItems/Resume',
            '/jellyfin/Shows/NextUp',
            '/jellyfin/Items/Latest'
        ]);
        expect(transport.mock.calls.every(([config]) => config.method === 'get'
            && new URL(config.url!).searchParams.getAll('userId').length === 1
            && new URL(config.url!).searchParams.get('userId') === userId
            && typeof config.headers.get('Authorization') === 'string')).toBe(true);

        await expect(read.getUserViews({ userId: 'other' })).rejects.toBeInstanceOf(CancelledError);
        await expect(read.getResumeItems({ userId: 'other' })).rejects.toBeInstanceOf(CancelledError);
        await expect(read.getNextUp({ userId: 'other' })).rejects.toBeInstanceOf(CancelledError);
        await expect(read.getLatestMedia({ userId: 'other' })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).toHaveBeenCalledTimes(4);
    });

    it('reads only the captured current user from the exact Users/Me route', async () => {
        const scope = setup();
        const transport = vi.fn<AxiosAdapter>(async config => ({
            data: { Id: userId, ServerId: serverId },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
        }));
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);

        await expect(read.getCurrentUser()).resolves.toMatchObject({ Id: userId, ServerId: serverId });
        const request = new URL(transport.mock.calls[0][0].url!);
        expect(request.pathname).toBe('/jellyfin/Users/Me');
        expect(request.search).toBe('');
        expect(transport.mock.calls[0][0].method).toBe('get');

        transport.mockImplementationOnce(async config => ({
            data: { Id: 'other-user', ServerId: serverId },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
        }));
        await expect(read.getCurrentUser()).rejects.toBeInstanceOf(CancelledError);
        transport.mockImplementationOnce(async config => ({
            data: { Id: userId, ServerId: 'other-server' },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
        }));
        await expect(read.getCurrentUser()).rejects.toBeInstanceOf(CancelledError);
    });

    it('fences a late Users/Me response after its captured authority closes', async () => {
        const scope = setup();
        let resolve!: (value: Awaited<ReturnType<AxiosAdapter>>) => void;
        const transport = vi.fn<AxiosAdapter>(() => new Promise(yes => {
            resolve = yes;
        }));
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        const pending = read.getCurrentUser();
        await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());

        scope.barrier.close('switch-home');
        resolve({
            data: { Id: userId, ServerId: serverId },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: transport.mock.calls[0][0]
        });
        await expect(pending).rejects.toBeInstanceOf(CancelledError);
    });

    it('rejects wrong user binding and exposes no raw SDK mutation or override surface', async () => {
        const scope = setup();
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);

        await expect(read.getItems({ userId: 'other' })).rejects.toBeInstanceOf(CancelledError);
        expect(Object.keys(read).sort((left, right) => left.localeCompare(right)))
            .toEqual([
                'assertCurrent', 'getArtists', 'getCurrentUser', 'getItems', 'getLatestMedia', 'getNextUp',
                'getPersons', 'getResumeItems', 'getUserViews', 'identity'
            ]);
        expect(Reflect.get(read, 'api')).toBeUndefined();
        expect(Reflect.get(read, 'post')).toBeUndefined();
        expect(Reflect.get(read, 'update')).toBeUndefined();
        expect(transport).not.toHaveBeenCalled();
    });

    it('fences late success and failure even when the transport ignores cancellation', async () => {
        const scope = setup();
        let resolve!: (value: Awaited<ReturnType<AxiosAdapter>>) => void;
        let reject!: (error: Error) => void;
        const transport = vi.fn<AxiosAdapter>(() => new Promise((yes, no) => {
            resolve = value => yes(value);
            reject = no;
        }));
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        const pending = read.getItems({ userId });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
        scope.barrier.close('switch-1');
        resolve({ data: { Items: ['old'] }, status: 200, statusText: 'OK', headers: {}, config: transport.mock.calls[0][0] });
        await expect(pending).rejects.toBeInstanceOf(CancelledError);

        scope.barrier.reopen('switch-1');
        const failing = read.getItems({ userId });
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
        scope.barrier.close('switch-2');
        reject(new Error('late transport failure'));
        await expect(failing).rejects.toBeInstanceOf(CancelledError);
    });

    it('only permits explicit selector-disabled durable authority', () => {
        const scope = setup(false);
        expect(scope.createPort()).not.toBeNull();
        scope.setAuthority({ ...scope.getAuthority(), selectorEnabled: undefined });
        expect(scope.createPort()).toBeNull();
        scope.setAuthority({ ...scope.getAuthority(), selectorEnabled: false, accessToken: null });
        expect(scope.createPort()).toBeNull();
    });

    it('fences a replaced credential at the same profile and epoch', async () => {
        const scope = setup();
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        const changedSession = createActiveProfileSession(serverId, deviceId, userId, 'replacement-token', 1);
        scope.setAuthority({
            ...scope.getAuthority(), accessToken: 'replacement-token',
            authorityRevision: 3, envelope: createSessionSwitchEnvelope(changedSession)
        });
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).not.toHaveBeenCalled();
    });

    it('fences a token replacement even when the durable revision and epoch repeat', async () => {
        const scope = setup(false);
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        scope.setAuthority({ ...scope.getAuthority(), accessToken: 'replacement-token' });
        vi.spyOn(scope.client, 'accessToken').mockReturnValue('replacement-token');

        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).not.toHaveBeenCalled();
    });

    it('denies installed address, device and client drift before dispatch', async () => {
        const scope = setup(false);
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);

        const address = vi.spyOn(scope.client, 'serverAddress').mockReturnValue('https://other.example');
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        address.mockRestore();

        const device = vi.spyOn(scope.client, 'deviceId').mockReturnValue('other-device');
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        device.mockRestore();

        const sessionDevice = vi.spyOn(scope.connections, 'getSessionDeviceId').mockReturnValue('other-device');
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        sessionDevice.mockRestore();

        const installed = vi.spyOn(scope.connections, 'currentApiClient').mockReturnValue(null as never);
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        installed.mockRestore();
        expect(transport).not.toHaveBeenCalled();
    });

    it('fences logout and permits only a newly captured login replacement', async () => {
        const scope = setup(false);
        const transport = successTransport();
        const old = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        scope.setAuthority({ ...scope.getAuthority(), userId: null, accessToken: null });
        await expect(old.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        expect(scope.createPort()).toBeNull();

        scope.setAuthority({ ...scope.getAuthority(), userId, accessToken: 'new-login-token' });
        vi.spyOn(scope.client, 'accessToken').mockReturnValue('new-login-token');
        await expect(old.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        const current = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        await expect(current.getItems({ userId })).resolves.toHaveProperty('Items', []);
        expect(transport).toHaveBeenCalledOnce();
        expect(current.identity.authorityGeneration).not.toBe(old.identity.authorityGeneration);
    });

    it('denies an unresolved durable switch marker before network', async () => {
        const scope = setup();
        const transport = successTransport();
        const read = createSessionScopedReadApi(scope.client, scope.createPort(), transport);
        const envelope = scope.getAuthority().envelope!;
        scope.setAuthority({
            ...scope.getAuthority(),
            envelope: {
                ...envelope,
                marker: {
                    kind: 'PendingSwitch', phase: 'Preparing', playbackReport: null, switchId: 'switch-1',
                    serverId, deviceId, oldProfileUserId: userId, oldEpoch: 1,
                    targetProfileUserId: 'next-user', coordinatorId: 'coordinator-1',
                    fencingToken: 1, leaseExpiresAtMs: 1000, updatedAtMs: 0
                }
            }
        });
        await expect(read.getItems({ userId })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).not.toHaveBeenCalled();
    });

    it('settles a caller-aborted lease once and fences a late transport response', async () => {
        const scope = setup();
        const lease = scope.createPort();
        const settle = vi.fn();
        const port = {
            ...lease,
            acquire: () => {
                const acquired = lease.acquire();
                return { ...acquired, settle: () => {
                    settle();
                    acquired.settle();
                } };
            }
        };
        let resolve!: (value: Awaited<ReturnType<AxiosAdapter>>) => void;
        const transport = vi.fn<AxiosAdapter>(() => new Promise(done => {
            resolve = value => done(value);
        }));
        const read = createSessionScopedReadApi(scope.client, port, transport);
        const caller = new window['AbortController']();
        const pending = read.getItems({ userId }, caller.signal);
        await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
        caller.abort();
        resolve({ data: { Items: [] }, status: 200, statusText: 'OK', headers: {}, config: transport.mock.calls[0][0] });
        await expect(pending).rejects.toBeInstanceOf(CancelledError);
        expect(settle).toHaveBeenCalledOnce();
    });

    it('settles each failed attempt once and reacquires a fresh lease for a retry', async () => {
        const scope = setup();
        const port = scope.createPort();
        const settle = vi.fn();
        const acquire = vi.fn(() => {
            const lease = port.acquire();
            return { ...lease, settle: () => {
                settle();
                lease.settle();
            } };
        });
        const transport = successTransport();
        transport.mockRejectedValueOnce(new Error('transient'));
        const read = createSessionScopedReadApi(scope.client, { ...port, acquire }, transport);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });

        await expect(queryClient.fetchQuery({
            queryKey: ['retry', read.identity],
            queryFn: ({ signal }) => read.getItems({ userId }, signal)
        })).resolves.toHaveProperty('Items', []);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(settle).toHaveBeenCalledTimes(2);
    });

    it('does not dispatch a retry after durable authority changes', async () => {
        const scope = setup();
        const port = scope.createPort();
        const settle = vi.fn();
        const transport = successTransport();
        transport.mockImplementationOnce(async () => {
            scope.setAuthority({ ...scope.getAuthority(), authorityRevision: 3 });
            throw new Error('transient before replacement');
        });
        const read = createSessionScopedReadApi(scope.client, {
            ...port,
            acquire: () => {
                const lease = port.acquire();
                return { ...lease, settle: () => {
                    settle();
                    lease.settle();
                } };
            }
        }, transport);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0 } } });

        await expect(queryClient.fetchQuery({
            queryKey: ['replaced', read.identity],
            queryFn: ({ signal }) => read.getItems({ userId }, signal)
        })).rejects.toBeInstanceOf(CancelledError);
        expect(transport).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
    });
});
