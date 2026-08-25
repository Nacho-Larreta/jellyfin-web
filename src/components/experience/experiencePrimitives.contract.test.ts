import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { findTokenBoundaryViolations } from 'themes/semantic/tokenGuard';
import { WEB_EXPERIENCE_COMPONENT_MANIFEST } from './componentManifest';

const readWorkspacePath = (filePath: string) => fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8');

describe('experience primitives contract guard', () => {
    const stylesheet = readWorkspacePath('src/components/experience/experiencePrimitives.scss');

    it('uses semantic roles for design values and permits only named component aliases', () => {
        const rawViolations = findTokenBoundaryViolations(
            stylesheet,
            'src/components/experience/experiencePrimitives.scss'
        ).filter(violation => violation.kind === 'raw-value');
        const forbiddenRawValues = rawViolations.filter(({ value }) => (
            value.startsWith('#')
            || [ 'rgb(', 'rgba(', 'hsl(', 'hsla(', 'oklch(' ].some(prefix => value.startsWith(prefix))
            || [ 'px', 'rem', 'ms' ].some(unit => value.endsWith(unit))
        ));
        expect(forbiddenRawValues).toEqual([]);

        const declaredTokens = stylesheet
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('--') && line.includes(':'))
            .map(line => line.slice(0, line.indexOf(':')));
        expect(declaredTokens.length).toBeGreaterThan(0);
        expect(declaredTokens.every(token => token.startsWith('--jf-component-'))).toBe(true);

        const componentRootStart = stylesheet.indexOf(':root {');
        const componentRootEnd = stylesheet.indexOf('}', componentRootStart);
        const componentDeclarations = stylesheet.slice(componentRootStart + ':root {'.length, componentRootEnd);
        const declarationValues = componentDeclarations
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.slice(line.indexOf(':') + 1));
        expect(declarationValues.length).toBeGreaterThan(0);
        expect(declarationValues.every(value => value.includes('var(--jf-semantic-'))).toBe(true);
    });

    it('defines focus, hover, pressed, selected, disabled and restriction channels independently', () => {
        expect(stylesheet).toContain(':hover::after');
        expect(stylesheet).toContain(':focus-visible');
        expect(stylesheet).toContain(':active::after');
        expect(stylesheet).toContain("[aria-pressed='true']");
        expect(stylesheet).toContain(':disabled');
        expect(stylesheet).toContain("[data-availability='restricted']");
        expect(stylesheet).toContain("[data-availability='locked']");
    });

    it('owns a reduced-motion and logical reflow path for the browser fixture', () => {
        expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
        expect(stylesheet).toContain('animation: none');
        expect(stylesheet).toContain('overflow-wrap: anywhere');
        expect(stylesheet).toContain('flex-wrap: wrap');
        expect(stylesheet).toContain('grid-template-columns: repeat(auto-fit');
        expect(stylesheet).not.toContain('overflow-x: hidden');
    });

    it('keeps every manifest source and fixture path present', () => {
        for (const manifestPath of [
            ...WEB_EXPERIENCE_COMPONENT_MANIFEST.canonicalPaths,
            WEB_EXPERIENCE_COMPONENT_MANIFEST.fixturePath
        ]) {
            expect(fs.existsSync(path.resolve(process.cwd(), manifestPath)), manifestPath).toBe(true);
        }
    });
});
