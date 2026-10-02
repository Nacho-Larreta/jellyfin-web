import fs from 'node:fs';
import path from 'node:path';
import postcss, { Rule } from 'postcss';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const fromWorkspace = (file: string) => path.resolve(process.cwd(), file);
const compiledRules = (file: string) => {
    const rules: Rule[] = [];
    postcss.parse(compile(fromWorkspace(file)).css).walkRules(rule => {
        rules.push(rule);
    });
    return rules;
};

describe('Home library chip keyboard focus', () => {
    it('overrides legacy outline suppression only for an enabled focus-visible chip', () => {
        const button = compiledRules('src/elements/emby-button/emby-button.scss')
            .find(rule => rule.selector === '.emby-button');
        const suppressedOutline = button?.nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(suppressedOutline).toMatchObject({ value: 'none', important: true });

        const homeRules = compiledRules('src/components/homesections/homesections.scss');
        const chips = homeRules
            .filter(rule => rule.selector.includes('.tvHomeLibraryChip')
                && rule.nodes.some(node => node.type === 'decl' && node.prop === 'outline'));
        expect(chips).toHaveLength(1);
        expect(chips[0].selector).toBe('.tvHomeDashboard .tvHomeLibraryChip:focus-visible:not([aria-disabled=true]):not(.disabled)');
        const outline = chips[0].nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(outline).toMatchObject({ important: true });
        expect(outline?.toString()).toContain('solid var(--jf-semantic-focus-indicator)');
        expect(chips[0].nodes.some(node => node.type === 'decl' && node.prop === 'outline-offset')).toBe(true);
        expect(chips[0].nodes.some(node => node.type === 'decl' && node.prop === 'box-shadow'
            && node.toString().includes('var(--jf-semantic-focus-separator)'))).toBe(true);

        const rail = homeRules.find(rule => rule.selector === '.tvHomeDashboard__libraryRail');
        expect(rail?.nodes.some(node => node.type === 'decl' && node.prop === 'padding'
            && node.value === 'var(--jf-semantic-space-2)')).toBe(true);
    });

    it('uses focus tokens available to the Home route', () => {
        const markup = fs.readFileSync(fromWorkspace('src/components/homesections/sections/tvHomeDashboard.ts'), 'utf8');
        const semanticAliases = fs.readFileSync(fromWorkspace('src/themes/_base/_semantic.scss'), 'utf8');
        const referenceTokens = fs.readFileSync(fromWorkspace('src/themes/semantic/referenceTokens.ts'), 'utf8');
        expect(markup).toContain('is="emby-linkbutton" class="tvHomeLibraryChip');
        expect(semanticAliases).toContain('--jf-semantic-focus-indicator:');
        expect(semanticAliases).toContain('--jf-semantic-focus-separator:');
        expect(referenceTokens).toContain("1: '0.25rem'");
        expect(referenceTokens).toContain("2: '0.5rem'");
    });
});
