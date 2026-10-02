import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { describe, expect, it, vi } from 'vitest';

import type { BoundSessionReadPort } from 'lib/profileSelector/sessionSwitch/boundRequests';
import { SessionReadCancelledError } from './sessionReadApi';
import { createSessionImageRead } from './sessionImageRead';

const itemId = '5dae694ba968f2676a64ceb6934f667b';
const token = 'private-session-token';
const descriptor = { itemId, type: ImageType.Backdrop, index: 0, tag: 'tag-a', fillWidth: 640, fillHeight: 360, quality: 84 };

function signal(): AbortSignal {
    return new window['AbortController']().signal;
}

function setup(transport: typeof fetch) {
    let current = true;
    let settled = 0;
    const leaseAbort = new window['AbortController']();
    const lease = {
        signal: leaseAbort.signal,
        settle: () => {
            settled++;
        }
    };
    const port = {
        basePath: 'https://local.test/jellyfin',
        binding: { deviceId: 'device-a', credentialRef: { token } },
        assertCurrent: () => { if (!current) throw new Error('stale'); },
        acquire: () => lease
    } as unknown as BoundSessionReadPort;
    const client = { appName: () => 'Web', appVersion: () => '1', deviceName: () => 'Browser' };
    return {
        read: createSessionImageRead(client, port, transport),
        stale: () => { current = false; },
        abortLease: () => leaseAbort.abort(),
        settled: () => settled
    };
}

function imageResponse(bytes = new Uint8Array([1, 2, 3]), type = 'image/png'): Response {
    return new Response(bytes, { status: 200, headers: { 'Content-Type': type } });
}

describe('bound Home image transport', () => {
    it('sends only an allowlisted image path under the captured base with header-only authority', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
        const { read, settled } = setup(fetcher);
        const blob = await read.fetchImage(descriptor, signal(), 1024);
        const [url, init] = fetcher.mock.calls[0];
        const parsed = new URL(String(url));

        expect(blob.type).toBe('image/png');
        expect(parsed.origin + parsed.pathname).toBe(`https://local.test/jellyfin/Items/${itemId}/Images/Backdrop`);
        expect(parsed.searchParams.get('imageIndex')).toBe('0');
        expect(parsed.searchParams.get('fillWidth')).toBe('640');
        expect(parsed.href).not.toContain(token);
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
        expect((init?.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
        expect((init?.headers as Record<string, string>).Authorization).toContain('Token="private-session-token"');
        expect(settled()).toBe(1);
    });

    it('denies stale authority before dispatch and after a late body without leaking a blob', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
        const first = setup(fetcher);
        first.stale();
        await expect(first.read.fetchImage(descriptor, signal(), 1024))
            .rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(fetcher).not.toHaveBeenCalled();

        let release!: () => void;
        const pending = new Promise<Response>(resolve => {
            release = () => resolve(imageResponse());
        });
        const lateFetch = vi.fn<typeof fetch>(() => pending);
        const late = setup(lateFetch);
        const result = late.read.fetchImage(descriptor, signal(), 1024);
        late.stale();
        release();
        await expect(result).rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(late.settled()).toBe(1);
    });

    it('rejects an authority change during streamed bytes after the response was accepted', async () => {
        let send!: () => void;
        const body = new window['ReadableStream']<Uint8Array>({
            start(controller) {
                send = () => {
                    controller.enqueue(new Uint8Array([1, 2]));
                    controller.close();
                };
            }
        });
        const fetcher = vi.fn<typeof fetch>(async () => new Response(body, {
            headers: { 'Content-Type': 'image/png' }
        }));
        const { read, stale, settled } = setup(fetcher);
        const result = read.fetchImage(descriptor, signal(), 1024);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        stale();
        send();

        await expect(result).rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(settled()).toBe(1);
    });

    it.each(['caller', 'lease'])('combines %s cancellation with the request signal even if transport resolves late', async source => {
        let release!: () => void;
        const pending = new Promise<Response>(resolve => {
            release = () => resolve(imageResponse());
        });
        const fetcher = vi.fn<typeof fetch>(() => pending);
        const { read, abortLease, settled } = setup(fetcher);
        const caller = new window['AbortController']();
        const result = read.fetchImage(descriptor, caller.signal, 1024);
        if (source === 'caller') caller.abort();
        else abortLease();
        const requestSignal = fetcher.mock.calls[0][1]?.signal;
        expect(requestSignal?.aborted).toBe(true);
        release();
        await expect(result).rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(settled()).toBe(1);
    });

    it.each([
        ['SVG', () => imageResponse(undefined, 'image/svg+xml')],
        ['HTTP error', () => new Response(null, { status: 404 })],
        ['oversized streamed body', () => imageResponse(new Uint8Array(5))]
    ])('rejects %s without anonymous retry', async (_name, response) => {
        const fetcher = vi.fn<typeof fetch>(async () => response());
        const { read } = setup(fetcher);
        await expect(read.fetchImage(descriptor, signal(), 4)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('rejects an untrusted free-form item path before network', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
        const { read } = setup(fetcher);
        await expect(read.fetchImage({ ...descriptor, itemId: '../Users/Me' }, signal(), 1024))
            .rejects.toThrow('Invalid Home image descriptor');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('treats a redirected or failed cross-origin fetch as unavailable without retry', async () => {
        const redirected = imageResponse();
        Object.defineProperty(redirected, 'redirected', { value: true });
        const redirectFetch = vi.fn<typeof fetch>(async () => redirected);
        await expect(setup(redirectFetch).read.fetchImage(descriptor, signal(), 1024)).rejects.toThrow();
        expect(redirectFetch).toHaveBeenCalledOnce();

        const corsFetch = vi.fn<typeof fetch>(async () => {
            throw new TypeError('Failed to fetch');
        });
        await expect(setup(corsFetch).read.fetchImage(descriptor, signal(), 1024)).rejects.toThrow();
        expect(corsFetch).toHaveBeenCalledOnce();
    });

    it('cancels an invalid MIME response body without retry', async () => {
        const cancel = vi.fn();
        const body = new window['ReadableStream']<Uint8Array>({ cancel });
        const fetcher = vi.fn<typeof fetch>(async () => new Response(body, {
            headers: { 'Content-Type': 'text/html' }
        }));

        await expect(setup(fetcher).read.fetchImage(descriptor, signal(), 1024)).rejects.toThrow();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(fetcher).toHaveBeenCalledOnce();
    });
});
