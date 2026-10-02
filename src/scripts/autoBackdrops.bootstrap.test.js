import { afterEach, expect, it, vi } from 'vitest';

vi.mock('scripts/browser', () => ({ default: { slow: false, tv: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlayingLocally: () => false } }));
vi.mock('scripts/settings/userSettings', () => ({ enableBackdrops: () => true }));
vi.mock('scripts/libraryMenu', () => ({ default: { getTopParentId: () => '' } }));
vi.mock('components/viewManager/viewManager', () => ({ default: { currentView: vi.fn() } }));
vi.mock('utils/dashboard', () => ({
    pageClassOn: (event, className, callback) => document.addEventListener(event, occurrence => {
        if (occurrence.target.classList.contains(className)) callback.call(occurrence.target, occurrence);
    })
}));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: vi.fn(), getApiClient: vi.fn(), subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
} }));

import viewManager from '../components/viewManager/viewManager';
import { clearBackdrop } from '../components/backdrop/backdrop';
import { ServerConnections } from 'lib/jellyfin-apiclient';

afterEach(() => {
    clearBackdrop();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
});

it('shows public branding when the legacy login page became visible before the backdrop module loaded', async () => {
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>';
    const page = document.createElement('div');
    page.className = 'page standalonePage backdropPage mainAnimatedPage';
    page.setAttribute('data-backdroptype', 'splashscreen');
    document.body.append(page);

    const client = { serverId: () => 'server-a', serverAddress: () => 'https://server.example' };
    vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client);
    vi.mocked(ServerConnections.getApiClient).mockReturnValue(client);
    vi.mocked(viewManager.currentView).mockReturnValue(page);
    const fetcher = vi.fn(async url => String(url).endsWith('/Branding/Configuration') ?
        new Response(JSON.stringify({ SplashscreenEnabled: true }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }) :
        new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:public') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
    page.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));
    await import('./autoBackdrops');

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        '/Branding/Configuration', '/Branding/Splashscreen'
    ]);
});
