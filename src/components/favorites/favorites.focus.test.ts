import path from 'node:path';
import postcss, { Rule } from 'postcss';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

import { SEMANTIC_REFERENCE_TOKENS } from 'themes/semantic/referenceTokens';

function rules(file: string): Rule[] {
    const result: Rule[] = [];
    postcss.parse(compile(path.resolve(process.cwd(), file)).css).walkRules(rule => {
        result.push(rule);
    });
    return result;
}

describe('Favorites card keyboard focus', () => {
    it('overrides the shared card outline suppression only inside Favorites', () => {
        const shared = rules('src/components/cardbuilder/card.scss')
            .find(rule => rule.selector === '.cardContent');
        expect(shared?.nodes.find(node => node.type === 'decl' && node.prop === 'outline'))
            .toMatchObject({ value: 'none', important: true });

        const scoped = rules('src/components/favorites/favorites.scss')
            .filter(rule => rule.selector.includes('#favoritesTab')
                && rule.nodes.some(node => node.type === 'decl' && node.prop === 'outline'));
        expect(scoped).toHaveLength(1);
        expect(scoped[0].selector).toBe('#favoritesTab .cardImageContainer.cardContent.itemAction:focus-visible');
        const outline = scoped[0].nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(outline).toMatchObject({ important: true });
        expect(outline?.toString()).toContain('solid var(--jf-semantic-focus-indicator)');
        expect(scoped[0].nodes.some(node => node.type === 'decl' && node.prop === 'outline-offset')).toBe(true);
        expect(scoped[0].nodes.some(node => node.type === 'decl' && node.prop === 'box-shadow'
            && node.toString().includes('var(--jf-semantic-focus-separator)'))).toBe(true);
    });

    it('reserves enough start gutter for the outward ring inside paint-contained cards', () => {
        const shared = rules('src/components/cardbuilder/card.scss')
            .find(rule => rule.selector === '.card:not(.show-animation)');
        expect(shared?.nodes.find(node => node.type === 'decl' && node.prop === 'contain'))
            .toMatchObject({ value: 'layout style paint' });

        const scoped = rules('src/components/favorites/favorites.scss')
            .find(rule => rule.selector === '#favoritesTab .itemsContainer > .card > .cardBox');
        const gutter = scoped?.nodes.find(node => node.type === 'decl' && node.prop === 'margin-inline-start');
        expect(gutter).toMatchObject({ value: 'var(--jf-semantic-space-2)' });
        const gutterRem = Number.parseFloat(SEMANTIC_REFERENCE_TOKENS.space[2]);
        const focusShadowReachRem = Number.parseFloat(SEMANTIC_REFERENCE_TOKENS.space[1]) * 1.5;
        expect(gutterRem).toBeGreaterThan(focusShadowReachRem);
        expect(scoped?.nodes.some(node => node.type === 'decl' && node.prop === 'contain')).toBe(false);
    });
});
