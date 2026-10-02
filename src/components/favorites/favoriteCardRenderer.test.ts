import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: {
    getApiClient: vi.fn(() => {
        throw new Error('Global client recapture');
    })
} }));
vi.mock('utils/jellyfin-apiclient/compat', () => ({ toApi: vi.fn(() => {
    throw new Error('Global SDK recapture');
}) }));
vi.mock('components/cardbuilder/utils/url', () => ({ getCardImageUrl: vi.fn(() => {
    throw new Error('Legacy image URL');
}) }));
vi.mock('components/images/imageLoader', () => ({ default: { getPrimaryImageAspectRatio: () => undefined } }));
vi.mock('components/indicators/indicators', () => ({ default: {
    getProgressBarHtml: () => '', getMissingIndicator: () => '', getSyncIndicator: () => '',
    getTimerIndicator: () => '', getTypeIndicator: () => '', getPlayedIndicatorHtml: () => ''
} }));
vi.mock('components/itemHelper', () => ({ default: { getDisplayName: (item: { Name: string }) => item.Name } }));
vi.mock('elements/emby-button/paper-icon-button-light', () => ({}));
vi.mock('components/layoutManager', () => ({ default: { tv: false, mobile: false, desktop: false } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { canPlay: () => false } }));
vi.mock('components/router/appRouter', () => ({ appRouter: { getRouteUrl: () => '#details' } }));
vi.mock('components/shortcuts', () => ({ default: {
    on: vi.fn(), off: vi.fn(), getShortcutAttributesHtml: () => 'data-id="item"'
} }));
vi.mock('components/focusManager', () => ({ default: { autoFocus: vi.fn() } }));
vi.mock('scripts/browser', () => ({ default: { slow: false, edge: false } }));
vi.mock('scripts/datetime', () => ({ default: {} }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('components/apphost', () => ({ appHost: {
    appName: () => 'test', appVersion: () => '1', deviceId: () => 'device', deviceName: () => 'Browser'
} }));
vi.mock('scripts/settings/appSettings', () => ({ default: { enableAutoLogin: () => true } }));
vi.mock('scripts/settings/userSettings', () => ({ setUserInfo: vi.fn() }));
vi.mock('utils/dashboard', () => ({ default: { capabilities: () => ({}) } }));

import cardBuilder from 'components/cardbuilder/cardBuilder';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { getCardImageUrl } from 'components/cardbuilder/utils/url';

beforeEach(() => vi.clearAllMocks());

describe('Favorites explicit image presentation seam', () => {
    it('renders shared card actions and shape without global client or remote image URL', () => {
        const html = cardBuilder.getCardsHtml({
            items: [{
                Id: '5dae694ba968f2676a64ceb6934f667b', ServerId: 'server-a',
                Type: 'Movie', Name: 'Movie', ImageTags: { Primary: 'tag' }
            }],
            serverId: 'server-a',
            shape: 'overflowPortrait',
            showTitle: true,
            overlayPlayButton: true,
            imagePresentation: () => ({
                descriptor: { itemId: '5dae694ba968f2676a64ceb6934f667b', type: 'Primary', tag: 'tag' },
                coverImage: false, forceName: false
            })
        });

        expect(ServerConnections.getApiClient).not.toHaveBeenCalled();
        expect(toApi).not.toHaveBeenCalled();
        expect(getCardImageUrl).not.toHaveBeenCalled();
        expect(html).toContain('cardPadder-overflowPortrait');
        expect(html).toContain('data-session-image-slot="0"');
        expect(html).toContain('data-action="link"');
        expect(html).toContain('aria-label="Movie"');
        expect(html).not.toContain('role="img"');
        expect(html).not.toContain('data-src=');
        expect(html).not.toContain('ApiKey=');
        expect(html).not.toContain('AccessToken=');
    });

    it('keeps the legacy card URL path for callers without explicit presentation', () => {
        const legacyUrl = 'https://media.example/Items/5dae694ba968f2676a64ceb6934f667b/Images/Primary';
        vi.mocked(ServerConnections.getApiClient).mockReturnValueOnce({} as never);
        vi.mocked(toApi).mockReturnValueOnce({} as never);
        vi.mocked(getCardImageUrl).mockReturnValueOnce({
            imgUrl: legacyUrl, blurhash: undefined, forceName: false, coverImage: false
        });
        const html = cardBuilder.getCardsHtml({
            items: [{
                Id: '5dae694ba968f2676a64ceb6934f667b', ServerId: 'server-a',
                Type: 'Movie', Name: 'Legacy movie', ImageTags: { Primary: 'tag' }
            }],
            serverId: 'server-a', shape: 'overflowPortrait', showTitle: true
        });

        expect(getCardImageUrl).toHaveBeenCalledOnce();
        expect(html).toContain(`data-src="${legacyUrl}"`);
        expect(html).not.toContain('data-session-image-slot');
    });

    it('fails closed when the explicit presentation returns no descriptor', () => {
        const html = cardBuilder.getCardsHtml({
            items: [{
                Id: '5dae694ba968f2676a64ceb6934f667b', ServerId: 'server-a',
                Type: 'Movie', Name: 'No artwork'
            }],
            serverId: 'server-a', shape: 'overflowPortrait', showTitle: true,
            imagePresentation: () => undefined
        });

        expect(ServerConnections.getApiClient).not.toHaveBeenCalled();
        expect(toApi).not.toHaveBeenCalled();
        expect(getCardImageUrl).not.toHaveBeenCalled();
        expect(html).toContain('No artwork');
        expect(html).not.toContain('data-src=');
    });

    it('never accepts a remote URL from an explicit image presentation callback', () => {
        const html = cardBuilder.getCardsHtml({
            items: [{
                Id: '5dae694ba968f2676a64ceb6934f667b', ServerId: 'server-a',
                Type: 'Movie', Name: 'No remote image'
            }],
            serverId: 'server-a', shape: 'overflowPortrait', showTitle: true,
            imagePresentation: () => ({ imgUrl: 'https://untrusted.example/image.png' })
        });

        expect(html).not.toContain('untrusted.example');
        expect(html).not.toContain('data-src=');
        expect(getCardImageUrl).not.toHaveBeenCalled();
    });
});
