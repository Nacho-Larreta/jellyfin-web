import fs from 'node:fs';
import path from 'node:path';
import postcss, { type Rule } from 'postcss';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

import { SEMANTIC_REFERENCE_TOKENS } from 'themes/semantic/referenceTokens';

const fromWorkspace = (file: string) => path.resolve(process.cwd(), file);

const compiledRules = (file: string) => {
    const rules: Rule[] = [];
    postcss.parse(compile(fromWorkspace(file)).css).walkRules(rule => {
        rules.push(rule);
    });
    return rules;
};

describe('React library navigation keyboard focus', () => {
    it('gives enabled keyboard-focused links a scoped non-color outline', () => {
        const rules = compiledRules('src/apps/experimental/AppOverrides.scss');
        const focusRules = rules.filter(rule => rule.selector.includes('.jellyflixToolbarNav')
            && rule.nodes.some(node => node.type === 'decl' && node.prop === 'outline'));
        expect(focusRules).toHaveLength(1);
        expect(focusRules[0].selector).toBe('.jellyflixToolbarNav > .MuiButton-root:focus-visible:not(.Mui-disabled)');
        const outline = focusRules[0].nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(outline).toMatchObject({ important: true });
        expect(outline?.toString()).toContain('solid var(--jf-semantic-focus-indicator)');
        expect(focusRules[0].nodes.some(node => node.type === 'decl' && node.prop === 'outline-offset')).toBe(true);
        expect(focusRules[0].nodes.some(node => node.type === 'decl' && node.prop === 'box-shadow'
            && node.toString().includes('var(--jf-semantic-focus-separator)'))).toBe(true);
    });

    it('reserves room for the full ring inside the clipping navigation rail', () => {
        const nav = compiledRules('src/apps/experimental/AppOverrides.scss')
            .find(rule => rule.selector === '.jellyflixToolbarNav');
        expect(nav?.nodes.find(node => node.type === 'decl' && node.prop === 'padding'))
            .toMatchObject({ value: 'var(--jf-semantic-space-2)' });

        const gutterRem = Number.parseFloat(SEMANTIC_REFERENCE_TOKENS.space[2]);
        const ringReachRem = Number.parseFloat(SEMANTIC_REFERENCE_TOKENS.space[1]) * 1.5;
        expect(gutterRem).toBeGreaterThan(ringReachRem);

        const toolbar = fs.readFileSync(fromWorkspace('src/apps/experimental/components/AppToolbar/index.tsx'), 'utf8');
        expect(toolbar).toContain("className='jellyflixToolbarNav'");
        expect(toolbar).toContain("overflow: 'hidden'");
    });
});
