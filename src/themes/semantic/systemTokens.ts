import { SEMANTIC_REFERENCE_TOKENS } from './referenceTokens';

export interface SemanticSystemTokens {
    elevation: {
        0: string;
        1: string;
        2: string;
        3: string;
    };
    motion: {
        duration: {
            base: string;
            fast: string;
            hero: string;
            slow: string;
        };
        easing: {
            enter: string;
            standard: string;
        };
        reduced: {
            decorativeDuration: string;
            transform: string;
        };
    };
    shape: {
        extraLarge: string;
        extraSmall: string;
        full: string;
        large: string;
        medium: string;
        none: string;
        small: string;
    };
    space: {
        0: string;
        1: string;
        2: string;
        3: string;
        4: string;
        5: string;
        6: string;
        7: string;
        8: string;
        9: string;
    };
    typography: {
        body: {
            large: string;
            medium: string;
            small: string;
        };
        display: {
            large: string;
            medium: string;
            small: string;
        };
        label: {
            large: string;
            medium: string;
            small: string;
        };
        metadata: {
            large: string;
            medium: string;
            small: string;
        };
        numeric: {
            timeline: {
                large: string;
                medium: string;
                small: string;
            };
        };
        title: {
            large: string;
            medium: string;
            small: string;
        };
    };
}

export const SEMANTIC_SYSTEM_TOKENS: SemanticSystemTokens = {
    elevation: {
        0: 'var(--jf-shadows-0)',
        1: 'var(--jf-shadows-1)',
        2: 'var(--jf-shadows-8)',
        3: 'var(--jf-shadows-24)'
    },
    motion: {
        duration: SEMANTIC_REFERENCE_TOKENS.motion.duration,
        easing: SEMANTIC_REFERENCE_TOKENS.motion.easing,
        reduced: SEMANTIC_REFERENCE_TOKENS.motion.reduced
    },
    shape: {
        extraLarge: SEMANTIC_REFERENCE_TOKENS.shape.extraLarge,
        extraSmall: SEMANTIC_REFERENCE_TOKENS.shape.extraSmall,
        full: SEMANTIC_REFERENCE_TOKENS.shape.full,
        large: SEMANTIC_REFERENCE_TOKENS.shape.large,
        medium: SEMANTIC_REFERENCE_TOKENS.shape.medium,
        none: SEMANTIC_REFERENCE_TOKENS.shape.none,
        small: 'var(--jf-shape-borderRadius)'
    },
    space: SEMANTIC_REFERENCE_TOKENS.space,
    typography: {
        body: {
            large: 'var(--jf-font-subtitle1)',
            medium: 'var(--jf-font-body1)',
            small: 'var(--jf-font-body2)'
        },
        display: {
            large: 'var(--jf-font-h1)',
            medium: 'var(--jf-font-h2)',
            small: 'var(--jf-font-h3)'
        },
        label: {
            large: 'var(--jf-font-button)',
            medium: 'var(--jf-font-subtitle2)',
            small: 'var(--jf-font-overline)'
        },
        metadata: {
            large: 'var(--jf-font-body2)',
            medium: 'var(--jf-font-caption)',
            small: 'var(--jf-font-overline)'
        },
        numeric: {
            timeline: {
                large: 'var(--jf-font-subtitle1)',
                medium: 'var(--jf-font-body2)',
                small: 'var(--jf-font-caption)'
            }
        },
        title: {
            large: 'var(--jf-font-h1)',
            medium: 'var(--jf-font-h2)',
            small: 'var(--jf-font-h3)'
        }
    }
};
