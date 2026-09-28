/**
 * The separate window's nav toggle must stay inert while force-collapsed
 * (the window is too narrow to show the nav): a click must never flip the
 * saved sidebar preference, since the nav has nowhere to fit either way, and
 * the button must stay natively enabled (only `aria-disabled`) so Gecko keeps
 * firing the hover events its tooltip needs — a real `disabled` attribute
 * suppresses those.
 */
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => prefs[key]),
    setPref: vi.fn((key: string, value: unknown) => { prefs[key] = value; }),
}));

import WindowHeader from '../../../../react/components/window/WindowHeader';
import { setPref } from '../../../../src/utils/prefs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let store = createStore();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    vi.clearAllMocks();
    store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

function render(navForceCollapsed: boolean): HTMLButtonElement {
    act(() => root.render(
        React.createElement(Provider, { store },
            React.createElement(WindowHeader, { showChat: true, navForceCollapsed }),
        ),
    ));
    return container.querySelector<HTMLButtonElement>('button.scale-14')!;
}

describe('WindowHeader nav toggle while force-collapsed', () => {
    it('is aria-disabled but not natively disabled, so hover/tooltip events keep firing', () => {
        const button = render(true);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.disabled).toBe(false);
    });

    it('does nothing on click and never writes the sidebar preference', () => {
        const button = render(true);
        act(() => button.click());
        expect(setPref).not.toHaveBeenCalled();
        expect(prefs.windowSidebarCollapsed).toBeUndefined();
    });

    it('reports the "widen the window" tooltip label while forced', () => {
        const button = render(true);
        expect(button.getAttribute('aria-label')).toBe('Widen the window to show chat history');
    });

    it('still toggles and writes the preference once the window is wide enough', () => {
        const button = render(false);
        expect(button.getAttribute('aria-disabled')).toBe('false');
        act(() => button.click());
        expect(setPref).toHaveBeenCalledWith('windowSidebarCollapsed', true);
    });
});
