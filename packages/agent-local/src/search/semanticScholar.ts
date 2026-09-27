/**
 * Semantic Scholar paper search.
 *
 * Structurally parallel to the OpenAlex client: same `fetchJson` retry
 * behaviour, same shared-result mapping, its own `HostGate`.
 */

import { fetchJson, HostGate } from './httpJson';
import { normalizeDoi, type ScholarlyResult, type ScholarlySearchQuery, type ScholarlySource } from './types';

const S2_SEARCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

/** The API returns only `paperId` and `title` unless every field is named explicitly. */
const FIELDS = [
    'paperId',
    'url',
    'title',
    'abstract',
    'venue',
    'year',
    'publicationDate',
    'citationCount',
    'externalIds',
    'openAccessPdf',
    'authors.name',
].join(',');

export const SEMANTIC_SCHOLAR_MIN_INTERVAL_MS = 1_100;

/**
 * Paces requests to Semantic Scholar. Its shared keyless pool is strict — an
 * app with no API key is documented around 1 request/second and 429s often
 * under any concurrent use — so this stays just over that, deliberately more
 * conservative than OpenAlex's gate. Module-level so pacing holds across
 * catalog rebuilds within one process, not just within one search.
 */
export const semanticScholarGate = new HostGate(SEMANTIC_SCHOLAR_MIN_INTERVAL_MS);

interface SemanticScholarAuthor {
    name?: string | null;
}

interface SemanticScholarExternalIds {
    DOI?: string | null;
}

interface SemanticScholarOpenAccessPdf {
    url?: string | null;
}

interface SemanticScholarPaper {
    paperId?: string | null;
    url?: string | null;
    title?: string | null;
    abstract?: string | null;
    venue?: string | null;
    year?: number | null;
    publicationDate?: string | null;
    citationCount?: number | null;
    externalIds?: SemanticScholarExternalIds | null;
    openAccessPdf?: SemanticScholarOpenAccessPdf | null;
    authors?: SemanticScholarAuthor[] | null;
}

interface SemanticScholarSearchResponse {
    total?: number;
    data?: SemanticScholarPaper[] | null;
}

/** Maps one paper to the shared result shape, or null when it has nothing worth showing. */
function mapPaper(paper: SemanticScholarPaper): ScholarlyResult | null {
    const title = typeof paper.title === 'string' ? paper.title.trim() : '';
    const id = typeof paper.paperId === 'string' ? paper.paperId : '';
    if (!title || !id) return null;

    const authors = (paper.authors ?? [])
        .map((author) => author.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

    // S2's own field is a direct PDF link; the same value covers both.
    const pdfUrl = paper.openAccessPdf?.url ?? null;

    return {
        source: 'semantic_scholar',
        id,
        title,
        authors,
        year: typeof paper.year === 'number' ? paper.year : null,
        venue: typeof paper.venue === 'string' && paper.venue.length > 0 ? paper.venue : null,
        doi: normalizeDoi(paper.externalIds?.DOI),
        url: typeof paper.url === 'string' ? paper.url : null,
        abstract: typeof paper.abstract === 'string' && paper.abstract.length > 0 ? paper.abstract : null,
        citationCount: typeof paper.citationCount === 'number' ? paper.citationCount : null,
        openAccessUrl: pdfUrl,
        pdfUrl,
        isOpenAccess: pdfUrl !== null,
        publicationDate: typeof paper.publicationDate === 'string' ? paper.publicationDate : null,
    };
}

/** `2020-2024`, `2020-` for an open-ended start, `-2024` for an open-ended end, or null. */
function buildYearRange(yearFrom?: number, yearTo?: number): string | null {
    if (yearFrom && yearTo) return `${yearFrom}-${yearTo}`;
    if (yearFrom) return `${yearFrom}-`;
    if (yearTo) return `-${yearTo}`;
    return null;
}

function buildUrl(query: ScholarlySearchQuery): string {
    const params = new URLSearchParams();
    params.set('query', query.query);
    params.set('limit', String(query.limit));
    params.set('fields', FIELDS);

    const yearRange = buildYearRange(query.yearFrom, query.yearTo);
    if (yearRange) params.set('year', yearRange);

    return `${S2_SEARCH_URL}?${params.toString()}`;
}

export function createSemanticScholarSource(options: { apiKey?: string } = {}): ScholarlySource {
    const { apiKey } = options;

    return {
        // Human-readable: this is what a merge failure note names to the model.
        name: 'Semantic Scholar',
        async search(query, signal) {
            await semanticScholarGate.wait(signal);

            const headers: Record<string, string> = {};
            if (apiKey) headers['x-api-key'] = apiKey;

            const result = await fetchJson<SemanticScholarSearchResponse>({
                url: buildUrl(query),
                headers,
                signal,
            });

            if (!result.ok) {
                if (result.status === 429) {
                    return {
                        ok: false,
                        error: apiKey
                            ? 'Semantic Scholar rate limit reached. Try again shortly.'
                            : 'Semantic Scholar rate limit reached — the shared, keyless pool is busy. Add a free Semantic Scholar API key in Beaver preferences for a dedicated limit.',
                    };
                }
                return { ok: false, error: `Semantic Scholar request failed: ${result.error}` };
            }

            const papers = result.data.data ?? [];
            const results = papers.map(mapPaper).filter((paper): paper is ScholarlyResult => paper !== null);
            return { ok: true, results };
        },
    };
}
