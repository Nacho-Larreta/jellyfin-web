import { createTheme } from '@mui/material/styles';

import { DEFAULT_THEME_OPTIONS } from './_base/theme';
import appletv from './appletv';
import blueradiance from './blueradiance';
import dark from './dark';
import light from './light';
import purplehaze from './purplehaze';
import wmc from './wmc';

export const COLOR_SCHEMES = {
    appletv,
    blueradiance,
    dark,
    light,
    purplehaze,
    wmc
} as const;

export const COLOR_SCHEME_NAMES = Object.keys(COLOR_SCHEMES) as Array<keyof typeof COLOR_SCHEMES>;

/** The default theme containing all color scheme variants. */
const DEFAULT_THEME = createTheme({
    cssVariables: {
        cssVarPrefix: 'jf',
        colorSchemeSelector: '[data-theme="%s"]',
        disableCssColorScheme: true
    },
    defaultColorScheme: 'dark',
    ...DEFAULT_THEME_OPTIONS,
    colorSchemes: COLOR_SCHEMES
});

export default DEFAULT_THEME;
