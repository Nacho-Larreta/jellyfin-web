import { ApiClient } from 'jellyfin-apiclient';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCESS_TOKEN = 'CONSUMER_TOKEN_&= +/%?#ü';
const DEVICE_ID = 'CONSUMER_DEVICE_&= +/%?#ñ';

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];

    readonly url: string;
    readonly readyState = FakeWebSocket.CONNECTING;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onopen: (() => void) | null = null;

    constructor(url: string | URL) {
        this.url = url.toString();
        FakeWebSocket.instances.push(this);
    }
}

function collectInspectableStrings(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === 'string') {
        return [ value ];
    }

    if (
        value === null
        || (typeof value !== 'object' && typeof value !== 'function')
        || seen.has(value)
    ) {
        return [];
    }

    seen.add(value);
    return Object.entries(value as Record<string, unknown>)
        .flatMap(([ key, nestedValue ]) => [ key, ...collectInspectableStrings(nestedValue, seen) ]);
}

describe('installed jellyfin-apiclient WebSocket authentication contract', () => {
    let originalWebSocket: typeof WebSocket;

    beforeEach(() => {
        originalWebSocket = globalThis.WebSocket;
        globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
        FakeWebSocket.instances.length = 0;
        vi.useFakeTimers();
    });

    afterEach(() => {
        globalThis.WebSocket = originalWebSocket;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        [ 'https://media.example.test/jellyfin', 'wss:', '/jellyfin/socket' ],
        [ 'http://media.example.test/emby', 'ws:', '/embywebsocket' ]
    ])('opens %s with canonical encoded credentials', (serverAddress, protocol, pathname) => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const client = new ApiClient(
            serverAddress,
            'Consumer Contract',
            '1.0.0',
            'Synthetic Device',
            DEVICE_ID
        );
        Object.assign(client, { enableAutomaticBitrateDetection: false });
        client.setAuthenticationInfo(ACCESS_TOKEN, 'synthetic-user');

        client.openWebSocket();

        expect(FakeWebSocket.instances).toHaveLength(1);
        const socket = FakeWebSocket.instances[0];
        expect(socket).toBeDefined();
        const socketUrl = new URL(socket.url);

        expect(socketUrl.protocol).toBe(protocol);
        expect(socketUrl.pathname).toBe(pathname);
        expect(socketUrl.searchParams.get('ApiKey')).toBe(ACCESS_TOKEN);
        expect(socketUrl.searchParams.get('deviceId')).toBe(DEVICE_ID);
        expect(socketUrl.searchParams.has('api_key')).toBe(false);
        expect([ ...socketUrl.searchParams.keys() ]).toStrictEqual([ 'ApiKey', 'deviceId' ]);
        expect(socket.url).not.toContain(ACCESS_TOKEN);
        expect(socket.url).not.toContain(DEVICE_ID);
        expect(socket.onmessage).toBeTypeOf('function');
        expect(socket.onopen).toBeTypeOf('function');
        expect(socket.onerror).toBeTypeOf('function');
        expect(socket.onclose).toBeTypeOf('function');

        socket.onerror?.();
        socket.onclose?.();
        vi.runOnlyPendingTimers();

        const loggedValues = [
            ...debugSpy.mock.calls,
            ...errorSpy.mock.calls,
            ...logSpy.mock.calls,
            ...warnSpy.mock.calls
        ].flatMap((call) => call.flatMap((value) => collectInspectableStrings(value)));
        const forbiddenLogValues = [
            ACCESS_TOKEN,
            DEVICE_ID,
            encodeURIComponent(ACCESS_TOKEN),
            encodeURIComponent(DEVICE_ID),
            socket.url
        ];

        for (const forbiddenValue of forbiddenLogValues) {
            expect(loggedValues.some((loggedValue) => loggedValue.includes(forbiddenValue))).toBe(false);
        }
    });
});
