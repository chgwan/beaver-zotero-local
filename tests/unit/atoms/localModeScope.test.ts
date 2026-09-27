/**
 * The renderer's library scope in local mode: no profile, so the scope is the
 * one the plugin realm published from the local libraries and the local
 * exclusion list.
 */
import { createStore } from 'jotai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoteroLibrary } from '@beaver/agent-core/types/zotero';

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-local' })),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    accountRevisionAtom,
    allLibrariesExcludedAtom,
    excludedLibraryIdsAtom,
    isLibraryAccessReadyAtom,
    isProfileLoadedAtom,
    localZoteroLibrariesAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { chatAccessGateAtom } from '../../../react/atoms/chatAccess';
import { runUserIdAtom, sessionAtom } from '../../../react/atoms/auth';
import { localModeEnabledAtom } from '../../../react/atoms/localMode';

const zotero = (globalThis as any).Zotero;
const library = (id: number, group: number | null = null): ZoteroLibrary =>
    ({ library_id: id, group_id: group, is_group: group !== null, name: `L${id}`, type: group ? 'group' : 'user', type_id: id, read_only: false }) as ZoteroLibrary;

function publish(store: ReturnType<typeof createStore>, beaver: Record<string, unknown>) {
    zotero.Beaver = { localMode: true, ...beaver };
    store.set(accountRevisionAtom, (value) => value + 1);
}

afterAll(() => {
    zotero.Beaver = undefined;
});

describe('local mode', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        zotero.Beaver = { localMode: true };
        store = createStore();
        store.set(localZoteroLibrariesAtom, [library(1), library(2, 20), library(3, 30)]);
    });

    it('reads the flag from the plugin realm', () => {
        expect(store.get(localModeEnabledAtom)).toBe(true);
    });

    it('takes the searchable set from the plugin realm without a profile', () => {
        publish(store, { libraryScopeInitialized: true, searchableLibraryIds: [1, 3] });

        expect(store.get(isProfileLoadedAtom)).toBe(false);
        expect(store.get(searchableLibraryIdsAtom)).toEqual([1, 3]);
        expect(store.get(excludedLibraryIdsAtom)).toEqual([2]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(true);
        expect(store.get(allLibrariesExcludedAtom)).toBe(false);
    });

    it('fails closed until the plugin realm has published a scope', () => {
        publish(store, { libraryScopeInitialized: false, searchableLibraryIds: [1, 2, 3] });

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);
        expect(store.get(excludedLibraryIdsAtom)).toEqual([]);
    });

    it('reports every library excluded when the plugin realm allows none', () => {
        publish(store, { libraryScopeInitialized: true, searchableLibraryIds: [] });

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(allLibrariesExcludedAtom)).toBe(true);
        expect(store.get(excludedLibraryIdsAtom)).toEqual([1, 2, 3]);
    });

    it('follows a later account publish', () => {
        publish(store, { libraryScopeInitialized: true, searchableLibraryIds: [1] });
        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);

        publish(store, { libraryScopeInitialized: true, searchableLibraryIds: [1, 2] });
        expect(store.get(searchableLibraryIdsAtom)).toEqual([1, 2]);
    });

    it('opens chat without a session and stamps runs with the local user', () => {
        expect(store.get(sessionAtom)).toBeNull();
        expect(store.get(chatAccessGateAtom)).toBeNull();
        expect(store.get(runUserIdAtom)).toBe('local');
    });
});

describe('cloud mode', () => {
    it('keeps the account gates and the account user id', () => {
        zotero.Beaver = { localMode: false, libraryScopeInitialized: true, searchableLibraryIds: [1] };
        const store = createStore();
        store.set(localZoteroLibrariesAtom, [library(1)]);

        expect(store.get(localModeEnabledAtom)).toBe(false);
        expect(store.get(chatAccessGateAtom)).toBe('signed-out');
        expect(store.get(runUserIdAtom)).toBeNull();
        // The profile, not the plugin-realm mirror, drives the cloud scope.
        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(sessionAtom, { access_token: 't', user: { id: 'user-1' } } as any);
        expect(store.get(runUserIdAtom)).toBe('user-1');
    });
});
