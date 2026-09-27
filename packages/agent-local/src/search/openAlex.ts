/**
 * OpenAlex works search.
 *
 * OpenAlex retired its `mailto` polite pool; access is keyless with a small
 * daily credit budget, or via a free API key for a higher one. Both a spent
 * budget and more than 100 requests/second return 429.
 */

import { fetchJson, HostGate } from './httpJson';
import { normalizeDoi, type ScholarlyResult, type ScholarlySearchQuery, type ScholarlySource } from './types';

const OPENALEX_WORKS_URL = 'https://api.openalex.org/works';

/** Only what the mapping below reads; OpenAlex works carry far more. */
const SELECT_FIELDS = [
    'id',
    'doi',
    'title',
    'publication_year',
    'publication_date',
    'authorships',
    'primary_location',
    'best_oa_location',
    'open_access',
    'cited_by_count',
    'abstract_inverted_index',
].join(',');

export const OPENALEX_MIN_INTERVAL_MS = 100;

/**
 * Paces requests to OpenAlex. The documented ceiling is 100 requests/second;
 * this stays two orders of magnitude under it — local mode makes a handful of
 * requests per run, not a stream, so this exists to be a good citizen rather
 * than to dodge a real limit. Module-level so it persists across catalog
 * rebuilds within one process, not just within one search.
 */
export const openAlexGate = new HostGate(OPENALEX_MIN_INTERVAL_MS);

interface OpenAlexAuthorship {
    author?: { display_name?: string | null } | null;
}

interface OpenAlexLocation {
    source?: { display_name?: string | null } | null;
    pdf_url?: string | null;
    landing_page_url?: string | null;
}

interface OpenAlexOpenAccess {
    is_oa?: boolean | null;
    oa_url?: string | null;
}

interface OpenAlexWork {
    id?: string | null;
    doi?: string | null;
    title?: string | null;
    publication_year?: number | null;
    publication_date?: string | null;
    authorships?: OpenAlexAuthorship[] | null;
    primary_location?: OpenAlexLocation | null;
    best_oa_location?: OpenAlexLocation | null;
    open_access?: OpenAlexOpenAccess | null;
    cited_by_count?: number | null;
    abstract_inverted_index?: Record<string, number[]> | null;
}

interface OpenAlexWorksResponse {
    results?: OpenAlexWork[] | null;
}

/** OpenAlex ids are full URLs (`https://openalex.org/W…`); the trailing segment is the short form used elsewhere. */
function shortOpenAlexId(fullId: string): string {
    const segment = fullId.split('/').pop();
    return segment && segment.length > 0 ? segment : fullId;
}

/**
 * Rebuild an abstract from OpenAlex's inverted index.
 *
 * OpenAlex publishes abstracts as a token → positions map rather than text.
 * Without this the model gets titles with no content and answers worse.
 */
function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | null {
    if (!index) return null;
    const words: string[] = [];
    for (const [word, positions] of Object.entries(index)) {
        for (const position of positions) words[position] = word;
    }
    const text = words.filter((word) => word !== undefined).join(' ').trim();
    return text.length > 0 ? text : null;
}

/** Maps one work to the shared result shape, or null when it has nothing worth showing. */
function mapWork(work: OpenAlexWork): ScholarlyResult | null {
    const title = typeof work.title === 'string' ? work.title.trim() : '';
    if (!title) return null;

    const authors = (work.authorships ?? [])
        .map((authorship) => authorship.author?.display_name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

    const rawId = typeof work.id === 'string' ? work.id : '';

    return {
        source: 'openalex',
        id: shortOpenAlexId(rawId),
        title,
        authors,
        year: typeof work.publication_year === 'number' ? work.publication_year : null,
        venue: work.primary_location?.source?.display_name ?? null,
        doi: normalizeDoi(work.doi),
        url: rawId || null,
        abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
        citationCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : null,
        openAccessUrl: work.open_access?.oa_url ?? null,
        pdfUrl: work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url ?? null,
        isOpenAccess: typeof work.open_access?.is_oa === 'boolean' ? work.open_access.is_oa : null,
        publicationDate: typeof work.publication_date === 'string' ? work.publication_date : null,
    };
}

function buildUrl(query: ScholarlySearchQuery): string {
    const params = new URLSearchParams();
    params.set('search', query.query);
    params.set('per-page', String(query.limit));
    params.set('select', SELECT_FIELDS);

    const from = query.yearFrom ? `from_publication_date:${query.yearFrom}-01-01` : null;
    const to = query.yearTo ? `to_publication_date:${query.yearTo}-12-31` : null;
    const filter = [from, to].filter((part): part is string => part !== null).join(',');
    if (filter) params.set('filter', filter);

    return `${OPENALEX_WORKS_URL}?${params.toString()}`;
}

export function createOpenAlexSource(options: { apiKey?: string } = {}): ScholarlySource {
    const { apiKey } = options;

    return {
        name: 'openalex',
        async search(query, signal) {
            await openAlexGate.wait(signal);

            const headers: Record<string, string> = {};
            // Kept out of the URL (and therefore logs) by sending it as a header.
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

            const result = await fetchJson<OpenAlexWorksResponse>({ url: buildUrl(query), headers, signal });

            if (!result.ok) {
                if (result.status === 429) {
                    return {
                        ok: false,
                        error: apiKey
                            ? 'OpenAlex rate limit reached. Try again shortly.'
                            : 'OpenAlex rate limit reached — the keyless daily budget may be exhausted. Add a free OpenAlex API key in Beaver preferences for a higher limit.',
                    };
                }
                return { ok: false, error: `OpenAlex request failed: ${result.error}` };
            }

            const works = result.data.results ?? [];
            const results = works.map(mapWork).filter((work): work is ScholarlyResult => work !== null);
            return { ok: true, results };
        },
    };
}
