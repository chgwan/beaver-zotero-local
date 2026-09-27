import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { normalizeDoi } from '@beaver/agent-local/search/types';

const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

const signal = () => new AbortController().signal;

/** A trimmed, real-shaped OpenAlex works response: one full record, one malformed. */
const fixture = {
    results: [
        {
            id: 'https://openalex.org/W2741809807',
            doi: 'https://doi.org/10.1001/example',
            title: 'Attention and memory in reading',
            publication_year: 2019,
            publication_date: '2019-05-01',
            authorships: [
                { author: { display_name: 'Jane Smith' } },
                { author: { display_name: 'Wei Chen' } },
            ],
            primary_location: {
                source: { display_name: 'Journal of Cognitive Science' },
                landing_page_url: 'https://example.org/paper1',
            },
            open_access: { is_oa: true, oa_url: 'https://example.org/oa/paper1.pdf' },
            best_oa_location: { pdf_url: 'https://example.org/oa/paper1.pdf' },
            cited_by_count: 42,
            abstract_inverted_index: {
                Reading: [0],
                requires: [1],
                attention: [2],
                and: [3],
                'memory.': [4],
            },
        },
        // Deliberately malformed: no authorships, no title.
        {
            id: 'https://openalex.org/W9999999999',
            doi: null,
            title: null,
            publication_year: 2020,
            cited_by_count: 3,
        },
    ],
};

// Every test loads a fresh module instance so the module-level HostGate
// starts unclamped (see search/httpJson.ts) and never adds a real delay.
async function loadModule() {
    vi.resetModules();
    return import('@beaver/agent-local/search/openAlex');
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.resetModules());

describe('createOpenAlexSource', () => {
    it('builds the works endpoint with search, per-page, and a select list', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createOpenAlexSource } = await loadModule();

        await createOpenAlexSource().search({ query: 'deep learning', limit: 5 }, signal());

        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://api.openalex.org/works');
        expect(url.searchParams.get('search')).toBe('deep learning');
        expect(url.searchParams.get('per-page')).toBe('5');
        const select = url.searchParams.get('select') ?? '';
        expect(select).toContain('title');
        expect(select).toContain('authorships');
        expect(select).toContain('abstract_inverted_index');
    });

    it('sends an Authorization header when an API key is configured, omits it when blank', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createOpenAlexSource } = await loadModule();

        await createOpenAlexSource({ apiKey: 'secret-key' }).search({ query: 'x', limit: 1 }, signal());
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-key');

        fetchMock.mockClear();
        // Fresh module instance so the second call does not pay the real
        // HostGate interval left behind by the first (fetch stays stubbed).
        const second = await loadModule();
        await second.createOpenAlexSource({ apiKey: '' }).search({ query: 'x', limit: 1 }, signal());
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    it('adds a publication-date filter when a year range is given', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createOpenAlexSource } = await loadModule();

        await createOpenAlexSource().search(
            { query: 'x', limit: 1, yearFrom: 2020, yearTo: 2024 },
            signal()
        );

        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.searchParams.get('filter')).toBe(
            'from_publication_date:2020-01-01,to_publication_date:2024-12-31'
        );
    });

    it('maps a work to a ScholarlyResult', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, fixture)));
        const { createOpenAlexSource } = await loadModule();

        const outcome = await createOpenAlexSource().search({ query: 'x', limit: 5 }, signal());

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const [result] = outcome.results;
        expect(result.source).toBe('openalex');
        expect(result.id).toBe('W2741809807');
        expect(result.title).toBe('Attention and memory in reading');
        expect(result.authors).toEqual(['Jane Smith', 'Wei Chen']);
        expect(result.year).toBe(2019);
        expect(result.venue).toBe('Journal of Cognitive Science');
        expect(result.doi).toBe('10.1001/example');
        expect(result.citationCount).toBe(42);
        expect(result.openAccessUrl).toBe('https://example.org/oa/paper1.pdf');
    });

    it('reconstructs the abstract from the inverted index', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, fixture)));
        const { createOpenAlexSource } = await loadModule();

        const outcome = await createOpenAlexSource().search({ query: 'x', limit: 5 }, signal());

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.results[0].abstract).toBe('Reading requires attention and memory.');
    });

    it('returns a failure rather than throwing on an HTTP error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(500, { error: 'boom' })));
        const { createOpenAlexSource } = await loadModule();

        const outcome = await createOpenAlexSource().search({ query: 'x', limit: 5 }, signal());
        expect(outcome.ok).toBe(false);
    });

    it('names the keyless daily budget on a 429 with no API key configured', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(429, {})));
        const { createOpenAlexSource } = await loadModule();

        const outcome = await createOpenAlexSource().search({ query: 'x', limit: 5 }, signal());
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.toLowerCase()).toContain('daily budget');
        expect(outcome.error.toLowerCase()).toContain('api key');
    });

    it('skips a malformed work instead of failing the whole search', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, fixture)));
        const { createOpenAlexSource } = await loadModule();

        const outcome = await createOpenAlexSource().search({ query: 'x', limit: 5 }, signal());

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0].id).toBe('W2741809807');
    });
});

describe('normalizeDoi', () => {
    it('reduces every DOI form to the same bare value', () => {
        expect(normalizeDoi('https://doi.org/10.1/x')).toBe('10.1/x');
        expect(normalizeDoi('doi:10.1/X')).toBe('10.1/x');
        expect(normalizeDoi('10.1/x')).toBe('10.1/x');
    });
});
