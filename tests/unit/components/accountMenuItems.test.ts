// @vitest-environment jsdom
/**
 * The account menu offers the same entries as upstream in cloud mode, signed
 * in or not; local mode has no Beaver account, so the account entries are
 * hidden there.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/ui/openPreferencesWindow', () => ({ openPreferencesWindow: vi.fn() }));
vi.mock('../../../react/components/icons/icons', () => ({
    SettingsIcon: () => null,
    UserIcon: () => null,
    LogoutIcon: () => null,
    BugIcon: () => null,
    InformationCircleIcon: () => null,
    IdeaIcon: () => null,
}));

import { useAccountMenuItems } from '../../../react/components/ui/buttons/UserAccountMenuButton';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const zotero = (globalThis as any).Zotero;
const previousBeaver = zotero.Beaver;

afterEach(() => {
    zotero.Beaver = previousBeaver;
});

function menuLabels(localMode: boolean): string[] {
    zotero.Beaver = { ...(previousBeaver ?? {}), localMode };
    let labels: string[] = [];
    const Probe = () => {
        labels = useAccountMenuItems().map((item) => item.label);
        return null;
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(React.createElement(Provider, { store: createStore() }, React.createElement(Probe))));
    act(() => root.unmount());
    return labels;
}

describe('useAccountMenuItems', () => {
    it('offers the account entries to a signed-out cloud user, as upstream does', () => {
        expect(menuLabels(false)).toEqual(['Settings', 'Manage Account', 'Get Help', 'Report Error', 'Logout']);
    });

    it('hides the account entries in local mode', () => {
        expect(menuLabels(true)).toEqual(['Settings', 'Get Help']);
    });
});
