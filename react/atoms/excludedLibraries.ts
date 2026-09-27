import { atom } from 'jotai';
import { ExcludedLibrary } from '@beaver/agent-core/types/profile';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';
import { writeLocalExcludedLibrariesPref } from '../../src/services/libraryScope';
import {
    excludedEntryFromLibrary,
    excludedEntryKey,
    libraryExclusionKey,
    localExcludedLibraryEntriesAtom,
    profileWithPlanAtom,
} from './profile';
import { localModeEnabledAtom } from './localMode';

export const isUpdatingExcludedLibrariesAtom = atom(false);

/**
 * Toggles one library's membership in an exclusion list, preserving entries
 * for libraries this device doesn't currently see (e.g. a group the account
 * excluded from another device).
 */
export function nextExcludedLibraries(current: ExcludedLibrary[], library: ZoteroLibrary): ExcludedLibrary[] {
    const toggledKey = libraryExclusionKey(library);
    const isExcluded = current.some(entry => excludedEntryKey(entry) === toggledKey);
    return isExcluded
        ? current.filter(entry => excludedEntryKey(entry) !== toggledKey)
        : [...current, excludedEntryFromLibrary(library)];
}

export const toggleExcludedLibraryAtom = atom(
    null,
    async (get, set, library: ZoteroLibrary) => {
        if (get(localModeEnabledAtom)) {
            // No profile in local mode: the exclusion list lives in the
            // `localExcludedLibraries` preference. The plugin realm observes
            // it and re-publishes the searchable scope, so the edit applies
            // at once.
            const current = get(localExcludedLibraryEntriesAtom) ?? [];
            const next = nextExcludedLibraries(current, library);
            try {
                writeLocalExcludedLibrariesPref(next);
            } catch (error) {
                set(addPopupMessageAtom, {
                    type: 'error',
                    title: 'Unable to update library access',
                    text: 'Your excluded libraries were not saved. Try again.',
                });
            }
            return;
        }

        const profile = get(profileWithPlanAtom);
        if (!profile) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Unable to update library access',
                text: 'Your profile is not loaded. Try again after Beaver reconnects.',
            });
            return;
        }

        const current = profile.excluded_libraries ?? [];
        const next = nextExcludedLibraries(current, library);

        set(isUpdatingExcludedLibrariesAtom, true);

        try {
            await Zotero.Beaver.account!.updateExcludedLibraries(next);
        } catch (error) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Unable to update library access',
                text: 'Your excluded libraries were not saved. Check your connection and try again.',
            });
        } finally {
            set(isUpdatingExcludedLibrariesAtom, false);
        }
    },
);
