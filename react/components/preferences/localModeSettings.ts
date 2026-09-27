/**
 * Pure helpers for the "Local Mode" settings group. Kept free of React and
 * Jotai so the decision logic behind the group is testable without a
 * component-rendering harness.
 */

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
 * Parse the round-cap text field into the value stored in the
 * `localMaxRounds` preference. Blank input means "no cap", matching that
 * preference's `0` default. Returns null for text that isn't a non-negative
 * integer, so the caller can leave the invalid text on screen without
 * persisting it.
 */
export function parseLocalMaxRoundsInput(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return 0;
    if (!/^\d+$/.test(trimmed)) return null;
    return parseInt(trimmed, 10);
}
