/**
 * Pure helpers for the "Local Mode" settings group. Kept free of React and
 * Jotai so the decision logic behind the group is testable without a
 * component-rendering harness.
 */

import { DEFAULT_MAX_ROUNDS } from '@beaver/agent-local/config/localAgentConfig';

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
