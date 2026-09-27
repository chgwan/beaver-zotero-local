/**
 * Pure helpers behind the "Local Mode" settings group in ApiKeysSection.
 *
 * Local mode is fixed at plugin startup (`Zotero.Beaver.localMode`, read once
 * in `onStartup`), but the preferences pane lets the user flip the `localMode`
 * pref live. `needsLocalModeRestart` detects that the pref and the running
 * process have drifted, so the UI can tell the user a restart is required.
 * `parseLocalMaxRoundsInput` turns the round-cap text field into the stored
 * preference value, treating blank input as "no cap" (matching the
 * `localMaxRounds` pref's `0` default) and rejecting anything that isn't a
 * non-negative integer without touching the stored value.
 */
import { describe, expect, it } from 'vitest';
import { needsLocalModeRestart, parseLocalMaxRoundsInput } from '../../../react/components/preferences/localModeSettings';

describe('needsLocalModeRestart', () => {
    it('is false when the pref matches the running process', () => {
        expect(needsLocalModeRestart(true, true)).toBe(false);
        expect(needsLocalModeRestart(false, false)).toBe(false);
    });

    it('is true when the pref has been flipped but not yet applied', () => {
        expect(needsLocalModeRestart(true, false)).toBe(true);
        expect(needsLocalModeRestart(false, true)).toBe(true);
    });
});

describe('parseLocalMaxRoundsInput', () => {
    it('treats blank input as no cap', () => {
        expect(parseLocalMaxRoundsInput('')).toBe(0);
        expect(parseLocalMaxRoundsInput('   ')).toBe(0);
    });

    it('parses a positive integer', () => {
        expect(parseLocalMaxRoundsInput('25')).toBe(25);
    });

    it('rejects non-numeric text without a fallback value', () => {
        expect(parseLocalMaxRoundsInput('abc')).toBeNull();
        expect(parseLocalMaxRoundsInput('-5')).toBeNull();
        expect(parseLocalMaxRoundsInput('1.5')).toBeNull();
    });
});
