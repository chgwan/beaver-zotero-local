import { describe, expect, it } from 'vitest';
import {
    BEAVER_WINDOW_NAV_WIDTH_PX,
    deriveEffectiveWindowNavCollapsed,
    shouldForceCollapseWindowNav,
    WINDOW_NAV_COLLAPSE_MARGIN_PX,
} from '../../../react/utils/windowNavCollapse';

describe('shouldForceCollapseWindowNav', () => {
    it('forces collapse at the window minimum, well under the threshold', () => {
        expect(shouldForceCollapseWindowNav(200)).toBe(true);
    });

    it('forces collapse just below nav width + margin', () => {
        const threshold = BEAVER_WINDOW_NAV_WIDTH_PX + WINDOW_NAV_COLLAPSE_MARGIN_PX;
        expect(shouldForceCollapseWindowNav(threshold - 1)).toBe(true);
    });

    it('does not force collapse at or above nav width + margin', () => {
        const threshold = BEAVER_WINDOW_NAV_WIDTH_PX + WINDOW_NAV_COLLAPSE_MARGIN_PX;
        expect(shouldForceCollapseWindowNav(threshold)).toBe(false);
        expect(shouldForceCollapseWindowNav(threshold + 1)).toBe(false);
    });

    it('does not force collapse at the default window size', () => {
        expect(shouldForceCollapseWindowNav(1040)).toBe(false);
    });

    it('accepts an explicit nav width and margin instead of the defaults', () => {
        expect(shouldForceCollapseWindowNav(350, 300, 100)).toBe(true);
        expect(shouldForceCollapseWindowNav(500, 100, 100)).toBe(false);
    });
});

describe('deriveEffectiveWindowNavCollapsed', () => {
    it('is collapsed whenever there is no history to show, regardless of the other inputs', () => {
        expect(deriveEffectiveWindowNavCollapsed({
            userCollapsed: false,
            forceCollapsed: false,
            hasHistory: false,
        })).toBe(true);
    });

    it('is collapsed when the user chose to collapse it, even with room to spare', () => {
        expect(deriveEffectiveWindowNavCollapsed({
            userCollapsed: true,
            forceCollapsed: false,
            hasHistory: true,
        })).toBe(true);
    });

    it('is collapsed when the window is too narrow, even if the user wants it open', () => {
        expect(deriveEffectiveWindowNavCollapsed({
            userCollapsed: false,
            forceCollapsed: true,
            hasHistory: true,
        })).toBe(true);
    });

    it('is expanded only when there is history, the user wants it open, and there is room', () => {
        expect(deriveEffectiveWindowNavCollapsed({
            userCollapsed: false,
            forceCollapsed: false,
            hasHistory: true,
        })).toBe(false);
    });
});
