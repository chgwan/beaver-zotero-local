/**
 * One shape for results from every scholarly source.
 *
 * The model sees this, not a provider's raw JSON, so a new source can be
 * added without changing the tool's contract or the prompt. `source` uses the
 * same values as the UI's external-reference card, so a caller building that
 * card's data can pass this straight through.
 */
export interface ScholarlyResult {
    source: 'openalex' | 'semantic_scholar';
    /** The source's own identifier (OpenAlex's short `W…` id, or S2's `paperId`). */
    id: string;
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
    /** Normalised, bare form — see `normalizeDoi`. */
    doi: string | null;
    /** Link to the source's page for this work. */
    url: string | null;
    abstract: string | null;
    citationCount: number | null;
    openAccessUrl: string | null;
    pdfUrl: string | null;
    isOpenAccess: boolean | null;
    /** ISO date (YYYY-MM-DD) when the source reports one; `year` alone otherwise. */
    publicationDate: string | null;
    /** 1-based position after ranking. Set by `runScholarlySearch`; absent on a source's raw results. */
    rank?: number;
}

export interface ScholarlySearchQuery {
    query: string;
    /** How many results to request from *each* source — not the final merged count; see `ScholarlySearchOptions.limit`. */
    limit: number;
    yearFrom?: number;
    yearTo?: number;
}

/**
 * Why a source failed. Lets a caller merging failures across sources tell a
 * problem the user can fix in preferences (`auth`, `budget`) or one that will
 * not succeed by retrying immediately (`rate_limit`, once the source's own
 * retries are already spent) apart from a transient problem worth retrying
 * (`network`, `server`) or a cancelled request.
 */
export type SourceFailureKind = 'auth' | 'budget' | 'rate_limit' | 'network' | 'server' | 'cancelled';

export type SourceOutcome =
    | { ok: true; results: ScholarlyResult[] }
    | { ok: false; error: string; kind?: SourceFailureKind };

export interface ScholarlySource {
    name: string;
    search(query: ScholarlySearchQuery, signal: AbortSignal): Promise<SourceOutcome>;
}

/**
 * Reduce a DOI to its bare form for comparison.
 *
 * Sources disagree about prefixes and case, so `https://doi.org/10.1/X`,
 * `doi:10.1/x`, and `10.1/x` must compare equal or dedupe silently fails.
 */
export function normalizeDoi(value: string | null | undefined): string | null {
    if (!value) return null;
    const bare = value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
        .replace(/^doi:/, '');
    return bare.startsWith('10.') ? bare : null;
}
