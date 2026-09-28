// @vitest-environment jsdom

/**
 * `useWindowNavAutoCollapse` tracks the separate window's own width — not
 * `window.innerWidth` (per CLAUDE.md, always the surface window) — and
 * recomputes on resize, unsubscribing on unmount so a closed or replaced
 * surface never leaks a listener.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SurfaceWindowContext } from '../../../react/runtime/SurfaceWindowContext';
import { useWindowNavAutoCollapse } from '../../../react/hooks/useWindowNavAutoCollapse';
import { BEAVER_WINDOW_NAV_WIDTH_PX, WINDOW_NAV_COLLAPSE_MARGIN_PX } from '../../../react/utils/windowNavCollapse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXPANDED_WIDTH = BEAVER_WINDOW_NAV_WIDTH_PX + WINDOW_NAV_COLLAPSE_MARGIN_PX + 100;
const NARROW_WIDTH = 200;

/** A minimal fake `Window`: a real EventTarget with a settable `innerWidth`. */
class FakeSurfaceWindow extends EventTarget {
    innerWidth: number;
    constructor(innerWidth: number) {
        super();
        this.innerWidth = innerWidth;
    }
    resizeTo(width: number) {
        this.innerWidth = width;
        this.dispatchEvent(new Event('resize'));
    }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hookResult: boolean | null = null;
let surfaceWindow: FakeSurfaceWindow;

function Harness() {
    hookResult = useWindowNavAutoCollapse();
    return null;
}

function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            React.createElement(
                SurfaceWindowContext.Provider,
                { value: surfaceWindow as unknown as Window },
                React.createElement(Harness),
            ),
        );
    });
}

beforeEach(() => {
    hookResult = null;
});

afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('useWindowNavAutoCollapse', () => {
    it('is false when the surface window already has room for the nav', () => {
        surfaceWindow = new FakeSurfaceWindow(EXPANDED_WIDTH);
        mount();
        expect(hookResult).toBe(false);
    });

    it('is true when the surface window starts narrower than the threshold', () => {
        surfaceWindow = new FakeSurfaceWindow(NARROW_WIDTH);
        mount();
        expect(hookResult).toBe(true);
    });

    it('recomputes when the surface window resizes', () => {
        surfaceWindow = new FakeSurfaceWindow(EXPANDED_WIDTH);
        mount();
        expect(hookResult).toBe(false);

        act(() => { surfaceWindow.resizeTo(NARROW_WIDTH); });
        expect(hookResult).toBe(true);

        act(() => { surfaceWindow.resizeTo(EXPANDED_WIDTH); });
        expect(hookResult).toBe(false);
    });

    it('removes the exact listener it registered, on unmount', () => {
        surfaceWindow = new FakeSurfaceWindow(EXPANDED_WIDTH);
        const addSpy = vi.spyOn(surfaceWindow, 'addEventListener');
        const removeSpy = vi.spyOn(surfaceWindow, 'removeEventListener');

        mount();
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(addSpy.mock.calls[0][0]).toBe('resize');
        const registeredListener = addSpy.mock.calls[0][1];

        act(() => { root!.unmount(); });

        expect(removeSpy).toHaveBeenCalledWith('resize', registeredListener);
    });
});
