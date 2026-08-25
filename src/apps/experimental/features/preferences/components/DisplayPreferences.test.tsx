import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SCREENSAVER_AGE_CEILINGS } from 'plugins/backdropScreensaver/ScreensaverContentPolicy';
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
});
