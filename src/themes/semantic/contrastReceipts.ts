import type { SemanticPalette } from './semanticTokens';

interface Color {
    alpha: number;
    blue: number;
    green: number;
    red: number;
}

type SurfaceRole = keyof SemanticPalette['surface'];

export interface ContrastReceipt {
    backgroundRole: string;
    composedBackground: string;
    composedForeground: string;
    foregroundRole: string;
    kind: 'fill-ink' | 'foreground-surface';
    ratio: number;
    surface: SurfaceRole;
    theme: string;
    threshold: 4.5;
}

interface FilledPairDefinition {
    container: string;
    ink: string;
    role: string;
}

interface ForegroundDefinition {
    color: string;
    role: string;
}

const CONTRAST_THRESHOLD = 4.5 as const;

const parseHex = (value: string): Color | undefined => {
    const match = /^#([\da-f]{3,8})$/i.exec(value);
    if (!match) return undefined;

    const shorthand = match[1].length === 3 || match[1].length === 4;
    const channels = shorthand ?
        match[1].split('').map(channel => channel + channel) :
        match[1].match(/.{2}/g);

    if (!channels || (channels.length !== 3 && channels.length !== 4)) return undefined;

    return {
        alpha: channels[3] ? Number.parseInt(channels[3], 16) / 255 : 1,
        blue: Number.parseInt(channels[2], 16),
        green: Number.parseInt(channels[1], 16),
        red: Number.parseInt(channels[0], 16)
    };
};

const parseRgb = (value: string): Color | undefined => {
    const normalized = value.trim().toLowerCase();
    const isRgb = normalized.startsWith('rgb(');
    const isRgba = normalized.startsWith('rgba(');
    if ((!isRgb && !isRgba) || !normalized.endsWith(')')) return undefined;

    const channels = normalized
        .slice(normalized.indexOf('(') + 1, -1)
        .split(',')
        .map(channel => Number(channel.trim()));
    if ((channels.length !== 3 && channels.length !== 4) || channels.some(Number.isNaN)) return undefined;

    return {
        alpha: channels[3] ?? 1,
        blue: channels[2],
        green: channels[1],
        red: channels[0]
    };
};

const parseColor = (value: string): Color => {
    if (value === 'transparent') {
        return { alpha: 0, blue: 0, green: 0, red: 0 };
    }

    const color = parseHex(value) ?? parseRgb(value);
    if (!color) throw new Error(`Unsupported contrast color: ${value}`);

    return color;
};

const compose = (foreground: Color, background: Color): Color => {
    const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
    const channel = (foregroundChannel: number, backgroundChannel: number) => (
        foregroundChannel * foreground.alpha
        + backgroundChannel * background.alpha * (1 - foreground.alpha)
    ) / alpha;

    return {
        alpha,
        blue: channel(foreground.blue, background.blue),
        green: channel(foreground.green, background.green),
        red: channel(foreground.red, background.red)
    };
};

const relativeLuminance = (color: Color) => {
    const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ?
            normalized / 12.92 :
            ((normalized + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * channel(color.red)
        + 0.7152 * channel(color.green)
        + 0.0722 * channel(color.blue);
};

const contrastRatio = (foreground: Color, background: Color) => {
    const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
    const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
    return (lighter + 0.05) / (darker + 0.05);
};

const toHex = (color: Color) => {
    const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0');
    return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
};

const getFilledPairDefinitions = (semantic: SemanticPalette): FilledPairDefinition[] => [
    {
        role: 'accent.informative',
        container: semantic.accent.informative.container,
        ink: semantic.accent.informative.onInformative
    },
    { role: 'action.primary', container: semantic.action.primary.container, ink: semantic.action.primary.onPrimary },
    { role: 'action.secondary', container: semantic.action.secondary.container, ink: semantic.action.secondary.onSecondary },
    { role: 'action.tertiary', container: semantic.action.tertiary.container, ink: semantic.action.tertiary.onTertiary },
    { role: 'action.destructive', container: semantic.action.destructive.container, ink: semantic.action.destructive.onDestructive },
    { role: 'state.selected', container: semantic.state.selected.container, ink: semantic.state.selected.onSelected },
    { role: 'state.active', container: semantic.state.active.container, ink: semantic.state.active.onActive },
    { role: 'state.locked', container: semantic.state.locked.container, ink: semantic.state.locked.onLocked },
    { role: 'state.restricted', container: semantic.state.restricted.container, ink: semantic.state.restricted.onRestricted },
    { role: 'state.success', container: semantic.state.success.container, ink: semantic.state.success.onSuccess },
    { role: 'state.warning', container: semantic.state.warning.container, ink: semantic.state.warning.onWarning },
    { role: 'state.error', container: semantic.state.error.container, ink: semantic.state.error.onError }
];

const getForegroundDefinitions = (semantic: SemanticPalette): ForegroundDefinition[] => [
    { role: 'accent.informative.foreground', color: semantic.accent.informative.foreground },
    { role: 'content.primary', color: semantic.content.primary },
    { role: 'content.secondary', color: semantic.content.secondary }
];

const getSurfaces = (semantic: SemanticPalette): Array<[ SurfaceRole, string ]> => [
    [ 'canvas', semantic.surface.canvas ],
    [ 'raised', semantic.surface.raised ],
    [ 'overlay', semantic.surface.overlay ]
];

const createFilledPairReceipt = (
    theme: string,
    surface: SurfaceRole,
    underlayValue: string,
    pair: FilledPairDefinition
): ContrastReceipt => {
    const underlay = parseColor(underlayValue);
    const composedBackground = compose(parseColor(pair.container), underlay);
    const composedForeground = compose(parseColor(pair.ink), composedBackground);

    return {
        backgroundRole: `${pair.role}.container`,
        composedBackground: toHex(composedBackground),
        composedForeground: toHex(composedForeground),
        foregroundRole: `${pair.role}.ink`,
        kind: 'fill-ink',
        ratio: Number(contrastRatio(composedForeground, composedBackground).toFixed(2)),
        surface,
        theme,
        threshold: CONTRAST_THRESHOLD
    };
};

const createForegroundReceipt = (
    theme: string,
    surface: SurfaceRole,
    surfaceValue: string,
    foreground: ForegroundDefinition
): ContrastReceipt => {
    const composedBackground = parseColor(surfaceValue);
    const composedForeground = compose(parseColor(foreground.color), composedBackground);

    return {
        backgroundRole: `surface.${surface}`,
        composedBackground: toHex(composedBackground),
        composedForeground: toHex(composedForeground),
        foregroundRole: foreground.role,
        kind: 'foreground-surface',
        ratio: Number(contrastRatio(composedForeground, composedBackground).toFixed(2)),
        surface,
        theme,
        threshold: CONTRAST_THRESHOLD
    };
};

export const createContrastReceipts = (
    theme: string,
    semantic: SemanticPalette
): ContrastReceipt[] => getSurfaces(semantic).flatMap(([ surface, surfaceValue ]) => [
    ...getFilledPairDefinitions(semantic).map(pair => (
        createFilledPairReceipt(theme, surface, surfaceValue, pair)
    )),
    ...getForegroundDefinitions(semantic).map(foreground => (
        createForegroundReceipt(theme, surface, surfaceValue, foreground)
    ))
]);
