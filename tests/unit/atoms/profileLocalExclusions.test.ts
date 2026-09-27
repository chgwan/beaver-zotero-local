import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';

const prefs = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => prefs.value,
    setPref: (_key: string, value: string) => {
        prefs.value = value;
    },
}));

import {
    excludedIdSetsDiffer,
    localExcludedLibraryEntriesAtom,
    localZoteroLibrariesAtom,
    pendingExcludedLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';

function library(overrides: Partial<ZoteroLibrary>): ZoteroLibrary {
    return {
        library_id: 1,
        group_id: null,
        name: 'My Library',
        is_group: false,
        type: 'user',
        type_id: 1,
        read_only: false,
        ...overrides,
    };
}

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

describe('pendingExcludedLibraryIdsAtom', () => {
    it('projects the pending preference onto the local library list', () => {
        prefs.value = JSON.stringify([{ type: 'group', group_id: 77 }]);
        const store = createStore();
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 2, is_group: true, group_id: 77, type: 'group' }),
        ]);

        expect(store.get(pendingExcludedLibraryIdsAtom)).toEqual([2]);
    });

    it('excludes nothing when the stored preference is invalid', () => {
        prefs.value = 'not json';
        const store = createStore();
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(pendingExcludedLibraryIdsAtom)).toEqual([]);
    });
});

describe('excludedIdSetsDiffer', () => {
    it('is false for the same set regardless of order', () => {
        expect(excludedIdSetsDiffer([1, 2], [2, 1])).toBe(false);
    });

    it('is true when lengths differ', () => {
        expect(excludedIdSetsDiffer([1], [1, 2])).toBe(true);
    });

    it('is true when the same length has different members', () => {
        expect(excludedIdSetsDiffer([1, 2], [1, 3])).toBe(true);
    });

    it('is false for two empty sets', () => {
        expect(excludedIdSetsDiffer([], [])).toBe(false);
    });
});
