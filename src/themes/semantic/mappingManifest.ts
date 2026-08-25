import { COLOR_SCHEME_NAMES } from '..';

export const WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST = {
    canonicalMappingPaths: [
        'src/themes/semantic/referenceTokens.ts',
        'src/themes/semantic/semanticTokens.ts',
        'src/themes/semantic/systemTokens.ts',
        'src/themes/semantic/mappingManifest.ts',
        'src/themes/_base/_semantic.scss'
    ],
    colorSchemes: COLOR_SCHEME_NAMES,
    contractVersion: '2.0.0',
    contrastMatrix: {
        filledPairs: 'all filled accent/action/state pairs x surface.canvas/raised/overlay',
        foregrounds: 'accent.informative/content.primary/content.secondary x surface.canvas/raised/overlay',
        threshold: 4.5
    },
    evidenceRoot: 'specs/003-cross-platform-experience-hardening-and-tv-release/web-semantic-token-evidence.md',
    guardedProductionPaths: [
        'src/themes/semantic/semanticTokens.ts',
        'src/themes/semantic/systemTokens.ts',
        'src/themes/styles.d.ts',
        'src/themes/utils.ts',
        'src/themes/_base/_semantic.scss'
    ],
    implementedComponentIds: [
        'atom.action',
        'atom.avatar',
        'atom.chip',
        'atom.focus-indicator',
        'atom.progress',
        'atom.protection-scrim',
        'molecule.media-card',
        'molecule.modal-layer'
    ],
    mappingVersion: '1.2.0',
    mutationCommand: 'npm run test:semantic-tokens:mutations',
    platform: 'web',
    roleSources: {
        accent: {
            informative: 'foreground accessibly tone-adjusted from final palette.primary.main; container uses final main + common.black'
        },
        action: {
            destructive: 'palette.error.main/contrastText',
            primary: 'palette.common white/black selected by palette.mode',
            secondary: 'palette.background.paper + palette.text.primary',
            tertiary: 'transparent + palette.text.primary'
        },
        border: {
            strong: 'palette.text.secondary',
            subtle: 'palette.divider'
        },
        brand: {
            accent: 'reference.brandAccent'
        },
        content: 'palette.text',
        elevation: 'MUI shadows 0/1/8/24 mapped to semantic elevation 0/1/2/3',
        focus: 'palette.common white/black selected by palette.mode',
        interaction: 'palette.action hover/focus/selected',
        motion: 'reference motion duration/easing/reduced-motion policy',
        overlay: {
            protection: 'reference.protection',
            scrim: 'reference.overlayScrim'
        },
        progress: 'palette.action.disabledBackground + palette.text.disabled + reference.brandAccent',
        state: {
            active: 'palette.primary.main + palette.common.black, receipt-corrected',
            error: 'palette.error.main/contrastText',
            locked: 'palette.background.paper + palette.text.primary',
            restricted: 'palette.error.main/contrastText',
            selected: 'palette.primary.main + palette.common.black, receipt-corrected',
            success: 'palette.success.main/contrastText',
            warning: 'palette.warning.main + palette.common.black, receipt-corrected'
        },
        shape: 'MUI shape.borderRadius first; missing named roles from measured reference radii',
        space: 'measured reference 4-unit scale normalized to rem',
        surface: 'palette.background',
        typography: 'MUI font shorthand variables mapped to large/medium/small for display/title/body/label/metadata/numeric.timeline'
    },
    theme: 'all-supported'
} as const;
