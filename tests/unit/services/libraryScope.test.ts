import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => prefs.value,
    setPref: (_key: string, value: string) => {
        prefs.value = value;
    },
}));

import {
    isLibraryInScope,
    isLibraryScopeKnown,
    parseLocalExcludedLibraries,
    readLocalExcludedLibrariesPref,
    writeLocalExcludedLibrariesPref,
} from '../../../src/services/libraryScope';

function setMirror(mirror: Record<string, unknown> | undefined) {
    (globalThis as any).Zotero.Beaver = mirror;
}

afterEach(() => {
    setMirror(undefined);
});

describe('libraryScope', () => {
    it('reports the scope as unknown until the mirror is published', () => {
        setMirror(undefined);
        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);

        setMirror({});
        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('denies every library when the flag is set without ids', () => {
        setMirror({ libraryScopeInitialized: true });

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('denies every library when ids are present but not yet authoritative', () => {
        setMirror({ libraryScopeInitialized: false, searchableLibraryIds: [1] });

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('allows only the mirrored libraries once the scope is known', () => {
        setMirror({ libraryScopeInitialized: true, searchableLibraryIds: [1, 5] });

        expect(isLibraryScopeKnown()).toBe(true);
        expect(isLibraryInScope(1)).toBe(true);
        expect(isLibraryInScope(5)).toBe(true);
        expect(isLibraryInScope(2)).toBe(false);
    });

    it('treats an empty searchable set as a known scope that allows nothing', () => {
        setMirror({ libraryScopeInitialized: true, searchableLibraryIds: [] });

        expect(isLibraryScopeKnown()).toBe(true);
        expect(isLibraryInScope(1)).toBe(false);
    });
});

describe('local excluded libraries preference', () => {
    beforeEach(() => {
        prefs.value = undefined;
    });

    it('parses an empty string as an empty list', () => {
        expect(parseLocalExcludedLibraries('')).toEqual([]);
    });

    it('parses valid user and group entries', () => {
        expect(parseLocalExcludedLibraries('[{"type":"user"},{"type":"group","group_id":5}]')).toEqual([
            { type: 'user' },
            { type: 'group', group_id: 5 },
        ]);
    });

    it('drops extra properties from a stored entry', () => {
        expect(parseLocalExcludedLibraries('[{"type":"group","group_id":5,"name":"Lab"}]')).toEqual([
            { type: 'group', group_id: 5 },
        ]);
    });

    it.each([
        ['unparseable JSON', 'not json'],
        ['a non-array', '{"type":"user"}'],
        ['an entry missing a group id', '[{"type":"group"}]'],
        ['an entry with an unknown type', '[{"type":"library"}]'],
    ])('treats %s as invalid', (_label, raw) => {
        expect(parseLocalExcludedLibraries(raw)).toBeNull();
    });

    it('reads an empty list when the preference was never set', () => {
        expect(readLocalExcludedLibrariesPref()).toEqual([]);
    });

    it('round-trips a written list through the preference', () => {
        writeLocalExcludedLibrariesPref([{ type: 'user' }, { type: 'group', group_id: 7 }]);

        expect(prefs.value).toBe(JSON.stringify([{ type: 'user' }, { type: 'group', group_id: 7 }]));
        expect(readLocalExcludedLibrariesPref()).toEqual([{ type: 'user' }, { type: 'group', group_id: 7 }]);
    });

    it('surfaces an invalid stored preference as null rather than an empty list', () => {
        prefs.value = 'not json';
        expect(readLocalExcludedLibrariesPref()).toBeNull();
    });
});
