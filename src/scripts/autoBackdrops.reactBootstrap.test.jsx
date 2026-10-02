import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('scripts/browser', () => ({ default: { slow: false, tv: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlayingLocally: () => false } }));
vi.mock('scripts/settings/userSettings', () => ({ enableBackdrops: () => true }));
vi.mock('scripts/libraryMenu', () => ({ default: { getTopParentId: () => '' } }));
vi.mock('components/viewManager/viewManager', () => ({ default: { currentView: vi.fn(), hideView: vi.fn() } }));
vi.mock('components/autoFocuser', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('utils/dashboard', () => ({
    pageClassOn: (event, className, callback) => document.addEventListener(event, occurrence => {
        if (occurrence.target.classList.contains(className)) callback.call(occurrence.target, occurrence);
    })
}));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: vi.fn(), getApiClient: vi.fn(), subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
} }));

import Page from '../components/Page';
import { clearBackdrop } from '../components/backdrop/backdrop';
import viewManager from '../components/viewManager/viewManager';
import { ServerConnections } from 'lib/jellyfin-apiclient';

afterEach(() => {
    clearBackdrop();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
});

it('starts the already mounted React Page when its show event preceded lazy backdrop registration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>'
        + '<div class="mainAnimatedPages skinBody"></div><div class="skinBody"><div id="reactRoot"></div></div>';
    const hiddenLegacyPage = document.createElement('div');
    hiddenLegacyPage.className = 'page mainAnimatedPage backdropPage hide';
    hiddenLegacyPage.setAttribute('data-backdroptype', 'splashscreen');
    document.querySelector('.mainAnimatedPages').append(hiddenLegacyPage);
    vi.mocked(viewManager.currentView).mockReturnValue(hiddenLegacyPage);
    const client = { serverId: () => 'server-a', serverAddress: () => 'https://server.example' };
    vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client);
    vi.mocked(ServerConnections.getApiClient).mockReturnValue(client);
    const fetcher = vi.fn(async url => String(url).endsWith('/Branding/Configuration') ?
        new Response(JSON.stringify({ SplashscreenEnabled: true }), {
            headers: { 'Content-Type': 'application/json' }
        }) :
        new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:react') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    const root = createRoot(document.getElementById('reactRoot'));
    try {
        await act(async () => {
            root.render(<Page id='reactSplash' className='mainAnimatedPage backdropPage'
                backDropType='splashscreen' />);
        });
        expect(fetcher).not.toHaveBeenCalled();
        await import('./autoBackdrops');
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    } finally {
        await act(async () => root.unmount());
    }
});
