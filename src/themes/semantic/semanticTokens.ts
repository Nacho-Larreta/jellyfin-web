import {
    darken,
    getContrastRatio,
    lighten
} from '@mui/material/styles';

import { SEMANTIC_REFERENCE_TOKENS } from './referenceTokens';

const CONTRACT_CONTRAST_THRESHOLD = 4.5;
const CONTRAST_ROUNDING_MARGIN = 0.1;

type SemanticPair<OnRole extends string> = {
    container: string;
} & Record<OnRole, string>;

export interface SemanticPalette {
    accent: {
        informative: {
            container: string;
            foreground: string;
            onInformative: string;
        };
    };
    action: {
        destructive: SemanticPair<'onDestructive'>;
        primary: SemanticPair<'onPrimary'>;
        secondary: SemanticPair<'onSecondary'>;
        tertiary: SemanticPair<'onTertiary'>;
    };
    border: {
        strong: string;
        subtle: string;
    };
    brand: {
        accent: string;
    };
    content: {
        disabled: string;
        primary: string;
        secondary: string;
    };
    focus: {
        indicator: string;
        separator: string;
    };
    interaction: {
        focusLayer: string;
        hoverLayer: string;
        pressedLayer: string;
    };
    overlay: {
        protectionBottom: string;
        protectionSide: string;
        protectionTop: string;
        scrim: string;
    };
    progress: {
        buffered: string;
        played: string;
        track: string;
    };
    state: {
        active: SemanticPair<'onActive'>;
        error: SemanticPair<'onError'>;
        locked: SemanticPair<'onLocked'>;
        restricted: SemanticPair<'onRestricted'>;
        selected: SemanticPair<'onSelected'>;
        success: SemanticPair<'onSuccess'>;
        warning: SemanticPair<'onWarning'>;
    };
    surface: {
        canvas: string;
        overlay: string;
        raised: string;
    };
}

interface ResolvedSemanticPalette {
    action: {
        disabled: string;
        disabledBackground: string;
        focus: string;
        hover: string;
        selected: string;
    };
    background: {
        default: string;
        paper: string;
    };
    common: {
        black: string;
        white: string;
    };
    divider: string;
    error: ResolvedPaletteColor;
    mode: 'dark' | 'light';
    primary: ResolvedPaletteColor;
    success: ResolvedPaletteColor;
    text: {
        disabled: string;
        primary: string;
        secondary: string;
    };
    warning: ResolvedPaletteColor;
}

interface ResolvedPaletteColor {
    contrastText: string;
    main: string;
}

const pair = <OnRole extends string>(container: string, onRole: OnRole, ink: string): SemanticPair<OnRole> => ({
    container,
    [onRole]: ink
} as SemanticPair<OnRole>);

const resolveInformativeForeground = (palette: ResolvedSemanticPalette): string => {
    const surfaces = [
        palette.background.default,
        palette.background.paper
    ];
    const adjust = palette.mode === 'light' ? darken : lighten;

    for (let step = 0; step <= 100; step++) {
        const candidate = step === 0 ? palette.primary.main : adjust(palette.primary.main, step / 100);
        if (surfaces.every(surface => (
            getContrastRatio(candidate, surface) >= CONTRACT_CONTRAST_THRESHOLD + CONTRAST_ROUNDING_MARGIN
        ))) return candidate;
    }

    throw new Error('Primary color cannot resolve an accessible informative foreground for its scheme surfaces');
};

export const createSemanticPalette = (palette: ResolvedSemanticPalette): SemanticPalette => {
    const isLight = palette.mode === 'light';
    const primaryActionContainer = isLight ? palette.common.black : palette.common.white;
    const primaryActionInk = isLight ? palette.common.white : palette.common.black;
    const focusIndicator = primaryActionContainer;
    const focusSeparator = primaryActionInk;

    return {
        accent: {
            informative: {
                container: palette.primary.main,
                foreground: resolveInformativeForeground(palette),
                onInformative: palette.common.black
            }
        },
        action: {
            destructive: pair(palette.error.main, 'onDestructive', palette.error.contrastText),
            primary: pair(primaryActionContainer, 'onPrimary', primaryActionInk),
            secondary: pair(palette.background.paper, 'onSecondary', palette.text.primary),
            tertiary: pair(SEMANTIC_REFERENCE_TOKENS.transparent, 'onTertiary', palette.text.primary)
        },
        border: {
            strong: palette.text.secondary,
            subtle: palette.divider
        },
        brand: {
            accent: SEMANTIC_REFERENCE_TOKENS.brandAccent
        },
        content: {
            disabled: palette.text.disabled,
            primary: palette.text.primary,
            secondary: palette.text.secondary
        },
        focus: {
            indicator: focusIndicator,
            separator: focusSeparator
        },
        interaction: {
            focusLayer: palette.action.focus,
            hoverLayer: palette.action.hover,
            pressedLayer: palette.action.selected
        },
        overlay: {
            protectionBottom: SEMANTIC_REFERENCE_TOKENS.protection.bottom,
            protectionSide: SEMANTIC_REFERENCE_TOKENS.protection.side,
            protectionTop: SEMANTIC_REFERENCE_TOKENS.protection.top,
            scrim: SEMANTIC_REFERENCE_TOKENS.overlayScrim
        },
        progress: {
            buffered: palette.text.disabled,
            played: SEMANTIC_REFERENCE_TOKENS.brandAccent,
            track: palette.action.disabledBackground
        },
        state: {
            active: pair(palette.primary.main, 'onActive', palette.common.black),
            error: pair(palette.error.main, 'onError', palette.error.contrastText),
            locked: pair(palette.background.paper, 'onLocked', palette.text.primary),
            restricted: pair(palette.error.main, 'onRestricted', palette.error.contrastText),
            selected: pair(palette.primary.main, 'onSelected', palette.common.black),
            success: pair(palette.success.main, 'onSuccess', palette.success.contrastText),
            warning: pair(palette.warning.main, 'onWarning', palette.common.black)
        },
        surface: {
            canvas: palette.background.default,
            overlay: palette.background.paper,
            raised: palette.background.paper
        }
    };
};
