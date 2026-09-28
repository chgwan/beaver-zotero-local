/**
 * The separate Beaver window's `.markdown` container sets `overflow-wrap`
 * once so every descendant inherits it (list items, table cells, code,
 * headings, …), rather than repeating it on individual `p`/`a` selectors and
 * missing everything else. This is a static assertion in the absence of a
 * live Zotero window to measure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cssSource = readFileSync(
    fileURLToPath(new URL('../../../addon/content/styles/beaver.css', import.meta.url)),
    'utf8',
);

describe('the separate Beaver window markdown overflow-wrap rule', () => {
    it('sets overflow-wrap: anywhere on the .markdown container itself', () => {
        const rule = cssSource.match(/#beaver-pane-window \.markdown\s*\{([^}]*)\}/)?.[1];
        expect(rule, '#beaver-pane-window .markdown rule not found in beaver.css').toBeTruthy();
        expect(rule).toMatch(/overflow-wrap:\s*anywhere;/);
    });

    it('no longer scopes the rule to only the p/a descendants', () => {
        expect(cssSource).not.toMatch(/#beaver-pane-window \.markdown p,\s*\n?\s*#beaver-pane-window \.markdown a\s*\{/);
    });
});
