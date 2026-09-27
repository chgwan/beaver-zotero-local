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
 *
 * The same file also backs the "Search" settings group: `parseLocalWebSearchMaxUsesInput`
 * mirrors the round-cap parser for `localWebSearchMaxUses`, and
 * `localWebSearchCapabilityLabel` / `localWebSearchDescription` turn the
 * selected model's hosted-search capability into the copy shown next to the
 * web-search checkbox.
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOCAL_WEB_SEARCH_MAX_USES,
    LOCAL_ROUND_CAP_DESCRIPTION,
    LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION,
    localWebSearchCapabilityLabel,
    localWebSearchDescription,
    needsLocalModeRestart,
    parseLocalMaxRoundsInput,
    parseLocalWebSearchMaxUsesInput,
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

describe('parseLocalWebSearchMaxUsesInput', () => {
    it('stores blank input as 0, which the search config reads as the default', () => {
        expect(parseLocalWebSearchMaxUsesInput('')).toBe(0);
        expect(parseLocalWebSearchMaxUsesInput('   ')).toBe(0);
    });

    it('parses a positive integer', () => {
        expect(parseLocalWebSearchMaxUsesInput('5')).toBe(5);
        expect(parseLocalWebSearchMaxUsesInput('1')).toBe(1);
    });

    it('rejects zero, negative and non-numeric text without a fallback value', () => {
        expect(parseLocalWebSearchMaxUsesInput('0')).toBeNull();
        expect(parseLocalWebSearchMaxUsesInput('-3')).toBeNull();
        expect(parseLocalWebSearchMaxUsesInput('abc')).toBeNull();
        expect(parseLocalWebSearchMaxUsesInput('2.5')).toBeNull();
    });
});

describe('LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION', () => {
    it('names the default a blank field falls back to, and that it is per request', () => {
        expect(LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION).toContain(`default (${DEFAULT_LOCAL_WEB_SEARCH_MAX_USES})`);
        expect(LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION.toLowerCase()).toContain('request');
    });
});

describe('localWebSearchCapabilityLabel', () => {
    it('names each hosted-search capability', () => {
        expect(localWebSearchCapabilityLabel('anthropic')).toBe('Anthropic hosted search');
        expect(localWebSearchCapabilityLabel('openai-responses')).toBe('OpenAI hosted search');
        expect(localWebSearchCapabilityLabel('openrouter')).toBe('OpenRouter web search');
    });

    it('says web search is not available when the model has no hosted-search capability', () => {
        expect(localWebSearchCapabilityLabel(null)).toBe('Not available for this provider');
    });

    it('warns that support is unconfirmed for an Anthropic-format model off the official host', () => {
        expect(localWebSearchCapabilityLabel('anthropic', true)).toBe(
            'Anthropic hosted search (may not be supported by this endpoint)'
        );
    });

    it('omits the endpoint warning when the host is confirmed', () => {
        expect(localWebSearchCapabilityLabel('anthropic', false)).toBe('Anthropic hosted search');
        expect(localWebSearchCapabilityLabel('anthropic')).toBe('Anthropic hosted search');
    });
});

describe('localWebSearchDescription', () => {
    it('names the capability and warns that the provider may bill per search', () => {
        const description = localWebSearchDescription('anthropic');
        expect(description).toContain('Anthropic hosted search');
        expect(description.toLowerCase()).toContain('bill');
    });

    it('states this preference is the master switch behind the composer toggle', () => {
        expect(localWebSearchDescription('openrouter').toLowerCase()).toContain('master switch');
    });

    it('falls back to the unavailable label when the model has no capability', () => {
        expect(localWebSearchDescription(null)).toContain('Not available for this provider');
    });

    it('includes the endpoint warning when the host is unconfirmed', () => {
        expect(localWebSearchDescription('anthropic', true)).toContain('may not be supported by this endpoint');
    });
});
