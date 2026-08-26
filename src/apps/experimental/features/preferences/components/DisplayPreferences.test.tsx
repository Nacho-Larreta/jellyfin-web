import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import BackdropScreensaver from 'plugins/backdropScreensaver/plugin';
import { SCREENSAVER_AGE_CEILINGS } from 'plugins/backdropScreensaver/ScreensaverContentPolicy';
import { UserSettings } from 'scripts/settings/userSettings';
import type { DisplaySettingsValues } from '../types/displaySettingsValues';

vi.mock('components/apphost', () => ({
    appHost: { supports: () => true }
}));
vi.mock('hooks/useApi', () => ({
    useApi: () => ({ user: { Policy: { IsAdministrator: false } } })
}));
vi.mock('hooks/useThemes', () => ({
    useThemes: () => ({ themes: [] })
}));
vi.mock('../hooks/useScreensavers', () => ({
    useScreensavers: () => ({
        screensavers: [ { id: 'backdropscreensaver', name: 'Backdrop screensaver' } ]
    })
}));
vi.mock('lib/globalize', () => ({
    default: {
        translate: (key: string, value?: number) => value === undefined ? key : `${key}:${value}`
    }
}));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: { currentApiClient: vi.fn() }
}));

import { DisplayPreferences, getScreensaverAgeCeilingLabel } from './DisplayPreferences';

function values(screensaverAgeCeiling: DisplaySettingsValues['screensaverAgeCeiling']): DisplaySettingsValues {
    return {
        customCss: '',
        dashboardTheme: 'dark',
        dateTimeLocale: 'auto',
        disableCustomCss: false,
        displayMissingEpisodes: false,
        enableBlurHash: true,
        enableFasterAnimation: false,
        enableItemDetailsBanner: true,
        enableLibraryBackdrops: true,
        enableLibraryThemeSongs: false,
        enableLibraryThemeVideos: false,
        enableRewatchingInNextUp: true,
        episodeImagesInNextUp: true,
        language: 'auto',
        layout: 'auto',
        libraryPageSize: 100,
        maxDaysForNextUp: 30,
        screensaver: 'backdropscreensaver',
        screensaverAgeCeiling,
        screensaverInterval: 5,
        slideshowInterval: 5,
        theme: 'dark'
    };
}

describe('DisplayPreferences screensaver age ceiling', () => {
    it('keeps the product-defined option order and labels', () => {
        expect(SCREENSAVER_AGE_CEILINGS).toEqual([ 0, 5, 10, 13, 14, 16, 18, 21, -1 ]);
        expect(SCREENSAVER_AGE_CEILINGS.map(getScreensaverAgeCeilingLabel)).toEqual([
            'ScreensaverAgeCeilingGeneralAudiences',
            'ScreensaverAgeCeilingAge:5',
            'ScreensaverAgeCeilingAge:10',
            'ScreensaverAgeCeilingAge:13',
            'ScreensaverAgeCeilingAge:14',
            'ScreensaverAgeCeilingAge:16',
            'ScreensaverAgeCeilingAge:18',
            'ScreensaverAgeCeilingAge:21',
            'ScreensaverAgeCeilingUnlimited'
        ]);
    });

    it('associates the visible label and help text with the named control', () => {
        const html = renderToStaticMarkup(
            <DisplayPreferences onChange={vi.fn()} values={values(0)} />
        );

        expect(html).toContain('id="display-settings-screensaver-age-ceiling-label"');
        expect(html).toContain('aria-labelledby="display-settings-screensaver-age-ceiling-label');
        expect(html).toContain('aria-describedby="display-settings-screensaver-age-ceiling-description"');
        expect(html).toContain('name="screensaverAgeCeiling"');
        expect(html).toContain('ScreensaverAgeCeilingGeneralAudiences');
    });

    it('renders the restored persisted selection', () => {
        const html = renderToStaticMarkup(
            <DisplayPreferences onChange={vi.fn()} values={values(16)} />
        );

        expect(html).toContain('ScreensaverAgeCeilingAge:16');
        expect(html).toContain('value="16"');
    });

    it('persists an explicit selection for a recreated screensaver query', async () => {
        Reflect.set(globalThis, [ 'IS', 'REACT', 'ACT', 'ENVIRONMENT' ].join('_'), true);
        localStorage.removeItem('screensaverAgeCeiling');
        const settings = new UserSettings();
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onAgeCeilingChange = vi.fn();

        try {
            await act(async () => root.render(
                <DisplayPreferences
                    onChange={onAgeCeilingChange}
                    values={values(0)}
                />
            ));

            const ageCeilingSelect = container.querySelector<HTMLElement>(
                '[aria-labelledby^="display-settings-screensaver-age-ceiling-label"]'
            );
            expect(ageCeilingSelect).not.toBeNull();
            if (!ageCeilingSelect) return;

            await act(async () => {
                ageCeilingSelect.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles: true,
                    button: 0
                }));
            });
            const ageSixteenOption = document.body.querySelector<HTMLElement>('[role="option"][data-value="16"]');
            expect(ageSixteenOption).not.toBeNull();
            if (!ageSixteenOption) return;

            await act(async () => {
                ageSixteenOption.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    button: 0
                }));
            });
            expect(onAgeCeilingChange).toHaveBeenCalledOnce();
            const selectedValue = onAgeCeilingChange.mock.calls[0][0].target.value;
            settings.screensaverAgeCeiling(selectedValue);
            expect(localStorage.getItem('screensaverAgeCeiling')).toBe('16');

            const apiClient = {
                getCurrentUserId: vi.fn(() => 'user-1'),
                getItems: vi.fn(async () => ({ Items: [] })),
                getParentalRatings: vi.fn(async () => [])
            };
            const fallback = {
                hide: vi.fn(async () => undefined),
                show: vi.fn()
            };
            const recreatedScreensaver = new BackdropScreensaver({
                createFallback: () => fallback,
                getApiClient: () => apiClient as never,
                loadSlideshow: vi.fn()
            });

            await recreatedScreensaver.show();

            expect(apiClient.getItems).toHaveBeenCalledWith('user-1', {
                ImageTypes: 'Backdrop',
                EnableImageTypes: 'Backdrop',
                IncludeItemTypes: 'Movie,Series',
                SortBy: 'Random',
                Recursive: true,
                Fields: 'Taglines,CustomRating',
                ImageTypeLimit: 10,
                HasParentalRating: true,
                MaxOfficialRating: 16,
                StartIndex: 0,
                Limit: 200
            });
        } finally {
            if (container.isConnected) {
                await act(async () => root.unmount());
            }
            container.remove();
            localStorage.removeItem('screensaverAgeCeiling');
        }
    });
});
