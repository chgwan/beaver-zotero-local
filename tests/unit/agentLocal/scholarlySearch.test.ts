import { describe, it, expect } from 'vitest';
import {
    runScholarlySearch,
    DEFAULT_RESULT_LIMIT,
    MAX_RESULT_LIMIT,
} from '@beaver/agent-local/search/scholarlySearch';
import type { ScholarlyResult, ScholarlySearchQuery, ScholarlySource, SourceOutcome } from '@beaver/agent-local/search/types';

const signal = () => new AbortController().signal;

const baseQuery: ScholarlySearchQuery = { query: 'attention mechanisms', limit: 10 };

function result(overrides: Partial<ScholarlyResult> = {}): ScholarlyResult {
    return {
        source: 'openalex',
        id: 'id-1',
        title: 'Example title',
        authors: [],
        year: 2020,
        venue: null,
        doi: null,
        url: null,
        abstract: null,
        citationCount: null,
        openAccessUrl: null,
        pdfUrl: null,
        isOpenAccess: null,
        publicationDate: null,
        ...overrides,
    };
}

function sourceReturning(name: string, outcome: SourceOutcome): ScholarlySource {
    return { name, search: async () => outcome };
}

describe('runScholarlySearch', () => {
    it('queries every source concurrently, not in series', async () => {
        let aStarted = false;
        let bStarted = false;
        const sourceA: ScholarlySource = {
            name: 'A',
            search: async () => {
                aStarted = true;
                // If sources ran in series, B would never start and this
                // would spin forever — a passing test proves concurrency.
                while (!bStarted) await Promise.resolve();
                return { ok: true, results: [result({ id: 'a1', title: 'Paper A' })] };
            },
        };
        const sourceB: ScholarlySource = {
            name: 'B',
            search: async () => {
                bStarted = true;
                while (!aStarted) await Promise.resolve();
                return { ok: true, results: [result({ id: 'b1', title: 'Paper B' })] };
            },
        };

        const outcome = await runScholarlySearch(baseQuery, { sources: [sourceA, sourceB] }, signal());
        expect(outcome.results.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    });

    it('merges results from both sources', async () => {
        const a = sourceReturning('A', { ok: true, results: [result({ id: 'a1', title: 'Paper A' })] });
        const b = sourceReturning('B', { ok: true, results: [result({ id: 'b1', title: 'Paper B' })] });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
        expect(outcome.notes).toEqual([]);
    });

    it('dedupes on normalised DOI across sources, keeping the richer abstract', async () => {
        const a = sourceReturning('OpenAlex', {
            ok: true,
            results: [
                result({
                    source: 'openalex',
                    id: 'a1',
                    doi: 'https://doi.org/10.1/X',
                    abstract: 'short',
                    citationCount: 3,
                }),
            ],
        });
        const b = sourceReturning('Semantic Scholar', {
            ok: true,
            results: [
                result({
                    source: 'semantic_scholar',
                    id: 'b1',
                    doi: '10.1/x',
                    abstract: 'a much longer and richer abstract text than the other record',
                    citationCount: 3,
                }),
            ],
        });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0].id).toBe('b1');
        expect(outcome.results[0].abstract).toContain('much longer');
    });

    it('dedupes on normalised title + year when neither record has a DOI', async () => {
        const a = sourceReturning('OpenAlex', {
            ok: true,
            results: [result({ id: 'a1', title: 'Deep Learning for NLP!', year: 2021, abstract: 'brief' })],
        });
        const b = sourceReturning('Semantic Scholar', {
            ok: true,
            results: [
                result({
                    id: 'b1',
                    title: 'deep learning for nlp',
                    year: 2021,
                    abstract: 'a substantially longer description of the same work',
                }),
            ],
        });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0].id).toBe('b1');
    });

    it('does not merge two records with the same title but different years', async () => {
        const a = sourceReturning('OpenAlex', {
            ok: true,
            results: [result({ id: 'a1', title: 'Survey of Transformers', year: 2019 })],
        });
        const b = sourceReturning('Semantic Scholar', {
            ok: true,
            results: [result({ id: 'b1', title: 'Survey of Transformers', year: 2022 })],
        });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    });

    it('yields the other source\'s results plus a note when one source fails', async () => {
        const a = sourceReturning('OpenAlex', { ok: false, error: 'rate limited' });
        const b = sourceReturning('Semantic Scholar', { ok: true, results: [result({ id: 'b1' })] });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results.map((r) => r.id)).toEqual(['b1']);
        expect(outcome.notes).toHaveLength(1);
        expect(outcome.notes[0]).toContain('OpenAlex');
        expect(outcome.notes[0]).toContain('rate limited');
    });

    it('yields empty results and one note per source when every source fails', async () => {
        const a = sourceReturning('OpenAlex', { ok: false, error: 'down' });
        const b = sourceReturning('Semantic Scholar', { ok: false, error: 'down too' });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a, b] }, signal());

        expect(outcome.results).toEqual([]);
        expect(outcome.notes).toHaveLength(2);
    });

    it('sorts by citation count descending, with nulls last', async () => {
        const a = sourceReturning('OpenAlex', {
            ok: true,
            results: [
                result({ id: 'low', title: 'Low', citationCount: 5 }),
                result({ id: 'none', title: 'None', citationCount: null }),
                result({ id: 'high', title: 'High', citationCount: 20 }),
            ],
        });

        const outcome = await runScholarlySearch(baseQuery, { sources: [a] }, signal());

        expect(outcome.results.map((r) => r.id)).toEqual(['high', 'low', 'none']);
    });

    it('truncates to the requested limit, clamped to MAX_RESULT_LIMIT', async () => {
        const many = Array.from({ length: 30 }, (_, i) =>
            result({ id: `r${i}`, title: `Paper ${i}`, citationCount: i })
        );
        const a = sourceReturning('OpenAlex', { ok: true, results: many });

        const uncapped = await runScholarlySearch(baseQuery, { sources: [a], limit: 999 }, signal());
        expect(uncapped.results).toHaveLength(MAX_RESULT_LIMIT);
        expect(uncapped.results[0].rank).toBe(1);
        expect(uncapped.results[MAX_RESULT_LIMIT - 1].rank).toBe(MAX_RESULT_LIMIT);

        const defaulted = await runScholarlySearch(baseQuery, { sources: [a] }, signal());
        expect(defaulted.results).toHaveLength(DEFAULT_RESULT_LIMIT);
    });

    it('propagates the caller\'s abort signal to every source', async () => {
        const controller = new AbortController();
        let receivedSignal: AbortSignal | null = null;
        const a: ScholarlySource = {
            name: 'A',
            search: async (_query, signal) => {
                receivedSignal = signal;
                return { ok: true, results: [] };
            },
        };

        controller.abort();
        await runScholarlySearch(baseQuery, { sources: [a] }, controller.signal);

        expect(receivedSignal).toBe(controller.signal);
        expect(receivedSignal?.aborted).toBe(true);
    });
});
