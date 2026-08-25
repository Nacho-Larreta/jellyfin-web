import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    screensaverAgeCeiling: vi.fn(() => 0),
    backdropScreensaverInterval: vi.fn(() => 5)
}));

vi.mock('scripts/settings/userSettings', () => settings);
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: { currentApiClient: vi.fn() }
}));
vi.mock('./NeutralLogoScreensaver', () => ({
    NeutralLogoScreensaver: vi.fn()
}));

import BackdropScreensaver from './plugin';

const catalog = [
    { Name: 'G', RatingScore: { score: 0 } },
    { Name: 'PG-13', RatingScore: { score: 13 } }
];
const safeItem = {
    Id: 'safe',
    Type: 'Movie',
    OfficialRating: 'G',
    BackdropImageTags: [ 'image' ]
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function createHarness(overrides: Record<string, unknown> = {}) {
    const fallback = {
        show: vi.fn(),
        hide: vi.fn(() => Promise.resolve())
    };
    const slideshow = {
        show: vi.fn(),
        hide: vi.fn(() => Promise.resolve())
    };
    const Slideshow = vi.fn(function () {
        return slideshow;
    });
    const apiClient = {
        getCurrentUserId: vi.fn(() => 'user'),
        getParentalRatings: vi.fn(() => Promise.resolve(catalog)),
        getItems: vi.fn(() => Promise.resolve({ Items: [ safeItem ] })),
        ...overrides
    };
    const loadSlideshow = vi.fn(() => Promise.resolve({ default: Slideshow }));
    const screensaver = new BackdropScreensaver({
        getApiClient: () => apiClient as never,
        loadSlideshow,
        createFallback: () => fallback
    });

    return { apiClient, fallback, loadSlideshow, screensaver, slideshow, Slideshow };
}

describe('BackdropScreensaver safe loading boundary', () => {
    beforeEach(() => {
        settings.screensaverAgeCeiling.mockReturnValue(0);
        settings.backdropScreensaverInterval.mockReturnValue(5);
    });

    it('shows the neutral fallback while loading and sends the safe query', async () => {
        const catalogRequest = deferred<typeof catalog>();
        const harness = createHarness({
            getParentalRatings: vi.fn(() => catalogRequest.promise)
        });

        const load = harness.screensaver.show();

        expect(harness.fallback.show).toHaveBeenCalledOnce();
        expect(harness.apiClient.getItems).not.toHaveBeenCalled();

        catalogRequest.resolve(catalog);
        await load;

        expect(harness.apiClient.getItems).toHaveBeenCalledWith('user', {
            ImageTypes: 'Backdrop',
            EnableImageTypes: 'Backdrop',
            IncludeItemTypes: 'Movie,Series',
            SortBy: 'Random',
            Recursive: true,
            Fields: 'Taglines,CustomRating',
            ImageTypeLimit: 10,
            HasParentalRating: true,
            MaxOfficialRating: 0,
            StartIndex: 0,
            Limit: 200
        });
        expect(harness.fallback.hide).toHaveBeenCalledOnce();
        expect(harness.slideshow.show).toHaveBeenCalledOnce();
    });

    it.each([
        {
            name: 'catalog API failure',
            overrides: { getParentalRatings: vi.fn(() => Promise.reject(new Error('catalog'))) }
        },
        {
            name: 'catalog shape failure',
            overrides: { getParentalRatings: vi.fn(() => Promise.resolve({})) }
        },
        {
            name: 'items API failure',
            overrides: { getItems: vi.fn(() => Promise.reject(new Error('items'))) }
        },
        {
            name: 'image-less results',
            overrides: {
                getItems: vi.fn(() => Promise.resolve({
                    Items: [ { ...safeItem, BackdropImageTags: [] } ]
                }))
            }
        },
        {
            name: 'all results rejected',
            overrides: {
                getItems: vi.fn(() => Promise.resolve({
                    Items: [ { ...safeItem, OfficialRating: 'PG-13' } ]
                }))
            }
        }
    ])('retains the neutral fallback on $name', async ({ overrides }) => {
        const harness = createHarness(overrides);

        await harness.screensaver.show();

        expect(harness.fallback.show).toHaveBeenCalledOnce();
        expect(harness.fallback.hide).not.toHaveBeenCalled();
        expect(harness.slideshow.show).not.toHaveBeenCalled();
    });

    it('retains the neutral fallback when the slideshow import fails', async () => {
        const harness = createHarness();
        harness.loadSlideshow.mockRejectedValueOnce(new Error('import'));

        await harness.screensaver.show();

        expect(harness.fallback.show).toHaveBeenCalledOnce();
        expect(harness.fallback.hide).not.toHaveBeenCalled();
        expect(harness.slideshow.show).not.toHaveBeenCalled();
    });

    it('cannot resurrect after hide resolves before the catalog request', async () => {
        const catalogRequest = deferred<typeof catalog>();
        const harness = createHarness({
            getParentalRatings: vi.fn(() => catalogRequest.promise)
        });

        const load = harness.screensaver.show();
        await harness.screensaver.hide();
        catalogRequest.resolve(catalog);
        await load;

        expect(harness.apiClient.getItems).not.toHaveBeenCalled();
        expect(harness.loadSlideshow).not.toHaveBeenCalled();
        expect(harness.slideshow.show).not.toHaveBeenCalled();
        expect(harness.fallback.hide).toHaveBeenCalledOnce();
    });

    it('retries with the same resolved policy even if persisted settings change', async () => {
        const harness = createHarness({
            getItems: vi.fn()
                .mockRejectedValueOnce(new Error('first request'))
                .mockResolvedValueOnce({ Items: [ safeItem ] })
        });

        await harness.screensaver.show();
        settings.screensaverAgeCeiling.mockReturnValue(18);
        await harness.screensaver.retry();

        expect(harness.apiClient.getItems).toHaveBeenCalledTimes(2);
        const queries = (harness.apiClient.getItems.mock.calls as unknown[][])
            .map(call => call[1] as { MaxOfficialRating: number });
        expect(queries[0].MaxOfficialRating).toBe(0);
        expect(queries[1].MaxOfficialRating).toBe(0);
        expect(settings.screensaverAgeCeiling).toHaveBeenCalledOnce();
        expect(harness.slideshow.show).toHaveBeenCalledOnce();
    });
});
