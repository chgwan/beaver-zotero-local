import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => prefs.value,
    setPref: (_key: string, value: string) => {
        prefs.value = value;
    },
}));

import { localExcludedLibraryEntriesAtom } from '../../../react/atoms/profile';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';

describe('localExcludedLibraryEntriesAtom', () => {
    it('reads an empty list when the preference was never set', () => {
        prefs.value = undefined;
        const store = createStore();
        expect(store.get(localExcludedLibraryEntriesAtom)).toEqual([]);
    });

    it('reports null for an invalid stored preference', () => {
        prefs.value = 'not json';
        const store = createStore();
        expect(store.get(localExcludedLibraryEntriesAtom)).toBeNull();
    });

    it('re-reads after a preferences revision bump', () => {
        prefs.value = undefined;
        const store = createStore();
        expect(store.get(localExcludedLibraryEntriesAtom)).toEqual([]);

        prefs.value = JSON.stringify([{ type: 'user' }]);
        store.set(preferencesRevisionAtom, (n) => n + 1);
        expect(store.get(localExcludedLibraryEntriesAtom)).toEqual([{ type: 'user' }]);
    });
});
