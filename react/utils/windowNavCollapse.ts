/**
 * Derives the separate Beaver window's chat-history nav collapse state.
 *
 * The nav (`.beaver-window-nav`, `--beaver-window-nav-width` in beaver.css)
 * is a fixed 264px column. Below a certain window width there simply isn't
 * room for it beside a usable chat column, so it must collapse regardless of
 * the user's saved preference — but only as long as the window stays narrow.
 * This is derived, per-window state: it is never written back to the
 * `windowSidebarCollapsed` preference, so a transient narrow window does not
 * flip the user's saved choice for every renderer that reads it.
 */

/** The nav's fixed width, mirrored from `--beaver-window-nav-width` in beaver.css. */
export const BEAVER_WINDOW_NAV_WIDTH_PX = 264;

/**
 * Extra room required beside the nav before it is worth showing: enough for
 * a usable chat column, not just the nav itself.
 */
export const WINDOW_NAV_COLLAPSE_MARGIN_PX = 320;

/**
 * Whether the window is too narrow to show the nav beside a usable chat
 * column, independent of what the user chose.
 */
export function shouldForceCollapseWindowNav(
    innerWidth: number,
    navWidth: number = BEAVER_WINDOW_NAV_WIDTH_PX,
    margin: number = WINDOW_NAV_COLLAPSE_MARGIN_PX,
): boolean {
    return innerWidth < navWidth + margin;
}

interface WindowNavCollapsedInputs {
    /** The user's saved preference (`windowNavCollapsedAtom`). */
    userCollapsed: boolean;
    /** Whether the window is currently too narrow for the nav. */
    forceCollapsed: boolean;
    /** Whether there is a history list to show at all. */
    hasHistory: boolean;
}

/**
 * The effective collapsed state the nav renders with: collapsed if there is
 * nothing to show, if the user chose to collapse it, or if the window is too
 * narrow — whichever applies first.
 */
export function deriveEffectiveWindowNavCollapsed({
    userCollapsed,
    forceCollapsed,
    hasHistory,
}: WindowNavCollapsedInputs): boolean {
    return !hasHistory || userCollapsed || forceCollapsed;
}
