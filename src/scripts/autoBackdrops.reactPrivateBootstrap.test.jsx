import axios from 'axios';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('scripts/browser', () => ({ default: { slow: false, tv: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlayingLocally: () => false } }));
vi.mock('scripts/settings/userSettings', () => ({ enableBackdrops: () => true }));
vi.mock('scripts/libraryMenu', () => ({ default: { getTopParentId: () => '' } }));
vi.mock('components/viewManager/viewManager', () => ({ default: { currentView: () => null, hideView: vi.fn() } }));
vi.mock('components/autoFocuser', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('utils/dashboard', () => ({
    pageClassOn: (event, className, callback) => document.addEventListener(event, occurrence => {
        if (occurrence.target.classList.contains(className)) callback.call(occurrence.target, occurrence);
    })
}));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: vi.fn(), getApiClient: vi.fn(), subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
} }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({ getWebSessionSwitchApplication: vi.fn() }));

import Page from '../components/Page';
import { clearBackdrop } from '../components/backdrop/backdrop';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
    clearBackdrop();
    axios.defaults.adapter = originalAdapter;
    vi.unstubAllGlobals();
});

it('starts a bound private Items read for a React Movies page mounted before backdrop registration', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>'
        + '<div class="mainAnimatedPages skinBody"></div><div class="skinBody"><div id="reactRoot"></div></div>';
    const client = {
        serverId: () => 'server-a', serverAddress: () => 'https://server.example',
        getCurrentUserId: () => 'user-a', accessToken: () => 'token-a',
        deviceId: () => 'device-a', appName: () => 'Web', appVersion: () => '1', deviceName: () => 'Browser'
    };
    vi.mocked(ServerConnections.currentApiClient).mockReturnValue(client);
    vi.mocked(ServerConnections.getApiClient).mockReturnValue(client);
    const port = {
        basePath: client.serverAddress(),
        identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1, authorityGeneration: 'one' },
        binding: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1,
            deviceId: 'device-a', credentialRef: { token: 'token-a' } },
        assertCurrent: vi.fn(),
        acquire: () => ({ signal: new window['AbortController']().signal, settle: vi.fn() })
    };
    const capture = vi.fn(() => port);
    vi.mocked(getWebSessionSwitchApplication).mockReturnValue({
        captureBoundSessionRead: capture,
        subscribeSessionAdmission: () => vi.fn()
    });
    const adapter = vi.fn(async config => ({ data: { Items: [] }, status: 200, statusText: 'OK', headers: {}, config }));
    axios.defaults.adapter = adapter;

    const root = createRoot(document.getElementById('reactRoot'));
    try {
        await act(async () => {
            root.render(<Page id='moviesPage' className='mainAnimatedPage backdropPage'
                backDropType='movie' />);
        });
        expect(adapter).not.toHaveBeenCalled();
        await import('./autoBackdrops');
        await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
        expect(new URL(axios.getUri(adapter.mock.calls[0][0])).pathname).toBe('/Items');
        expect(capture).toHaveBeenCalledWith(client);
    } finally {
        await act(async () => root.unmount());
    }
});
