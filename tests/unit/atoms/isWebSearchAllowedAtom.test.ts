import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({ getPref: () => true }));

import { isWebSearchAllowedAtom, requestPlusToolsAtom } from '../../../react/atoms/ui';
import { selectedModelAtom } from '../../../react/atoms/models';

afterEach(() => {
    Zotero.Beaver = { ...(Zotero.Beaver as any), localMode: false } as any;
});

describe('isWebSearchAllowedAtom', () => {
    it('is false in local mode even with a stale requestPlusTools pref left over from cloud mode', () => {
        Zotero.Beaver = { ...(Zotero.Beaver as any), localMode: true } as any;
        const store = createStore();

        expect(store.get(requestPlusToolsAtom)).toBe(true);
        expect(store.get(isWebSearchAllowedAtom)).toBe(false);
    });

    it('follows Plus Tools / Beaver-credits state in cloud mode', () => {
        const store = createStore();
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);

        store.set(requestPlusToolsAtom, false);
        // No model selected yet defaults to "using Beaver credits".
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);

        store.set(selectedModelAtom, { access_mode: 'byok', allow_app_key: false } as any);
        expect(store.get(isWebSearchAllowedAtom)).toBe(false);

        store.set(requestPlusToolsAtom, true);
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);
    });
});
