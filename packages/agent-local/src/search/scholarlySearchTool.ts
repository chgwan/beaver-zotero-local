/**
 * `scholarly_search`: the model's view of the published literature.
 *
 * It is deliberately separate from the library tools. The model must be able
 * to tell "what the user has" from "what exists", so the description says so
 * plainly: a model that confuses them cites papers the user does not own as
 * though they were in the library.
 *
 * The tool queries public databases and takes no library scope. Its query is
 * the model's string alone; nothing from the user's libraries is added to it.
 *
 * A result has two forms. The model gets compact numbered lines, since every
 * character is re-sent on each later round. The card gets the
 * external-reference shape (`content.references` plus
 * `metadata.supplemental_data`), which renders DOI and open-access links and
 * the local "already in library" check.
 */

import type {
    ExternalReferenceResultContent,
    ExternalReferenceResultSupplement,
} from '@beaver/agent-core/run-state/toolResultTypes';
import type { NativeTool, ToolExecutionResult } from '../tools/toolCatalog';
import type { ToolArgs, ToolSpec } from '../tools/toolSchemas';
import { DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT, runScholarlySearch } from './scholarlySearch';
import type { ScholarlyResult, ScholarlySearchQuery, ScholarlySource, SourceFailureKind } from './types';

/**
 * Failure kinds a retry cannot fix: the user is missing a key, a keyless
 * daily budget is spent, or a source's own retries already gave up on a rate
 * limit. Re-calling the tool would just burn another round for the same
 * outcome, so these are reported as non-retryable with guidance instead.
 */
const NON_RETRYABLE_FAILURE_KINDS = new Set<SourceFailureKind>(['auth', 'budget', 'rate_limit']);

/** Abstract length in the model's text; enough to judge relevance. */
const TEXT_ABSTRACT_CHARS = 200;
/** Abstract length kept for the card; the thread history replays it. */
const CARD_ABSTRACT_CHARS = 500;
/** Authors named in the model's text before "et al.". */
const TEXT_AUTHORS = 3;
/** Authors in the card row; the full list travels in the supplement. */
const CARD_AUTHORS = 5;

export const SCHOLARLY_SEARCH_SPEC: ToolSpec = {
    name: 'scholarly_search',
    description:
        'Search published academic literature (OpenAlex and Semantic Scholar) for work that is ' +
        'not necessarily in the user’s Zotero library. Use zotero_search for what the user ' +
        'already has. Results are ranked by citation count.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                minLength: 1,
                description: 'Search terms, e.g. a topic, title words, or an author name.',
            },
            limit: {
                type: 'integer',
                minimum: 1,
                description: `Maximum results to return (default ${DEFAULT_RESULT_LIMIT}, at most ${MAX_RESULT_LIMIT}).`,
            },
            year_from: { type: 'integer', description: 'Earliest publication year.' },
            year_to: { type: 'integer', description: 'Latest publication year.' },
        },
        required: ['query'],
        additionalProperties: false,
    },
};

const truncate = (text: string, max: number): string => {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
};

/** Drop undefined fields so the stored card data carries no empty keys. */
const compact = <T extends object>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

function toReference(result: ScholarlyResult): ExternalReferenceResultContent {
    return compact({
        external_id: result.id,
        title: result.title,
        authors: result.authors.length > 0 ? result.authors.slice(0, CARD_AUTHORS) : undefined,
        year: orUndefined(result.year),
        venue: orUndefined(result.venue),
        abstract: result.abstract ? truncate(result.abstract, CARD_ABSTRACT_CHARS) : undefined,
        citation_count: orUndefined(result.citationCount),
        rank: result.rank,
    });
}

function toSupplement(result: ScholarlyResult): ExternalReferenceResultSupplement {
    return compact({
        external_id: result.id,
        source: result.source,
        url: orUndefined(result.url),
        publication_date: orUndefined(result.publicationDate),
        identifiers: result.doi ? { doi: result.doi } : undefined,
        is_open_access: orUndefined(result.isOpenAccess),
        open_access_url: orUndefined(result.openAccessUrl ?? result.pdfUrl),
        authors: result.authors.length > CARD_AUTHORS ? result.authors : undefined,
    });
}

/** One numbered entry: title, authors, year, venue, identifier, citations, abstract excerpt. */
function formatEntry(result: ScholarlyResult, position: number): string {
    const parts = [`${position}. ${result.title}.`];
    if (result.authors.length > 0) {
        const named = result.authors.slice(0, TEXT_AUTHORS).join(', ');
        parts.push(result.authors.length > TEXT_AUTHORS ? `${named}, et al.` : `${named}.`);
    }
    if (result.year !== null) parts.push(`(${result.year}).`);
    if (result.venue) parts.push(`${result.venue}.`);
    if (result.doi) parts.push(`DOI: ${result.doi}.`);
    else if (result.url) parts.push(`URL: ${result.url}.`);
    if (result.citationCount !== null) parts.push(`Cited by ${result.citationCount}.`);

    const line = parts.join(' ');
    return result.abstract ? `${line}\n   ${truncate(result.abstract, TEXT_ABSTRACT_CHARS)}` : line;
}

function formatText(query: string, results: ScholarlyResult[], notes: string[]): string {
    const lines =
        results.length === 0
            ? [`No results found for "${query}".`]
            : [
                  `Found ${results.length} works for "${query}" (published literature; not necessarily in the user’s library):`,
                  ...results.map((result, index) => formatEntry(result, index + 1)),
              ];
    if (notes.length > 0) lines.push(`Notes: ${notes.join('; ')}`);
    return lines.join('\n');
}

/** A catalog tool that searches the given sources. */
export function createScholarlySearchTool(options: { sources: ScholarlySource[] }): NativeTool {
    const { sources } = options;
    return {
        spec: SCHOLARLY_SEARCH_SPEC,

        async run(args: ToolArgs, signal: AbortSignal): Promise<ToolExecutionResult> {
            const query = String(args.query).trim();
            const yearFrom = typeof args.year_from === 'number' ? args.year_from : undefined;
            const yearTo = typeof args.year_to === 'number' ? args.year_to : undefined;
            if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
                return { ok: false, retryable: true, error: 'year_from must not be later than year_to.' };
            }

            // An oversized limit is clamped rather than refused: the model's
            // intent ("many results") is clear and the cap is ours.
            const requested = typeof args.limit === 'number' ? args.limit : DEFAULT_RESULT_LIMIT;
            const limit = Math.min(requested, MAX_RESULT_LIMIT);

            const searchQuery: ScholarlySearchQuery = {
                query,
                limit,
                ...(yearFrom !== undefined ? { yearFrom } : {}),
                ...(yearTo !== undefined ? { yearTo } : {}),
            };
            const { results, totalFound, notes, failureKinds } = await runScholarlySearch(
                searchQuery,
                { sources, limit },
                signal
            );

            // Every source failing is a broken tool, not an empty literature. But
            // when every failure is one only preferences can fix (a missing key, an
            // exhausted keyless budget, or a rate limit already past its own
            // retries), re-calling the tool cannot succeed — tell the model so it
            // stops spending rounds on it.
            if (results.length === 0 && sources.length > 0 && failureKinds.length >= sources.length) {
                const retryable = !failureKinds.every((kind) => NON_RETRYABLE_FAILURE_KINDS.has(kind));
                const error = retryable
                    ? `Literature search failed. ${notes.join('; ')}`
                    : `Literature search is unavailable until the user configures it: ${notes.join('; ')}`;
                return { ok: false, retryable, error };
            }

            return {
                ok: true,
                content: { references: results.map(toReference), notes, total_found: totalFound },
                text: formatText(query, results, notes),
                metadata: { supplemental_data: results.map(toSupplement) },
            };
        },
    };
}
