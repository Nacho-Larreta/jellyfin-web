import axios from 'axios';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('scripts/browser', () => ({ default: { slow: false, tv: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlayingLocally: () => false } }));
vi.mock('scripts/settings/userSettings', () => ({ enableBackdrops: vi.fn(() => true) }));
vi.mock('scripts/libraryMenu', () => ({ default: { getTopParentId: vi.fn(() => '') } }));
vi.mock('components/viewManager/viewManager', () => ({ default: { currentView: vi.fn(), hideView: vi.fn() } }));
vi.mock('components/autoFocuser', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('utils/dom', () => ({ default: { getScreenWidth: () => 1920 } }));
vi.mock('utils/dashboard', () => ({
    pageClassOn: (event, className, callback) => document.addEventListener(event, function (occurrence) {
        if (occurrence.target.classList.contains(className)) callback.call(occurrence.target, occurrence);
    })
}));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    currentApiClient: vi.fn(), getApiClient: vi.fn(), subscribeSessionSwitchEnvelope: vi.fn(() => vi.fn())
} }));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: vi.fn()
}));

import viewManager from '../components/viewManager/viewManager';
import Page from '../components/Page';
import libraryMenu from './libraryMenu';
import * as userSettings from './settings/userSettings';
import { clearBackdrop, setBackdropImages } from '../components/backdrop/backdrop';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import Events from '../utils/events';
import './autoBackdrops';

const itemA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const itemB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const originalAdapter = axios.defaults.adapter;
let activePage;
let activeClient;
let ports;
let images;
let subscriptions;
let admissionListeners;

class ControlledImage {
    constructor() {
        images.push(this);
    }

    set src(value) {
        this.url = value;
    }

    load() {
        this.onload?.();
    }
}

function client(serverId, userId) {
    return {
        serverId: () => serverId,
        serverAddress: () => `https://${serverId}.example/jellyfin`,
        getCurrentUserId: () => userId,
        accessToken: () => `token-${userId}`,
        deviceId: () => 'device',
        appName: () => 'Web', appVersion: () => '1', deviceName: () => 'Browser'
    };
}

function portFor(apiClient, epoch) {
    let valid = true;
    const controller = new window['AbortController']();
    const serverId = apiClient.serverId();
    const profileUserId = apiClient.getCurrentUserId();
    const port = {
        basePath: apiClient.serverAddress(),
        identity: { serverId, profileUserId, sessionEpoch: epoch, authorityGeneration: `generation-${epoch}` },
        binding: { serverId, profileUserId, sessionEpoch: epoch, deviceId: 'device',
            credentialRef: { token: apiClient.accessToken() } },
        assertCurrent: () => { if (!valid || activeClient !== apiClient) throw new Error('stale'); },
        acquire: () => ({ signal: controller.signal, settle: vi.fn() }),
        revoke: () => {
            valid = false;
            controller.abort();
        }
    };
    ports.set(apiClient, port);
    return port;
}

function page(type) {
    const element = document.createElement('div');
    element.className = 'page backdropPage globalBackdropPage';
    if (type) element.setAttribute('data-backdroptype', type);
    document.body.append(element);
    activePage = element;
    vi.mocked(viewManager.currentView).mockReturnValue(element);
    element.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
    element.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));
    return element;
}

function switchTo(apiClient, epoch) {
    activeClient = apiClient;
    portFor(apiClient, epoch);
    vi.mocked(ServerConnections.currentApiClient).mockImplementation(() => activeClient);
    vi.mocked(ServerConnections.getApiClient).mockImplementation(id => id === activeClient?.serverId() ? activeClient : null);
}

beforeEach(() => {
    activePage?.dispatchEvent(new CustomEvent('viewhide'));
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>';
    clearBackdrop();
    activePage = null;
    activeClient = null;
    ports = new Map();
    images = [];
    subscriptions = new Map();
    admissionListeners = new Map();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Image', ControlledImage);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn()
        .mockReturnValueOnce('blob:A').mockReturnValueOnce('blob:B').mockReturnValue('blob:next') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.mocked(getWebSessionSwitchApplication).mockReturnValue({
        captureBoundSessionRead: apiClient => ports.get(apiClient),
        subscribeSessionAdmission: (serverId, listener) => {
            admissionListeners.set(serverId, listener);
            return () => admissionListeners.delete(serverId);
        }
    });
    vi.mocked(ServerConnections.subscribeSessionSwitchEnvelope).mockImplementation((id, listener) => {
        subscriptions.set(id, listener);
        return () => subscriptions.delete(id);
    });
    vi.mocked(userSettings.enableBackdrops).mockReturnValue(true);
    vi.mocked(libraryMenu.getTopParentId).mockReturnValue('');
});

afterEach(() => {
    activePage?.dispatchEvent(new CustomEvent('viewhide'));
    clearBackdrop();
    axios.defaults.adapter = originalAdapter;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(ServerConnections, '_callbacks');
});

describe('automatic backdrop session and page lifetime', () => {
    it('does not publish A Items after B and sends the captured user/rating query', async () => {
        let finishA;
        const pendingA = new Promise(resolve => {
            finishA = resolve;
        });
        axios.defaults.adapter = vi.fn(config => {
            const user = new URL(axios.getUri(config)).searchParams.get('userId');
            const data = user === 'user-a' ? pendingA : { Items: [{ Id: itemB, ServerId: 'server-b', BackdropImageTags: ['B'] }] };
            return Promise.resolve(data).then(items => ({ data: items, status: 200, statusText: 'OK', headers: {}, config }));
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        const a = client('server-a', 'user-a');
        switchTo(a, 1);
        const aPage = page();
        await vi.waitFor(() => expect(axios.defaults.adapter).toHaveBeenCalledOnce());

        aPage.dispatchEvent(new CustomEvent('viewhide'));
        const b = client('server-b', 'user-b');
        switchTo(b, 2);
        page();
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        finishA({ Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] });
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.backdropImage')?.getAttribute('data-url')).toBe('blob:A');
        expect(fetch).toHaveBeenCalledTimes(1);
        const requests = vi.mocked(axios.defaults.adapter).mock.calls.map(([config]) => new URL(axios.getUri(config)));
        expect(requests.map(url => url.searchParams.get('userId'))).toEqual(['user-a', 'user-b']);
        expect(requests[0].searchParams.get('maxOfficialRating')).toBe('PG-13');
        expect(requests[0].searchParams.get('limit')).toBe('20');
    });

    it('revokes already visible pixels and object URL on logout', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        switchTo(client('server-a', 'user-a'), 1);
        page();
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);
        Events.trigger(ServerConnections, 'localusersignedout');
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:A');
    });

    it('removes visible private pixels immediately when admission closes with no later image or timer callback', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        const active = client('server-a', 'user-a');
        switchTo(active, 1);
        const bound = ports.get(active);
        page();
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);

        bound.revoke();
        admissionListeners.get('server-a')();

        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:A');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('clears a preceding detail background when the new private page has no admissible port', () => {
        vi.stubGlobal('fetch', vi.fn());
        setBackdropImages(['detail-image']);
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);
        const denied = client('server-a', 'user-a');
        switchTo(denied, 1);
        ports.delete(denied);

        page();

        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not let a stale pageshow clear the current view owner', () => {
        vi.stubGlobal('fetch', vi.fn());
        const currentPage = document.createElement('div');
        currentPage.className = 'page';
        const stalePage = document.createElement('div');
        stalePage.className = 'page backdropPage';
        document.body.append(stalePage, currentPage);
        activePage = currentPage;
        vi.mocked(viewManager.currentView).mockReturnValue(currentPage);
        setBackdropImages(['current-image']);
        images[0].load();

        stalePage.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));

        expect(document.querySelector('.backdropImage')?.getAttribute('data-url')).toBe('current-image');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts the React Page viewshow/pageshow sequence when the legacy view manager has no current view', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        switchTo(client('server-a', 'user-a'), 1);
        vi.mocked(viewManager.currentView).mockReturnValue(null);
        const reactPage = document.createElement('div');
        reactPage.className = 'page backdropPage globalBackdropPage';
        document.body.append(reactPage);
        activePage = reactPage;
        reactPage.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        reactPage.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));

        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);
    });

    it('releases a React page background when the page detaches without a legacy hide event', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        switchTo(client('server-a', 'user-a'), 1);
        const reactPage = page();
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);

        reactPage.remove();

        await vi.waitFor(() => expect(document.querySelectorAll('.backdropImage')).toHaveLength(0));
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:A');
    });

    it('renders and releases the actual React Page without relying on legacy viewManager ownership', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        switchTo(client('server-a', 'user-a'), 1);
        vi.mocked(viewManager.currentView).mockReturnValue(null);
        const mount = document.createElement('div');
        document.body.append(mount);
        const root = createRoot(mount);
        await act(async () => {
            root.render(React.createElement(Page, {
                id: 'reactPage', className: 'backdropPage globalBackdropPage', backDropType: 'movie'
            }));
        });
        activePage = mount.querySelector('.page');
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);

        await act(async () => root.unmount());

        await vi.waitFor(() => expect(document.querySelectorAll('.backdropImage')).toHaveLength(0));
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:A');
        activePage = null;
    });

    it('retires same-user old epoch on durable notification and lets a restored page acquire fresh authority', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] },
            status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        const sameClient = client('server-a', 'same-user');
        switchTo(sameClient, 1);
        const oldPort = ports.get(sameClient);
        const oldPage = page();
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);

        oldPort.revoke();
        subscriptions.get('server-a')();
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:A');
        switchTo(sameClient, 2);
        oldPage.dispatchEvent(new CustomEvent('viewhide'));
        page();
        await vi.waitFor(() => expect(images).toHaveLength(2));
        images[1].load();
        expect(document.querySelector('.backdropImage')?.getAttribute('data-url')).toBe('blob:B');
    });

    it('rejects a hidden page completion after the same DOM page is restored', async () => {
        let releaseOld;
        const pendingOld = new Promise(resolve => {
            releaseOld = resolve;
        });
        let call = 0;
        axios.defaults.adapter = vi.fn(config => Promise.resolve(++call === 1 ? pendingOld : {
            Items: [{ Id: itemB, ServerId: 'server-a', BackdropImageTags: ['B'] }]
        }).then(data => ({ data, status: 200, statusText: 'OK', headers: {}, config })));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
            headers: { 'Content-Type': 'image/png' }
        })));
        const sameClient = client('server-a', 'same-user');
        switchTo(sameClient, 1);
        const oldPort = ports.get(sameClient);
        const restoredPage = page();
        await vi.waitFor(() => expect(call).toBe(1));

        restoredPage.dispatchEvent(new CustomEvent('viewhide'));
        oldPort.revoke();
        switchTo(sameClient, 2);
        restoredPage.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();
        releaseOld({ Items: [{ Id: itemA, ServerId: 'server-a', BackdropImageTags: ['A'] }] });
        await Promise.resolve();
        await Promise.resolve();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.backdropImage')?.getAttribute('data-url')).toBe('blob:A');
    });

    it('keeps the parent rating query and clears a valid empty result without image dispatch', async () => {
        axios.defaults.adapter = vi.fn(async config => ({
            data: { Items: [] }, status: 200, statusText: 'OK', headers: {}, config
        }));
        vi.mocked(libraryMenu.getTopParentId).mockReturnValue('parent-a');
        switchTo(client('server-a', 'user-a'), 1);
        const localPage = page();
        localPage.classList.remove('globalBackdropPage');
        localPage.dispatchEvent(new CustomEvent('pageshow', { bubbles: true }));
        await vi.waitFor(() => expect(axios.defaults.adapter).toHaveBeenCalled());
        const config = vi.mocked(axios.defaults.adapter).mock.calls.at(-1)[0];
        const query = new URL(axios.getUri(config)).searchParams;
        expect(query.get('parentId')).toBe('parent-a');
        expect(query.get('maxOfficialRating')).toBe('');
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('shows public pre-login branding without a private port or credentials', async () => {
        const requests = [];
        vi.stubGlobal('fetch', vi.fn(async (url, options) => {
            requests.push({ url: String(url), options });
            if (String(url).endsWith('/Branding/Configuration')) {
                return new Response(JSON.stringify({ SplashscreenEnabled: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
        }));
        const loginServer = client('server-a', null);
        activeClient = loginServer;
        vi.mocked(ServerConnections.currentApiClient).mockReturnValue(loginServer);
        vi.mocked(ServerConnections.getApiClient).mockReturnValue(loginServer);
        page('splashscreen');
        await vi.waitFor(() => expect(images).toHaveLength(1));
        images[0].load();

        expect(document.querySelectorAll('.backdropImage')).toHaveLength(1);
        expect(requests.map(entry => new URL(entry.url).pathname)).toEqual([
            '/jellyfin/Branding/Configuration', '/jellyfin/Branding/Splashscreen'
        ]);
        expect(requests.every(entry => entry.options.credentials === 'omit'
            && entry.options.cache === 'no-store' && entry.options.redirect === 'error')).toBe(true);
        expect(requests.some(entry => /token|device/i.test(entry.url))).toBe(false);
        expect(getWebSessionSwitchApplication).not.toHaveBeenCalled();
    });

    it('does not reuse A branding when a server changes before its response finishes', async () => {
        let finishA;
        const pendingA = new Promise(resolve => {
            finishA = resolve;
        });
        const requests = [];
        vi.stubGlobal('fetch', vi.fn(url => {
            requests.push(String(url));
            if (String(url).startsWith('https://server-a.example')) return pendingA;
            if (String(url).endsWith('/Branding/Configuration')) {
                return Promise.resolve(new Response(JSON.stringify({ SplashscreenEnabled: false }), {
                    headers: { 'Content-Type': 'application/json' }
                }));
            }
            return Promise.reject(new Error('Unexpected image fetch'));
        }));
        const a = client('server-a', null);
        activeClient = a;
        vi.mocked(ServerConnections.currentApiClient).mockImplementation(() => activeClient);
        vi.mocked(ServerConnections.getApiClient).mockImplementation(id => id === activeClient.serverId() ? activeClient : null);
        const oldPage = page('splashscreen');
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        oldPage.dispatchEvent(new CustomEvent('viewhide'));
        activeClient = client('server-b', null);
        page('splashscreen');
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        finishA(new Response(JSON.stringify({ SplashscreenEnabled: true }), {
            headers: { 'Content-Type': 'application/json' }
        }));
        await Promise.resolve();

        expect(requests).toEqual([
            'https://server-a.example/jellyfin/Branding/Configuration',
            'https://server-b.example/jellyfin/Branding/Configuration'
        ]);
        expect(document.querySelectorAll('.backdropImage')).toHaveLength(0);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
});
