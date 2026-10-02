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

describe('legacy details button focus shape', () => {
    it('overrides the global important outline only for enabled keyboard focus', () => {
        const button = compiledRules('src/elements/emby-button/emby-button.scss')
            .find(rule => rule.selector === '.emby-button');
        const suppressedOutline = button?.nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(suppressedOutline).toMatchObject({ value: 'none', important: true });

        const details = compiledRules('src/styles/librarybrowser.scss');
        const outlinedDetails = details.filter(rule => rule.selector.includes('.detailButton')
            && rule.nodes.some(node => node.type === 'decl' && node.prop === 'outline'));
        expect(outlinedDetails).toHaveLength(1);
        expect(outlinedDetails[0].selector).toBe('.itemDetailPage .detailButton:focus-visible:not(:disabled)');
        const outline = outlinedDetails[0].nodes.find(node => node.type === 'decl' && node.prop === 'outline');
        expect(outline).toMatchObject({ important: true });
        expect(outline?.toString()).toContain('solid var(--jf-semantic-focus-indicator)');
        expect(outlinedDetails[0].nodes.some(node => node.type === 'decl' && node.prop === 'outline-offset')).toBe(true);
        expect(outlinedDetails[0].nodes.some(node => node.type === 'decl' && node.prop === 'box-shadow')).toBe(true);
    });

    it('uses tokens available on the legacy details route', () => {
        const markup = fs.readFileSync(fromWorkspace('src/controllers/itemdetails/index.html'), 'utf8');
        const semanticAliases = fs.readFileSync(fromWorkspace('src/themes/_base/_semantic.scss'), 'utf8');
        expect(markup).toMatch(/class="[^"]*btnPlay[^"]*detailButton/);
        expect(semanticAliases).toContain('--jf-semantic-focus-indicator:');
        expect(semanticAliases).toContain('--jf-semantic-focus-separator:');
    });
});
