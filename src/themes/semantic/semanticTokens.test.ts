import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getContrastRatio } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';

import appTheme, { COLOR_SCHEMES } from '..';
import { createContrastReceipts } from './contrastReceipts';
import { WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST } from './mappingManifest';
import type { SemanticPalette } from './semanticTokens';
import { SEMANTIC_SYSTEM_TOKENS } from './systemTokens';
import {
    findMissingSemanticPairs,
    findMissingSystemTokenRoles,
    findTokenBoundaryViolations
} from './tokenGuard';

const readWorkspacePath = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const semanticAdapterSource = readWorkspacePath('src/themes/_base/_semantic.scss');

type ColorScheme = (typeof COLOR_SCHEMES)[keyof typeof COLOR_SCHEMES];

const getSemanticPalette = (scheme: ColorScheme): SemanticPalette => {
    const semantic = scheme.palette?.semantic;
    if (!semantic) throw new Error('Theme is missing its semantic palette');
    return semantic;
};

const toKebabCase = (value: string) => value.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);

const collectExpectedAliasPairs = (value: unknown, path: string[] = []): Array<[ string, string ]> => {
    if (typeof value === 'string') {
        const start = value.indexOf('var(');
        const end = value.indexOf(',', start);
        return start >= 0 && end > start ? [[
            `--jf-semantic-${path.map(toKebabCase).join('-')}`,
            value.slice(start + 4, end)
        ]] : [];
    }
    if (!value || typeof value !== 'object') return [];

    return Object.entries(value).flatMap(([ key, child ]) => collectExpectedAliasPairs(child, [ ...path, key ]));
};

const SCSS_NON_CODE_PATTERN = new RegExp([
    String.raw`/\*[\s\S]*?\*/`,
    String.raw`//[^\n]*`,
    String.raw`"(?:\\.|[^"\\])*"`,
    String.raw`'(?:\\.|[^'\\])*'`
].join('|'), 'g');

const maskScssCommentsAndStrings = (source: string) => source.replace(
    SCSS_NON_CODE_PATTERN,
    match => match.replace(/[^\n]/g, ' ')
);

const findRootBodyRanges = (maskedSource: string): Array<[ number, number ]> => {
    const ranges: Array<[ number, number ]> = [];
    const rootPattern = /:root\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = rootPattern.exec(maskedSource))) {
        const bodyStart = match.index + match[0].length;
        let depth = 1;
        let cursor = bodyStart;
        while (cursor < maskedSource.length && depth > 0) {
            if (maskedSource[cursor] === '{') depth++;
            if (maskedSource[cursor] === '}') depth--;
            cursor++;
        }
        ranges.push([ bodyStart, depth === 0 ? cursor - 1 : maskedSource.length ]);
        rootPattern.lastIndex = cursor;
    }

    return ranges;
};

const findPublishedAliasPairs = (source: string): Array<[ string, string ]> => {
    const maskedSource = maskScssCommentsAndStrings(source);

    return findRootBodyRanges(maskedSource).flatMap(([ bodyStart, bodyEnd ]) => {
        const body = maskedSource.slice(bodyStart, bodyEnd);
        const aliasPattern = /--jf-semantic-[A-Za-z0-9_-]*/g;
        const occurrences = [ ...body.matchAll(aliasPattern) ];

        return occurrences.map((occurrence, index): [ string, string ] => {
            const alias = occurrence[0];
            const start = bodyStart + (occurrence.index ?? 0);
            const afterAlias = start + alias.length;
            const nextStart = index + 1 < occurrences.length ?
                bodyStart + (occurrences[index + 1].index ?? body.length) :
                bodyEnd;
            const colon = maskedSource.indexOf(':', afterAlias);
            const semicolon = maskedSource.indexOf(';', afterAlias);
            const beforeColon = colon >= 0 ? maskedSource.slice(afterAlias, colon) : '';

            if (
                alias === '--jf-semantic-'
                || colon < 0
                || colon >= nextStart
                || (semicolon >= 0 && semicolon < colon)
            ) {
                return [ alias, 'INVALID:missing-colon' ];
            }
            if (!/^\s*$/.test(beforeColon)) return [ alias, 'INVALID:junk-before-colon' ];
            if (semicolon < 0 || semicolon >= nextStart) {
                return [ alias, 'INVALID:missing-semicolon' ];
            }

            const value = source.slice(colon + 1, semicolon).trim();
            const target = /^var\(\s*(--jf-palette-[A-Za-z0-9_-]+)\s*\)$/.exec(value)?.[1];
            return [ alias, target ?? `INVALID:${value}` ];
        });
    });
};

describe('web semantic token mapping', () => {
    it('maps every exact semantic alias LHS to its generated MUI RHS without extras', () => {
        const generatedStyles = JSON.stringify(appTheme.generateStyleSheets());
        const expectedAliases = collectExpectedAliasPairs(appTheme.vars.palette.semantic)
            .sort(([ left ], [ right ]) => left.localeCompare(right));
        const publishedAliases = findPublishedAliasPairs(semanticAdapterSource)
            .sort(([ left ], [ right ]) => left.localeCompare(right));

        expect(publishedAliases).toEqual(expectedAliases);
        expect(appTheme.vars.semantic.space[4]).toContain('var(--jf-semantic-space-4,');
        expect(appTheme.vars.semantic.typography.numeric.timeline.medium).toContain(
            'var(--jf-semantic-typography-numeric-timeline-medium,'
        );
        expect(appTheme.vars.semantic.motion.reduced.decorativeDuration).toContain(
            'var(--jf-semantic-motion-reduced-decorativeDuration,'
        );
        expect(generatedStyles).toContain('--jf-palette-semantic-accent-informative-container');
        expect(generatedStyles).toContain('--jf-semantic-space-4');
    });

    it('enumerates same-line, multiline and malformed semantic alias declarations', () => {
        const source = [
            ':root {',
            '  --jf-semantic-first: var(--jf-palette-first); --jf-semantic-second: var(--jf-palette-second);',
            '  --jf-semantic-multiline:',
            '    inherit;',
            '  --jf-semantic-missing-colon var(--jf-palette-missing);',
            '  --jf-semantic-junk garbage: var(--jf-palette-junk);',
            '  --jf-semantic-attached.evil: var(--jf-palette-attached);',
            '  /* --jf-semantic-commented: var(--jf-palette-commented); */',
            '  content: "--jf-semantic-string: var(--jf-palette-string);";',
            '  --jf-semantic-missing-semicolon: var(--jf-palette-missing)',
            '}'
        ].join('\n');

        expect(findPublishedAliasPairs(source)).toEqual([
            [ '--jf-semantic-first', '--jf-palette-first' ],
            [ '--jf-semantic-second', '--jf-palette-second' ],
            [ '--jf-semantic-multiline', 'INVALID:inherit' ],
            [ '--jf-semantic-missing-colon', 'INVALID:missing-colon' ],
            [ '--jf-semantic-junk', 'INVALID:junk-before-colon' ],
            [ '--jf-semantic-attached', 'INVALID:junk-before-colon' ],
            [ '--jf-semantic-missing-semicolon', 'INVALID:missing-semicolon' ]
        ]);
    });

    it('publishes a versioned manifest for every supported color scheme', () => {
        expect(WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST).toMatchObject({
            contractVersion: '2.0.0',
            mappingVersion: '1.2.0',
            platform: 'web',
            theme: 'all-supported'
        });
        expect(WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST.colorSchemes).toEqual(Object.keys(COLOR_SCHEMES));
        expect(WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST.implementedComponentIds).toEqual([]);
    });

    it.each(Object.entries(COLOR_SCHEMES))('%s provides every required non-empty fill and ink pair', (_theme, scheme) => {
        expect(findMissingSemanticPairs(getSemanticPalette(scheme))).toEqual([]);
    });

    it.each(Object.entries(COLOR_SCHEMES))('%s derives informative roles from its final primary family', (_theme, scheme) => {
        const semantic = getSemanticPalette(scheme);
        const primary = scheme.palette?.primary;
        const primaryMain = primary && 'main' in primary && typeof primary.main === 'string' ? primary.main : undefined;
        const surfaces = [ scheme.palette?.background?.default, scheme.palette?.background?.paper ];
        if (!primaryMain || surfaces.some(surface => !surface)) throw new Error('Scheme is not fully resolved');

        const resolvedSurfaces = surfaces as string[];
        const primaryAlreadyPasses = resolvedSurfaces.every(surface => getContrastRatio(primaryMain, surface) >= 4.6);

        expect(semantic.accent.informative.container).toBe(primaryMain);
        expect(semantic.accent.informative.foreground === primaryMain).toBe(primaryAlreadyPasses);
    });

    it('provides every named shape, space, type, motion and elevation role', () => {
        expect(findMissingSystemTokenRoles(SEMANTIC_SYSTEM_TOKENS)).toEqual([]);
    });

    it('records the complete allowed surface/role contrast matrix', () => {
        const receipts = Object.entries(COLOR_SCHEMES).flatMap(([ theme, scheme ]) => (
            createContrastReceipts(theme, getSemanticPalette(scheme))
        ));

        expect(receipts).toHaveLength(270);
        expect(receipts.filter(receipt => receipt.ratio < receipt.threshold)).toEqual([]);
        expect(receipts).toMatchSnapshot();
    });

    it('keeps raw values out of every guarded production mapping path', () => {
        const violations = WEB_SEMANTIC_TOKEN_MAPPING_MANIFEST.guardedProductionPaths.flatMap(path => (
            findTokenBoundaryViolations(readWorkspacePath(path), path)
        ));

        expect(violations).toEqual([]);
    });

    it('recognizes all-axis raw literals, modern/named colors and page-local tokens', () => {
        const mutation = [
            '.mutation {',
            '  --page-token: 3px;',
            '  color: rebeccapurple;',
            '  background: oklch(50% 0.2 20);',
            '  border-radius: 0.75rem;',
            '  font-family: Papyrus;',
            '  font-size: clamp(1rem, 2vw, 3rem);',
            '  transition-duration: 123ms;',
            '  box-shadow: 0 2px 4px black;',
            '}'
        ].join('\n');
        const violations = findTokenBoundaryViolations(mutation, 'mutation.scss');
        const systemViolations = findTokenBoundaryViolations(
            "export const mutation = { fontFamily: 'Papyrus', fontWeight: 500 };",
            'src/themes/semantic/systemTokens.ts'
        );

        expect(violations).toEqual(expect.arrayContaining([
            { kind: 'raw-value', value: 'rebeccapurple' },
            { kind: 'raw-value', value: 'oklch(50% 0.2 20)' },
            { kind: 'raw-value', value: '3px' },
            { kind: 'raw-value', value: '123ms' },
            { kind: 'raw-value', value: 'black' },
            { kind: 'raw-value', value: 'Papyrus' },
            { kind: 'local-token', value: '--page-token' }
        ]));
        expect(systemViolations).toEqual(expect.arrayContaining([
            { kind: 'raw-value', value: 'Papyrus' },
            { kind: 'raw-value', value: '500' }
        ]));
    });

    it('rejects empty fill/ink and non-color system roles', () => {
        const semanticMutation = JSON.parse(JSON.stringify(
            getSemanticPalette(COLOR_SCHEMES.dark)
        )) as SemanticPalette;
        semanticMutation.accent.informative.onInformative = '   ';
        semanticMutation.action.primary.container = '';
        const systemMutation = JSON.parse(JSON.stringify(SEMANTIC_SYSTEM_TOKENS)) as typeof SEMANTIC_SYSTEM_TOKENS;
        systemMutation.motion.duration.fast = '';
        systemMutation.typography.numeric.timeline.small = '   ';

        expect(findMissingSemanticPairs(semanticMutation)).toEqual([
            'accent.informative',
            'action.primary'
        ]);
        expect(findMissingSystemTokenRoles(systemMutation)).toEqual([
            'motion.duration.fast',
            'typography.numeric.timeline.small'
        ]);
    });
});
