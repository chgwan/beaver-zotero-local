import { describe, it, expect, vi } from 'vitest';
import {
    createScholarlySearchTool,
    SCHOLARLY_SEARCH_SPEC,
} from '@beaver/agent-local/search/scholarlySearchTool';
import { MAX_RESULT_LIMIT } from '@beaver/agent-local/search/scholarlySearch';
import type { ScholarlyResult, ScholarlySource, SourceOutcome } from '@beaver/agent-local/search/types';
import { validateArgs } from '@beaver/agent-local/tools/argValidation';
import {
    extractExternalSearchData,
    isExternalSearchResult,
} from '@beaver/agent-core/run-state/toolResultTypes';

const signal = () => new AbortController().signal;

function result(overrides: Partial<ScholarlyResult> = {}): ScholarlyResult {
    return {
        source: 'openalex',
        id: 'W1',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
        year: 2017,
        venue: 'NeurIPS',
        doi: '10.5555/3295222.3295349',
        url: 'https://openalex.org/W1',
        abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
        citationCount: 1000,
        openAccessUrl: 'https://arxiv.org/abs/1706.03762',
        pdfUrl: null,
        isOpenAccess: true,
        publicationDate: '2017-06-12',
        ...overrides,
    };
}

/** A source that records what it was asked and answers with `outcome`. */
function recordingSource(name: string, outcome: SourceOutcome) {
    const search = vi.fn(async () => outcome);
    const source: ScholarlySource = { name, search };
    return { source, search };
}

const okSource = (name: string, results: ScholarlyResult[]) => recordingSource(name, { ok: true, results });

async function runOk(tool: ReturnType<typeof createScholarlySearchTool>, args: Record<string, unknown>) {
    const outcome = await tool.run(args, signal());
    if (!outcome.ok) throw new Error(`expected success, got: ${outcome.error}`);
    return outcome;
}

describe('SCHOLARLY_SEARCH_SPEC', () => {
    it('is a closed schema that requires a query', () => {
        expect(SCHOLARLY_SEARCH_SPEC.name).toBe('scholarly_search');
        expect(SCHOLARLY_SEARCH_SPEC.parameters.additionalProperties).toBe(false);
        expect(SCHOLARLY_SEARCH_SPEC.parameters.required).toEqual(['query']);
        expect(validateArgs({}, SCHOLARLY_SEARCH_SPEC.parameters)).toMatch(/query/);
        expect(validateArgs({ query: 'x', unknown: 1 }, SCHOLARLY_SEARCH_SPEC.parameters)).not.toBeNull();
    });

    it('tells the model this is outside the library and names the library tool', () => {
        expect(SCHOLARLY_SEARCH_SPEC.description).toMatch(/not necessarily in the user/i);
        expect(SCHOLARLY_SEARCH_SPEC.description).toMatch(/zotero_search/);
    });

    it('accepts a limit above the result cap so it can be clamped, not rejected', () => {
        expect(validateArgs({ query: 'x', limit: MAX_RESULT_LIMIT + 50 }, SCHOLARLY_SEARCH_SPEC.parameters)).toBeNull();
        expect(validateArgs({ query: 'x', limit: 0 }, SCHOLARLY_SEARCH_SPEC.parameters)).not.toBeNull();
    });
});

describe('createScholarlySearchTool', () => {
    it('exposes the spec it runs under', () => {
        const tool = createScholarlySearchTool({ sources: [] });
        expect(tool.spec).toBe(SCHOLARLY_SEARCH_SPEC);
    });

    it('sends only the model query and year bounds to every source', async () => {
        const a = okSource('OpenAlex', []);
        const b = okSource('Semantic Scholar', []);
        const tool = createScholarlySearchTool({ sources: [a.source, b.source] });

        await tool.run({ query: '  transformer models ', year_from: 2015, year_to: 2020 }, signal());

        for (const { search } of [a, b]) {
            expect(search).toHaveBeenCalledTimes(1);
            expect(search.mock.calls[0][0]).toEqual({
                query: 'transformer models',
                limit: 10,
                yearFrom: 2015,
                yearTo: 2020,
            });
        }
    });

    it('clamps a limit above the cap instead of rejecting it', async () => {
        const many = Array.from({ length: MAX_RESULT_LIMIT + 10 }, (_, i) =>
            result({ id: `W${i}`, doi: `10.1/${i}`, title: `Paper ${i}` })
        );
        const a = okSource('OpenAlex', many);
        const tool = createScholarlySearchTool({ sources: [a.source] });

        const outcome = await runOk(tool, { query: 'x', limit: MAX_RESULT_LIMIT + 100 });

        expect(a.search.mock.calls[0][0].limit).toBe(MAX_RESULT_LIMIT);
        expect((outcome.content.references as unknown[]).length).toBe(MAX_RESULT_LIMIT);
    });

    it('returns compact numbered text with title, authors, year, venue, DOI and citations', async () => {
        const tool = createScholarlySearchTool({
            sources: [
                okSource('OpenAlex', [
                    result(),
                    result({
                        id: 'W2',
                        title: 'Second Paper',
                        authors: ['Ada Lovelace'],
                        year: 1843,
                        doi: null,
                        venue: null,
                        citationCount: 5,
                        url: 'https://openalex.org/W2',
                    }),
                ]).source,
            ],
        });

        const { text } = await runOk(tool, { query: 'attention' });

        expect(text).toMatch(/^Found 2 works for "attention"/);
        expect(text).toMatch(/not necessarily in the user/i);
        expect(text).toContain('1. Attention Is All You Need');
        expect(text).toContain('Ashish Vaswani, Noam Shazeer, Niki Parmar, et al.');
        expect(text).toContain('(2017)');
        expect(text).toContain('NeurIPS');
        expect(text).toContain('DOI: 10.5555/3295222.3295349');
        expect(text).toContain('Cited by 1000');
        expect(text).toContain('2. Second Paper');
        expect(text).toContain('Ada Lovelace');
        // No DOI: the source link identifies the work instead.
        expect(text).toContain('https://openalex.org/W2');
        expect(text).not.toMatch(/^\s*[{[]/);
    });

    it('truncates long abstracts in the model text', async () => {
        const abstract = 'word '.repeat(400);
        const tool = createScholarlySearchTool({ sources: [okSource('OpenAlex', [result({ abstract })]).source] });

        const { text } = await runOk(tool, { query: 'x' });

        expect(text.length).toBeLessThan(abstract.length);
        expect(text).toContain('…');
    });

    it('passes partial-failure notes on to the model and the card content', async () => {
        const tool = createScholarlySearchTool({
            sources: [
                recordingSource('OpenAlex', { ok: false, error: 'rate limited (HTTP 429)' }).source,
                okSource('Semantic Scholar', [result({ source: 'semantic_scholar', id: 'abc' })]).source,
            ],
        });

        const outcome = await runOk(tool, { query: 'x' });

        expect(outcome.text).toContain('OpenAlex: rate limited (HTTP 429)');
        expect(outcome.content.notes).toEqual(['OpenAlex: rate limited (HTTP 429)']);
        expect((outcome.content.references as unknown[]).length).toBe(1);
    });

    it('reports "no results" as a success the model can tell apart from a failure', async () => {
        const tool = createScholarlySearchTool({ sources: [okSource('OpenAlex', []).source] });

        const outcome = await runOk(tool, { query: 'quantum basket weaving' });

        expect(outcome.text).toMatch(/^No results found for "quantum basket weaving"/);
        expect(outcome.content).toEqual({ references: [], notes: [], total_found: 0 });
        expect(isExternalSearchResult('scholarly_search', outcome.content, outcome.metadata)).toBe(true);
        expect(extractExternalSearchData(outcome.content, outcome.metadata)?.references).toEqual([]);
    });

    it('fails, retryably, when every source failed with a transient error', async () => {
        const tool = createScholarlySearchTool({
            sources: [
                recordingSource('OpenAlex', { ok: false, error: 'network error' }).source,
                recordingSource('Semantic Scholar', { ok: false, error: 'HTTP 500' }).source,
            ],
        });

        const outcome = await tool.run({ query: 'x' }, signal());

        expect(outcome).toMatchObject({ ok: false, retryable: true });
        if (outcome.ok) return;
        expect(outcome.error).toContain('OpenAlex: network error');
        expect(outcome.error).toContain('Semantic Scholar: HTTP 500');
    });

    it('fails, non-retryably, when every source failed for a reason only preferences can fix', async () => {
        const tool = createScholarlySearchTool({
            sources: [
                recordingSource('OpenAlex', {
                    ok: false,
                    kind: 'budget',
                    error: 'OpenAlex rate limit reached — the keyless daily budget may be exhausted. Add a free OpenAlex API key in Beaver preferences for a higher limit.',
                }).source,
                recordingSource('Semantic Scholar', {
                    ok: false,
                    kind: 'rate_limit',
                    error: 'Semantic Scholar rate limit reached — the shared, keyless pool is busy. Add a free Semantic Scholar API key in Beaver preferences for a dedicated limit.',
                }).source,
            ],
        });

        const outcome = await tool.run({ query: 'x' }, signal());

        expect(outcome).toMatchObject({ ok: false, retryable: false });
        if (outcome.ok) return;
        expect(outcome.error).toContain('OpenAlex');
        expect(outcome.error).toContain('Semantic Scholar');
        expect(outcome.error).toMatch(/preferences/i);
    });

    it('stays retryable when only some of the failures are config-fixable', async () => {
        const tool = createScholarlySearchTool({
            sources: [
                recordingSource('OpenAlex', { ok: false, kind: 'auth', error: 'needs a key' }).source,
                recordingSource('Semantic Scholar', { ok: false, kind: 'server', error: 'HTTP 500' }).source,
            ],
        });

        const outcome = await tool.run({ query: 'x' }, signal());

        expect(outcome).toMatchObject({ ok: false, retryable: true });
    });

    it('reports total_found as the true merged count, not the post-limit count', async () => {
        const many = Array.from({ length: MAX_RESULT_LIMIT + 10 }, (_, i) =>
            result({ id: `W${i}`, doi: `10.1/${i}`, title: `Paper ${i}` })
        );
        const tool = createScholarlySearchTool({ sources: [okSource('OpenAlex', many).source] });

        const outcome = await runOk(tool, { query: 'x', limit: MAX_RESULT_LIMIT + 100 });

        expect((outcome.content.references as unknown[]).length).toBe(MAX_RESULT_LIMIT);
        expect(outcome.content.total_found).toBe(MAX_RESULT_LIMIT + 10);
    });

    it('rejects a year range that ends before it starts, without searching', async () => {
        const a = okSource('OpenAlex', []);
        const tool = createScholarlySearchTool({ sources: [a.source] });

        const outcome = await tool.run({ query: 'x', year_from: 2020, year_to: 2010 }, signal());

        expect(outcome).toMatchObject({ ok: false, retryable: true });
        expect(a.search).not.toHaveBeenCalled();
    });

    it('emits content and metadata the external-reference card renders', async () => {
        const tool = createScholarlySearchTool({ sources: [okSource('OpenAlex', [result()]).source] });

        const outcome = await runOk(tool, { query: 'x' });

        expect(outcome.content.references).toEqual([
            {
                external_id: 'W1',
                title: 'Attention Is All You Need',
                authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
                year: 2017,
                venue: 'NeurIPS',
                abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
                citation_count: 1000,
                rank: 1,
            },
        ]);
        expect(isExternalSearchResult('scholarly_search', outcome.content, outcome.metadata)).toBe(true);

        const [reference] = extractExternalSearchData(outcome.content, outcome.metadata)!.references;
        expect(reference).toMatchObject({
            source_id: 'W1',
            source: 'openalex',
            title: 'Attention Is All You Need',
            year: 2017,
            url: 'https://openalex.org/W1',
            publication_date: '2017-06-12',
            identifiers: { doi: '10.5555/3295222.3295349' },
            is_open_access: true,
            open_access_url: 'https://arxiv.org/abs/1706.03762',
            library_items: [],
        });
    });

    it('omits absent fields rather than sending nulls to the card', async () => {
        const bare = result({
            source: 'semantic_scholar',
            id: 'abc',
            authors: [],
            year: null,
            venue: null,
            doi: null,
            url: null,
            abstract: null,
            citationCount: null,
            openAccessUrl: null,
            pdfUrl: 'https://example.org/paper.pdf',
            isOpenAccess: null,
            publicationDate: null,
        });
        const tool = createScholarlySearchTool({ sources: [okSource('Semantic Scholar', [bare]).source] });

        const outcome = await runOk(tool, { query: 'x' });

        expect(outcome.content.references).toEqual([{ external_id: 'abc', title: bare.title, rank: 1 }]);
        expect(outcome.metadata).toEqual({
            supplemental_data: [
                { external_id: 'abc', source: 'semantic_scholar', open_access_url: 'https://example.org/paper.pdf' },
            ],
        });
    });
});
