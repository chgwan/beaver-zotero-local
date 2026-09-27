/**
 * Pure helpers for the "Local Mode" and "Search" settings groups. Kept free of
 * React and Jotai so the decision logic behind them is testable without a
 * component-rendering harness.
 */

import { DEFAULT_MAX_ROUNDS } from '@beaver/agent-local/config/localAgentConfig';
import type { HostedWebSearchKind } from '@beaver/agent-local/llm/webSearchCapability';

/**
 * Local mode is fixed at plugin startup (`Zotero.Beaver.localMode`, read once
 * in `onStartup`), but the preferences pane lets the user flip the `localMode`
 * pref immediately. This detects that the live pref has drifted from the
 * value the running process started with, so the UI can prompt for a
 * restart rather than imply the change already took effect.
 */
export function needsLocalModeRestart(prefValue: boolean, activeValue: boolean): boolean {
    return prefValue !== activeValue;
}

/**
 * Whether to show the round-cap field: only when local mode is on, or has
 * been switched on and is waiting for a restart. Cloud mode has no use for it.
 */
export function showLocalRoundCap(prefValue: boolean, activeValue: boolean): boolean {
    return prefValue || activeValue;
}

/** Description for the round-cap field, naming the default a blank field uses. */
export const LOCAL_ROUND_CAP_DESCRIPTION =
    `Limit how many tool-calling rounds a single run can take before it stops. Leave blank for the default (${DEFAULT_MAX_ROUNDS}).`;

/**
 * Parse the round-cap text field into the value stored in the
 * `localMaxRounds` preference. Blank input stores that preference's `0`
 * default, which runs read as `DEFAULT_MAX_ROUNDS`; there is no uncapped
 * setting. Returns null for text that isn't a non-negative integer, so the
 * caller can leave the invalid text on screen without persisting it.
 */
export function parseLocalMaxRoundsInput(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return 0;
    if (!/^\d+$/.test(trimmed)) return null;
    return parseInt(trimmed, 10);
}

/**
 * Default `localWebSearchMaxUses` applied when the preference is unset or the
 * field is left blank. Mirrors the pref's default in `addon/prefs.js` and
 * `DEFAULT_LOCAL_WEB_SEARCH_MAX_USES` in `react/atoms/localAgentConfig.ts`
 * (kept as a literal here, not imported, so this module stays free of Jotai).
 */
export const DEFAULT_LOCAL_WEB_SEARCH_MAX_USES = 3;

/** Description for the "max searches per request" field. */
export const LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION =
    `Most searches the provider may run for a single request. A run can make several requests. Leave blank for the default (${DEFAULT_LOCAL_WEB_SEARCH_MAX_USES}).`;

/**
 * Parse the "max searches per request" text field into the value stored in
 * the `localWebSearchMaxUses` preference. Blank input stores `0`, which the
 * search config reads as "use the default"; any other input must be a
 * positive integer, since zero or fewer searches makes no sense. Returns null
 * for invalid text so the caller can leave it on screen without persisting it.
 */
export function parseLocalWebSearchMaxUsesInput(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return 0;
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = parseInt(trimmed, 10);
    return parsed >= 1 ? parsed : null;
}

/**
 * Human label for a model's hosted web-search capability, shown next to the
 * web-search checkbox so the user knows what turning it on does for the
 * model they currently have selected.
 */
export function localWebSearchCapabilityLabel(kind: HostedWebSearchKind | null): string {
    switch (kind) {
        case 'anthropic':
            return 'Anthropic hosted search';
        case 'openai-responses':
            return 'OpenAI hosted search';
        case 'openrouter':
            return 'OpenRouter web search';
        default:
            return 'Not available for this provider';
    }
}

/**
 * Description for the web-search checkbox: names the selected model's hosted
 * search capability, warns that the provider may bill per search, and states
 * that this preference is the master switch behind the composer's
 * per-message web-search toggle.
 */
export function localWebSearchDescription(kind: HostedWebSearchKind | null): string {
    return `${localWebSearchCapabilityLabel(kind)}. Your provider may bill per search. `
        + `This is the master switch — the composer's web-search toggle turns it on per message.`;
}
