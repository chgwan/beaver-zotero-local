/**
 * Pure helpers behind the "Local Mode" settings group in ApiKeysSection.
 *
 * Local mode is fixed at plugin startup (`Zotero.Beaver.localMode`, read once
 * in `onStartup`), but the preferences pane lets the user flip the `localMode`
 * pref live. `needsLocalModeRestart` detects that the pref and the running
 * process have drifted, so the UI can tell the user a restart is required.
 * `parseLocalMaxRoundsInput` turns the round-cap text field into the stored
 * preference value, treating blank input as the default cap (the
 * `localMaxRounds` pref's `0`) and rejecting anything that isn't a
 * non-negative integer without touching the stored value.
 * `showLocalRoundCap` keeps the local-only field out of cloud mode.
 */
import { describe, expect, it } from 'vitest';
import {
    LOCAL_ROUND_CAP_DESCRIPTION,
    needsLocalModeRestart,
    parseLocalMaxRoundsInput,
    showLocalRoundCap,
} from '../../../react/components/preferences/localModeSettings';
import { DEFAULT_MAX_ROUNDS } from '@beaver/agent-local/config/localAgentConfig';

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
    it('stores blank input as 0, which runs use as the default cap', () => {
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

describe('showLocalRoundCap', () => {
    it('hides the round cap while local mode is off', () => {
        expect(showLocalRoundCap(false, false)).toBe(false);
    });

    it('shows it when local mode is on, or switched on pending a restart', () => {
        expect(showLocalRoundCap(true, true)).toBe(true);
        expect(showLocalRoundCap(true, false)).toBe(true);
        expect(showLocalRoundCap(false, true)).toBe(true);
    });
});

describe('LOCAL_ROUND_CAP_DESCRIPTION', () => {
    it('names the default a blank field falls back to', () => {
        expect(LOCAL_ROUND_CAP_DESCRIPTION).toContain(`default (${DEFAULT_MAX_ROUNDS})`);
    });
});
