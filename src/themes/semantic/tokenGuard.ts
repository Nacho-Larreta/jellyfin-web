import type { SemanticPalette } from './semanticTokens';
import type { SemanticSystemTokens } from './systemTokens';

export interface TokenGuardViolation {
    kind: 'local-token' | 'raw-value';
    value: string;
}

const COLOR_FUNCTION_PREFIXES = [
    'color(',
    'color-mix(',
    'device-cmyk(',
    'hsl(',
    'hsla(',
    'hwb(',
    'lab(',
    'lch(',
    'oklab(',
    'oklch(',
    'rgb(',
    'rgba('
];
const CSS_NAMED_COLORS = new Set((
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown '
    + 'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan '
    + 'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid '
    + 'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet '
    + 'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro '
    + 'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki '
    + 'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow '
    + 'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
    + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine '
    + 'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
    + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab '
    + 'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru '
    + 'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown '
    + 'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan '
    + 'teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen currentcolor'
).split(' '));
const CSS_UNITS = new Set([
    '%', 'cap', 'ch', 'cm', 'deg', 'dpcm', 'dpi', 'dppx', 'dvh', 'dvw', 'em', 'ex', 'fr', 'grad', 'ic', 'in',
    'lh', 'lvh', 'lvw', 'mm', 'ms', 'pc', 'pt', 'px', 'q', 'rad', 'rcap', 'rch', 'rem', 'rex', 'rlh', 's',
    'svh', 'svw', 'turn', 'vb', 'vh', 'vi', 'vmax', 'vmin', 'vw'
]);
const GUARDED_CSS_PROPERTY_PREFIXES = [
    'animation', 'background', 'border', 'box-shadow', 'color', 'column-gap', 'font', 'gap', 'inset',
    'letter-spacing', 'line-height', 'margin', 'outline', 'padding', 'row-gap', 'text-shadow', 'transition'
];
const HEX_DIGITS = new Set('0123456789abcdefABCDEF');
const IDENTIFIER_CHARACTERS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-');
const TOKEN_NAME_CHARACTERS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-');

const distinct = (values: string[]) => Array.from(new Set(values));

const findRawHexValues = (source: string): string[] => {
    const values: string[] = [];

    for (let index = 0; index < source.length; index++) {
        if (source[index] !== '#') continue;

        let end = index + 1;
        while (end < source.length && end - index <= 8 && HEX_DIGITS.has(source[end])) {
            end++;
        }

        const length = end - index - 1;
        if ([ 3, 4, 6, 8 ].includes(length) && !HEX_DIGITS.has(source[end])) {
            values.push(source.slice(index, end));
        }
    }

    return values;
};

const findRawColorFunctions = (source: string): string[] => {
    const normalized = source.toLowerCase();

    return COLOR_FUNCTION_PREFIXES.flatMap(prefix => {
        const values: string[] = [];
        let start = normalized.indexOf(prefix);

        while (start >= 0) {
            const end = normalized.indexOf(')', start + prefix.length);
            if (end < 0 || end - start > 512) break;

            values.push(source.slice(start, end + 1));
            start = normalized.indexOf(prefix, end + 1);
        }

        return values;
    });
};

const findStringLiteralValues = (source: string): string[] => {
    const values: string[] = [];
    let index = 0;

    while (index < source.length) {
        const quote = source[index];
        if (quote !== '\'' && quote !== '"' && quote !== '`') {
            index++;
            continue;
        }

        let end = index + 1;
        while (end < source.length) {
            if (source[end] === '\\') {
                end += 2;
                continue;
            }
            if (source[end] === quote) break;
            end++;
        }

        if (end < source.length) {
            values.push(source.slice(index + 1, end));
        }
        index = end + 1;
    }

    return values;
};

const findCssUnitValues = (source: string): string[] => {
    const values: string[] = [];
    let index = 0;

    while (index < source.length) {
        if (!/[\d.]/.test(source[index]) || (source[index] === '.' && !/\d/.test(source[index + 1]))) {
            index++;
            continue;
        }

        let end = index;
        while (end < source.length && /[\d.]/.test(source[end])) end++;
        const unitStart = end;
        while (end < source.length && /[a-z%]/i.test(source[end])) end++;

        const unit = source.slice(unitStart, end).toLowerCase();
        if (CSS_UNITS.has(unit)) values.push(source.slice(index, end));
        index = Math.max(index + 1, end);
    }

    return values;
};

const findNamedColorValues = (source: string): string[] => {
    const values: string[] = [];
    let index = 0;

    while (index < source.length) {
        if (!IDENTIFIER_CHARACTERS.has(source[index])) {
            index++;
            continue;
        }

        let end = index + 1;
        while (end < source.length && IDENTIFIER_CHARACTERS.has(source[end])) end++;
        const identifier = source.slice(index, end).toLowerCase();
        if (CSS_NAMED_COLORS.has(identifier)) values.push(source.slice(index, end));
        index = end;
    }

    return values;
};

const findTokenDeclarations = (source: string): string[] => {
    const tokens: string[] = [];
    let start = source.indexOf('--');

    while (start >= 0) {
        let end = start + 2;
        while (end < source.length && TOKEN_NAME_CHARACTERS.has(source[end])) end++;

        let separator = end;
        while (separator < source.length && /\s/.test(source[separator])) separator++;
        if (source[separator] === ':') tokens.push(source.slice(start, end));

        start = source.indexOf('--', end);
    }

    return tokens;
};

const findUnreferencedSystemValues = (source: string): string[] => {
    const rawStrings = findStringLiteralValues(source).filter(value => (
        value.trim().length > 0
        && !value.startsWith('./')
        && !value.startsWith('var(--jf-')
    ));
    const rawNumbers: string[] = [];
    let separator = source.indexOf(':');

    while (separator >= 0) {
        let start = separator + 1;
        while (start < source.length && /\s/.test(source[start])) start++;
        if (/\d/.test(source[start])) {
            let end = start + 1;
            while (end < source.length && /[\d.]/.test(source[end])) end++;
            rawNumbers.push(source.slice(start, end));
        }
        separator = source.indexOf(':', separator + 1);
    }

    return [ ...rawStrings, ...rawNumbers ];
};

const findUnreferencedStylesheetValues = (source: string): string[] => source.split('\n').flatMap(line => {
    const separator = line.indexOf(':');
    if (separator < 0) return [];

    const property = line.slice(0, separator).trim().toLowerCase();
    if (property.startsWith('--') || !GUARDED_CSS_PROPERTY_PREFIXES.some(prefix => property.startsWith(prefix))) {
        return [];
    }

    const terminator = line.indexOf(';', separator);
    const value = (terminator < 0 ? line.slice(separator + 1) : line.slice(separator + 1, terminator)).trim();
    return value && !value.includes('var(--jf-semantic-') ? [ value ] : [];
});

const isStylesheet = (path: string) => path.endsWith('.css') || path.endsWith('.scss');

export const findTokenBoundaryViolations = (
    source: string,
    path = 'inline.scss'
): TokenGuardViolation[] => {
    const designValues = isStylesheet(path) ? [ source ] : findStringLiteralValues(source);
    const rawValues = distinct([
        ...designValues.flatMap(value => [
            ...findRawHexValues(value),
            ...findRawColorFunctions(value),
            ...findCssUnitValues(value),
            ...findNamedColorValues(value)
        ]),
        ...(path.endsWith('/systemTokens.ts') ? findUnreferencedSystemValues(source) : []),
        ...(isStylesheet(path) ? findUnreferencedStylesheetValues(source) : [])
    ]);
    const localTokens = findTokenDeclarations(source)
        .filter(token => !token.startsWith('--jf-semantic-'));

    return [
        ...rawValues.map(value => ({ kind: 'raw-value' as const, value })),
        ...distinct(localTokens).map(value => ({ kind: 'local-token' as const, value }))
    ];
};

const PAIR_CONTRACTS = [
    [ 'accent.informative', 'container', 'onInformative' ],
    [ 'action.primary', 'container', 'onPrimary' ],
    [ 'action.secondary', 'container', 'onSecondary' ],
    [ 'action.tertiary', 'container', 'onTertiary' ],
    [ 'action.destructive', 'container', 'onDestructive' ],
    [ 'state.selected', 'container', 'onSelected' ],
    [ 'state.active', 'container', 'onActive' ],
    [ 'state.locked', 'container', 'onLocked' ],
    [ 'state.restricted', 'container', 'onRestricted' ],
    [ 'state.success', 'container', 'onSuccess' ],
    [ 'state.warning', 'container', 'onWarning' ],
    [ 'state.error', 'container', 'onError' ]
] as const;

const TYPOGRAPHY_FAMILIES = [ 'body', 'display', 'label', 'metadata', 'title' ] as const;
const TYPOGRAPHY_SIZES = [ 'large', 'medium', 'small' ] as const;
const SYSTEM_ROLE_PATHS = [
    ...[ 0, 1, 2, 3 ].map(role => `elevation.${role}`),
    ...[ 'base', 'fast', 'hero', 'slow' ].map(role => `motion.duration.${role}`),
    ...[ 'enter', 'standard' ].map(role => `motion.easing.${role}`),
    'motion.reduced.decorativeDuration',
    'motion.reduced.transform',
    ...[ 'none', 'extraSmall', 'small', 'medium', 'large', 'extraLarge', 'full' ].map(role => `shape.${role}`),
    ...Array.from({ length: 10 }, (_, role) => `space.${role}`),
    ...TYPOGRAPHY_FAMILIES.flatMap(family => TYPOGRAPHY_SIZES.map(size => `typography.${family}.${size}`)),
    ...TYPOGRAPHY_SIZES.map(size => `typography.numeric.timeline.${size}`)
];

const resolvePath = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, segment) => (
    value && typeof value === 'object' ?
        (value as Record<string, unknown>)[segment] :
        undefined
), root);

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
);

export const findMissingSemanticPairs = (semantic: SemanticPalette): string[] => PAIR_CONTRACTS.flatMap(([
    path,
    containerRole,
    inkRole
]) => {
    const pair = resolvePath(semantic, path);
    if (!pair || typeof pair !== 'object') return [ path ];

    const roles = pair as Record<string, unknown>;
    return isNonEmptyString(roles[containerRole]) && isNonEmptyString(roles[inkRole]) ? [] : [ path ];
});

export const findMissingSystemTokenRoles = (tokens: SemanticSystemTokens): string[] => (
    SYSTEM_ROLE_PATHS.filter(path => !isNonEmptyString(resolvePath(tokens, path)))
);
