import fs from 'node:fs';
import path from 'node:path';
import postcss, { Rule } from 'postcss';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const fromWorkspace = (file: string) => path.resolve(process.cwd(), file);

function compiledRule(selector: string, property: string): Rule | undefined {
    let found: Rule | undefined;
    postcss.parse(compile(fromWorkspace('src/components/homesections/homesections.scss')).css)
        .walkRules(rule => {
            if (!found && rule.selectors.includes(selector)
                && rule.nodes.some(node => node.type === 'decl' && node.prop === property)) found = rule;
        });
    return found;
}

describe('Home media card image geometry before lazy fetch', () => {
    it('gives the empty image frame a stable width and ratio independent of src', () => {
        const frame = compiledRule('.tvHomeMediaCard__imageFrame', 'width');
        expect(frame?.nodes.some(node => node.type === 'decl' && node.prop === 'width' && node.value === '100%')).toBe(true);
        expect(frame?.nodes.some(node => node.type === 'decl' && node.prop === 'aspect-ratio' && node.value === '16/9')).toBe(true);

        const image = compiledRule('.tvHomeMediaCard__image', 'width');
        expect(image?.nodes.some(node => node.type === 'decl' && node.prop === 'width' && node.value === '100%')).toBe(true);
        const markup = fs.readFileSync(fromWorkspace('src/components/homesections/sections/tvHomeDashboard.ts'), 'utf8');
        expect(markup).toContain('loading="lazy" width="640" height="360"');
        expect(markup).not.toMatch(/tvHomeMediaCard__image" src=/);
    });
});
