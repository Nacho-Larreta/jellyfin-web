import '@mui/material/styles';

import type { SemanticPalette } from './semantic/semanticTokens';
import type { SemanticSystemTokens } from './semantic/systemTokens';

/** Extend MUI types to include our customizations. */
declare module '@mui/material/styles' {
    interface ColorSchemeOverrides {
        appletv: true;
        blueradiance: true;
        purplehaze: true;
        wmc: true;
    }

    interface Palette {
        semantic: SemanticPalette;
        starIcon: Palette['primary'];
    }

    interface PaletteOptions {
        semantic?: SemanticPalette;
        starIcon?: PaletteOptions['primary'];
    }

    interface Theme {
        semantic: SemanticSystemTokens;
    }

    interface ThemeOptions {
        semantic?: SemanticSystemTokens;
    }

    interface ThemeVars {
        semantic: SemanticSystemTokens;
    }
}
