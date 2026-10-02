import { expect, it, vi } from 'vitest';

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
import { ServerConnections } from 'lib/jellyfin-apiclient';

it('fails closed when multiple React route pages are mounted at late registration', async () => {
    document.body.innerHTML = '<div class="backdropContainer"></div><div class="backgroundContainer"></div>'
        + '<div class="mainAnimatedPages skinBody"></div><div class="skinBody"></div>';
    const cachedLegacy = document.createElement('div');
    cachedLegacy.className = 'page mainAnimatedPage backdropPage hide';
    document.querySelector('.mainAnimatedPages').append(cachedLegacy);
    vi.mocked(viewManager.currentView).mockReturnValue(cachedLegacy);
    const reactOutlet = document.querySelector('.skinBody:not(.mainAnimatedPages)');
    for (const id of ['first', 'second']) {
        const page = document.createElement('div');
        page.id = id;
        page.className = 'page mainAnimatedPage backdropPage';
        page.dataset.role = 'page';
        page.dataset.backdroptype = 'splashscreen';
        reactOutlet.append(page);
    }

    await import('./autoBackdrops');

    expect(ServerConnections.currentApiClient).not.toHaveBeenCalled();
    expect(document.querySelector('.backdropContainer').children).toHaveLength(0);
});
