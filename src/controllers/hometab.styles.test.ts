import fs from 'node:fs';
import path from 'node:path';
import postcss, { Declaration, Rule } from 'postcss';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const fromWorkspace = (file: string) => path.resolve(process.cwd(), file);

describe('Home route styles', () => {
    it('loads bounded Home styles without importing the legacy Home sections controller', () => {
        const entry = fs.readFileSync(fromWorkspace('src/controllers/hometab.js'), 'utf8');

        expect(entry).toContain("import '../components/homesections/homesections.scss';");
        expect(entry).not.toMatch(/from ['"](?:\.\.\/)?components\/homesections\/homesections['"]/);

        const css = postcss.parse(compile(fromWorkspace('src/components/homesections/homesections.scss')).css);
        const rails: Rule[] = [];
        let hasHeroShell = false;
        css.walkRules(rule => {
            if (rule.selector === '.tvHomeDashboard__rail') rails.push(rule);
            if (rule.selector === '.tvHomeHero__shell') hasHeroShell = true;
        });
        expect(rails.some(rail => rail.nodes.some((node): node is Declaration => node.type === 'decl'
            && node.prop === 'grid-auto-columns' && node.value === 'clamp(19rem, 20.4vw, 28rem)'))).toBe(true);
        expect(hasHeroShell).toBe(true);
    });
});
