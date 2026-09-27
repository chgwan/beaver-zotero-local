import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

const signal = () => new AbortController().signal;

/** A trimmed, real-shaped Semantic Scholar paper/search response: one full record, one malformed. */
const fixture = {
    total: 2,
    data: [
        {
            paperId: 'abc123',
            url: 'https://www.semanticscholar.org/paper/abc123',
            title: 'Neural networks for text classification',
            abstract: 'We study neural networks for text classification tasks.',
            venue: 'ACL',
            year: 2021,
            publicationDate: '2021-06-01',
            citationCount: 17,
            externalIds: { DOI: '10.1002/example2' },
            openAccessPdf: { url: 'https://example.org/oa/abc123.pdf' },
            authors: [{ name: 'Alice Wong' }, { name: 'Bob Lee' }],
        },
        // Deliberately malformed: no paperId, no title.
        { paperId: null, title: null, year: 2018 },
    ],
};

// Every test loads a fresh module instance so the module-level HostGate
// starts unclamped (see search/httpJson.ts) and never adds a real delay.
async function loadModule() {
    vi.resetModules();
    return import('@beaver/agent-local/search/semanticScholar');
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.resetModules());

describe('createSemanticScholarSource', () => {
    it('builds the paper search endpoint with query, limit, and an explicit fields list', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { total: 0, data: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createSemanticScholarSource } = await loadModule();

        await createSemanticScholarSource().search({ query: 'graph neural networks', limit: 8 }, signal());

        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://api.semanticscholar.org/graph/v1/paper/search');
        expect(url.searchParams.get('query')).toBe('graph neural networks');
        expect(url.searchParams.get('limit')).toBe('8');
        const fields = url.searchParams.get('fields') ?? '';
        expect(fields).toContain('title');
        expect(fields).toContain('externalIds');
        expect(fields).toContain('openAccessPdf');
        expect(fields).toContain('authors');
    });

    it('sends x-api-key when a key is configured, no auth header at all when it is not', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { total: 0, data: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createSemanticScholarSource } = await loadModule();

        await createSemanticScholarSource({ apiKey: 'secret-key' }).search({ query: 'x', limit: 1 }, signal());
        expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('secret-key');

        fetchMock.mockClear();
        // Fresh module instance so the second call does not pay the real
        // HostGate interval left behind by the first (fetch stays stubbed).
        const second = await loadModule();
        await second.createSemanticScholarSource().search({ query: 'x', limit: 1 }, signal());
        expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBeUndefined();
    });

    it('maps a paper to a ScholarlyResult', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, fixture)));
        const { createSemanticScholarSource } = await loadModule();

        const outcome = await createSemanticScholarSource().search({ query: 'x', limit: 5 }, signal());

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const [result] = outcome.results;
        expect(result.source).toBe('semantic_scholar');
        expect(result.id).toBe('abc123');
        expect(result.title).toBe('Neural networks for text classification');
        expect(result.authors).toEqual(['Alice Wong', 'Bob Lee']);
        expect(result.year).toBe(2021);
        expect(result.venue).toBe('ACL');
        expect(result.doi).toBe('10.1002/example2');
        expect(result.citationCount).toBe(17);
        expect(result.openAccessUrl).toBe('https://example.org/oa/abc123.pdf');
    });

    it('adds a year range, and an open-ended range when only a start year is given', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, { total: 0, data: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const { createSemanticScholarSource } = await loadModule();

        await createSemanticScholarSource().search({ query: 'x', limit: 1, yearFrom: 2020, yearTo: 2024 }, signal());
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('year')).toBe('2020-2024');

        fetchMock.mockClear();
        // Fresh module instance so the second call does not pay the real
        // HostGate interval left behind by the first (fetch stays stubbed).
        const second = await loadModule();
        await second.createSemanticScholarSource().search({ query: 'x', limit: 1, yearFrom: 2020 }, signal());
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('year')).toBe('2020-');
    });

    it('reports the rate limit in the error when a 429 survives retries', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(429, {})));
        const { createSemanticScholarSource } = await loadModule();

        const outcome = await createSemanticScholarSource().search({ query: 'x', limit: 5 }, signal());
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error.toLowerCase()).toContain('rate limit');
    });

    it('treats an empty data array as a successful empty result', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { total: 0, data: [] })));
        const { createSemanticScholarSource } = await loadModule();

        const outcome = await createSemanticScholarSource().search({ query: 'x', limit: 5 }, signal());
        expect(outcome).toEqual({ ok: true, results: [] });
    });

    it('skips a malformed paper instead of failing the whole search', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, fixture)));
        const { createSemanticScholarSource } = await loadModule();

        const outcome = await createSemanticScholarSource().search({ query: 'x', limit: 5 }, signal());
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0].id).toBe('abc123');
    });
});
