import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPublicSplashscreen } from './autoBackdropBranding';

const address = 'https://server.example/jellyfin/';

afterEach(() => vi.unstubAllGlobals());

describe('public automatic splashscreen transport', () => {
    it('uses only the fixed unauthenticated paths and returns no image when disabled', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ SplashscreenEnabled: false }), {
            headers: { 'Content-Type': 'application/json' }
        }));
        vi.stubGlobal('fetch', fetcher);
        const result = await readPublicSplashscreen(address, new window['AbortController']().signal, () => undefined);

        expect(result).toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
        const [url, options] = fetcher.mock.calls[0];
        expect(url).toBe('https://server.example/jellyfin/Branding/Configuration');
        expect(options).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
        expect(options.headers).toBeUndefined();
    });

    it('stops between options and image when the selected server changes', async () => {
        let current = true;
        let release;
        const pending = new Promise(resolve => {
            release = resolve;
        });
        const fetcher = vi.fn(() => pending);
        vi.stubGlobal('fetch', fetcher);
        const result = readPublicSplashscreen(address, new window['AbortController']().signal, () => {
            if (!current) throw new Error('stale');
        });
        current = false;
        release(new Response(JSON.stringify({ SplashscreenEnabled: true }), {
            headers: { 'Content-Type': 'application/json' }
        }));

        await expect(result).rejects.toThrow('stale');
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('rejects private-looking bases and non-raster image responses', async () => {
        const fetcher = vi.fn(async url => String(url).endsWith('/Configuration') ?
            new Response(JSON.stringify({ SplashscreenEnabled: true }), {
                headers: { 'Content-Type': 'application/json' }
            }) :
            new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
        vi.stubGlobal('fetch', fetcher);
        const signal = new window['AbortController']().signal;
        await expect(readPublicSplashscreen('https://user:password@server.example/jellyfin', signal, () => undefined))
            .rejects.toThrow('Invalid selected server');
        expect(fetcher).not.toHaveBeenCalled();
        await expect(readPublicSplashscreen(address, signal, () => undefined))
            .rejects.toThrow('Splashscreen unavailable');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
