import type { ExcludedLibrary } from "@beaver/agent-core/types/profile";
import { getPref, setPref } from "../utils/prefs";

/**
 * The instance account service publishes this fail-closed access boundary before
 * notifying any renderer. Background work reads the same authority as chat data handlers.
 */

/**
 * True once the instance holds a resolved scope that can back allow/deny
 * decisions. Callers that would otherwise deny should usually retry later
 * instead of failing a job permanently, because this is also the startup state.
 */
export function isLibraryScopeKnown(): boolean {
    return Zotero.Beaver?.libraryScopeInitialized === true
        && Array.isArray(Zotero.Beaver?.searchableLibraryIds);
}

/** True when `libraryId` is known to be inside the searchable set. */
export function isLibraryInScope(libraryId: number): boolean {
    if (Zotero.Beaver?.libraryScopeInitialized !== true) return false;
    const searchableLibraryIds = Zotero.Beaver?.searchableLibraryIds;
    return Array.isArray(searchableLibraryIds)
        && searchableLibraryIds.includes(libraryId);
}

function isExcludedLibraryEntry(value: unknown): value is ExcludedLibrary {
    if (!value || typeof value !== "object") return false;
    const entry = value as { type?: unknown; group_id?: unknown };
    return (
        entry.type === "user" ||
        (entry.type === "group" && typeof entry.group_id === "number")
    );
}

/**
 * Parses the `localExcludedLibraries` preference's raw JSON text.
 *
 * Returns `null` for anything that is not a JSON array of valid entries —
 * the same shape the plugin realm requires at startup (see
 * `src/services/instanceAccount.ts`). Callers must treat `null` as "unknown
 * / invalid", never as "empty".
 */
export function parseLocalExcludedLibraries(raw: string): ExcludedLibrary[] | null {
    if (raw === "") return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || !parsed.every(isExcludedLibraryEntry)) return null;
    return parsed.map((entry) =>
        entry.type === "group" ? { type: "group" as const, group_id: entry.group_id } : { type: "user" as const },
    );
}

/**
 * Reads and parses the `localExcludedLibraries` preference for display in
 * settings. `null` means the stored value is invalid — the plugin realm
 * itself will have failed closed (no searchable libraries) until it is
 * fixed, so surface that rather than guessing at a list.
 */
export function readLocalExcludedLibrariesPref(): ExcludedLibrary[] | null {
    const raw = getPref("localExcludedLibraries");
    if (raw === undefined) return [];
    return parseLocalExcludedLibraries(String(raw));
}

/** Serializes and writes the local exclusion list. Always valid JSON of the expected shape. */
export function writeLocalExcludedLibrariesPref(entries: ExcludedLibrary[]): void {
    setPref("localExcludedLibraries", JSON.stringify(entries));
}
