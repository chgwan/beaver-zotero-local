import { normalizeDoi } from './types';
import type { ScholarlyResult, ScholarlySearchQuery, ScholarlySource } from './types';

/** How many merged, ranked results a caller gets back absent an explicit `limit`. */
export const DEFAULT_RESULT_LIMIT = 10;

/** Hard ceiling on `limit` — a large result set burns the model's context budget. */
export const MAX_RESULT_LIMIT = 25;

export interface ScholarlySearchOptions {
    sources: ScholarlySource[];
    limit?: number;
}

export interface ScholarlySearchOutcome {
    results: ScholarlyResult[];
    notes: string[];
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Lowercase, strip punctuation, and collapse whitespace so near-identical titles compare equal. */
function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The record with the longer abstract wins a merge; a longer abstract gives the model more to work with. */
function preferRicher(a: ScholarlyResult, b: ScholarlyResult): ScholarlyResult {
    const lenA = a.abstract?.length ?? 0;
    const lenB = b.abstract?.length ?? 0;
    return lenB > lenA ? b : a;
}

/**
 * Fan out to every scholarly source and reconcile the answers.
 *
 * Partial success is the design: one source being down or rate-limited must
 * still yield the other's results, with a note the model can pass on. A search
 * that fails whenever either API hiccups is worse than no search.
 *
 * Dedupe prefers DOI and falls back to normalised title + year, because
 * preprints and older records often carry no DOI and duplicated titles are what
 * a user notices first.
 */
export async function runScholarlySearch(
    query: ScholarlySearchQuery,
    options: ScholarlySearchOptions,
    signal: AbortSignal
): Promise<ScholarlySearchOutcome> {
    const settled = await Promise.allSettled(options.sources.map((source) => source.search(query, signal)));

    const notes: string[] = [];
    const collected: ScholarlyResult[] = [];

    settled.forEach((outcome, index) => {
        const source = options.sources[index];
        if (outcome.status === 'rejected') {
            notes.push(`${source.name}: ${describeError(outcome.reason)}`);
            return;
        }
        if (!outcome.value.ok) {
            notes.push(`${source.name}: ${outcome.value.error}`);
            return;
        }
        collected.push(...outcome.value.results);
    });

    // Dedupe: DOI first (each source normalises its own, but a defensive
    // re-normalise here guards against a non-compliant source), then
    // normalised title + year for the records that have no DOI at all.
    const byDoi = new Map<string, number>();
    const byTitleYear = new Map<string, number>();
    const merged: ScholarlyResult[] = [];

    for (const result of collected) {
        const doiKey = normalizeDoi(result.doi);
        const key = doiKey ?? `${normalizeTitle(result.title)}|${result.year ?? 'unknown'}`;
        const index = doiKey ? byDoi.get(key) : byTitleYear.get(key);

        if (index !== undefined) {
            merged[index] = preferRicher(merged[index], result);
            continue;
        }

        const nextIndex = merged.length;
        merged.push(result);
        if (doiKey) {
            byDoi.set(key, nextIndex);
        } else {
            byTitleYear.set(key, nextIndex);
        }
    }

    merged.sort((a, b) => {
        if (a.citationCount === null && b.citationCount === null) return 0;
        if (a.citationCount === null) return 1;
        if (b.citationCount === null) return -1;
        return b.citationCount - a.citationCount;
    });

    const requestedLimit = options.limit ?? DEFAULT_RESULT_LIMIT;
    const limit = Math.max(1, Math.min(requestedLimit, MAX_RESULT_LIMIT));
    const results = merged.slice(0, limit).map((result, index) => ({ ...result, rank: index + 1 }));

    return { results, notes };
}
