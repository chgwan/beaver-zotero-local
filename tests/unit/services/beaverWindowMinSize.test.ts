/**
 * Locks the separate Beaver window's minimum size to 200x300.
 *
 * The floor is declared in two independent places that must agree: the XHTML
 * window attributes (`minwidth`/`minheight`, enforced by the OS/window
 * manager before any CSS runs) and the `#beaver-window` CSS rule (enforced by
 * layout once the window's content loads). Either one drifting back up would
 * silently raise the effective floor with no type error and no lint signal,
 * since both are plain markup/CSS read by Zotero, not by any bundler. This
 * is a static assertion in the absence of a live Zotero window to measure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const xhtmlSource = readFileSync(
    fileURLToPath(new URL('../../../addon/content/beaverWindow.xhtml', import.meta.url)),
    'utf8',
);
const cssSource = readFileSync(
    fileURLToPath(new URL('../../../addon/content/styles/beaver.css', import.meta.url)),
    'utf8',
);

describe('the separate Beaver window minimum size', () => {
    it('declares minwidth="200" and minheight="300" on the <window>', () => {
        const windowTag = xhtmlSource.match(/<window\b[\s\S]*?>/)?.[0];
        expect(windowTag, '<window> element not found in beaverWindow.xhtml').toBeTruthy();
        expect(windowTag).toMatch(/\bminwidth="200"/);
        expect(windowTag).toMatch(/\bminheight="300"/);
    });

    it('keeps the default opening size and persisted attributes untouched', () => {
        const windowTag = xhtmlSource.match(/<window\b[\s\S]*?>/)?.[0] ?? '';
        expect(windowTag).toMatch(/\bwidth="1040"/);
        expect(windowTag).toMatch(/\bheight="720"/);
        expect(windowTag).toMatch(/\bpersist="screenX screenY width height"/);
    });

    it('sets the #beaver-window CSS floor to 200px / 300px', () => {
        const rule = cssSource.match(/#beaver-window\s*\{([^}]*)\}/)?.[1];
        expect(rule, '#beaver-window rule not found in beaver.css').toBeTruthy();
        expect(rule).toMatch(/min-width:\s*200px;/);
        expect(rule).toMatch(/min-height:\s*300px;/);
    });
});
