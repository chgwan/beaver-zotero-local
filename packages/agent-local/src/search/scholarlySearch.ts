import { normalizeDoi } from './types';
import type { ScholarlyResult, ScholarlySearchQuery, ScholarlySource } from './types';

/** How many merged, ranked results a caller gets back absent an explicit `limit`. */
export const DEFAULT_RESULT_LIMIT = 10;

/** Hard ceiling on `limit` — a large result set burns the model's context budget. */
export const MAX_RESULT_LIMIT = 25;

export interface ScholarlySearchOptions {
    sources: ScholarlySource[];
    /** Cap on the final merged/deduped/ranked result count — not a source's request size; see `ScholarlySearchQuery.limit`. Defaults to `DEFAULT_RESULT_LIMIT`, clamped to `MAX_RESULT_LIMIT`. */
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

/**
 * Combines two records the dedupe pass identified as the same work, field by
 * field, rather than picking one record wholesale — a source with the
 * richer abstract is not necessarily the one with the best citation count,
 * OA link, or venue, and discarding the loser's better fields would silently
 * degrade the card Task 5 renders from these results.
 *
 * `source`/`id`/`url` are the one exception: they identify *which* record a
 * link resolves to, so they travel together and always come from `base` —
 * whichever record was merged first. That is deterministic and independent
 * of network timing, because sources are combined in `options.sources`
 * order (see the `forEach` below), not the order their requests resolve.
 */
function mergeResults(base: ScholarlyResult, incoming: ScholarlyResult): ScholarlyResult {
    const abstract =
        (incoming.abstract?.length ?? 0) > (base.abstract?.length ?? 0) ? incoming.abstract : base.abstract;

    const citationCount =
        base.citationCount === null && incoming.citationCount === null
            ? null
            : Math.max(base.citationCount ?? -Infinity, incoming.citationCount ?? -Infinity);

    return {
        source: base.source,
        id: base.id,
        url: base.url,
        title: base.title || incoming.title,
        abstract,
        authors: base.authors.length > 0 ? base.authors : incoming.authors,
        year: base.year ?? incoming.year,
        venue: base.venue ?? incoming.venue,
        doi: base.doi ?? incoming.doi,
        citationCount,
        openAccessUrl: base.openAccessUrl ?? incoming.openAccessUrl,
        pdfUrl: base.pdfUrl ?? incoming.pdfUrl,
        isOpenAccess: base.isOpenAccess === true || incoming.isOpenAccess === true
            ? true
            : base.isOpenAccess ?? incoming.isOpenAccess,
        publicationDate: base.publicationDate ?? incoming.publicationDate,
    };
}

/**
 * Fan out to every scholarly source and reconcile the answers.
 *
 * Partial success is the design: one source being down or rate-limited must
 * still yield the other's results, with a note the model can pass on. A search
 * that fails whenever either API hiccups is worse than no search.
 *
 * Dedupe keys on DOI and falls back to normalised title + year, because
 * preprints and older records often carry no DOI and duplicated titles are
 * what a user notices first. A duplicate is merged field by field (see
 * `mergeResults`), not resolved by picking one source's record wholesale.
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
            merged[index] = mergeResults(merged[index], result);
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
