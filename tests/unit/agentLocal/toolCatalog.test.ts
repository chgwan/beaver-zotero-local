import { describe, it, expect, vi } from 'vitest';
import { buildToolCatalog, READ_ONLY_TOOLS } from '@beaver/agent-local/tools/toolCatalog';
import { createScholarlySearchTool } from '@beaver/agent-local/search/scholarlySearchTool';
import {
    READ_ATTACHMENT_MAX_CHARS,
    READ_ATTACHMENT_MIN_CHARS,
    readAttachmentMaxChars,
} from '@beaver/agent-local/tools/toolSchemas';

const signal = new AbortController().signal;

type Handle = ReturnType<typeof vi.fn>;

/** A provider map with one entry per given request event. */
const providerWith = (entries: Record<string, Handle>, errorResponse?: Handle) =>
    Object.fromEntries(
        Object.entries(entries).map(([event, handle]) => [
            event,
            errorResponse ? { handle, errorResponse } : { handle },
        ])
    );

const listLibrariesOk = () =>
    vi.fn().mockResolvedValue({
        type: 'list_libraries',
        request_id: 'r',
        libraries: [{ library_id: 1, name: 'My Library' }],
        total_count: 1,
    });

describe('READ_ONLY_TOOLS', () => {
    it('declares a unique name per tool', () => {
        const names = READ_ONLY_TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('gives every tool a closed object schema and a real description', () => {
        for (const tool of READ_ONLY_TOOLS) {
            expect(tool.parameters.type).toBe('object');
            expect(tool.parameters.additionalProperties).toBe(false);
            expect(tool.description.length).toBeGreaterThan(20);
        }
    });

    it('uses the tool names the result views recognise, each backed by a request event', () => {
        expect(Object.fromEntries(READ_ONLY_TOOLS.map((t) => [t.name, t.requestEvent]))).toEqual({
            item_search_by_metadata: 'item_search_by_metadata_request',
            zotero_search: 'zotero_search_request',
            list_items: 'list_items_request',
            get_metadata: 'get_metadata_request',
            list_collections: 'list_collections_request',
            list_tags: 'list_tags_request',
            list_libraries: 'list_libraries_request',
            read_note: 'read_note_request',
            find_annotations: 'find_annotations_request',
            read_attachment: 'read_attachment_request',
        });
    });

    it('offers no write action and no backend-dependent search', () => {
        for (const tool of READ_ONLY_TOOLS) {
            expect(tool.requestEvent).not.toMatch(/^agent_action_/);
            expect(tool.requestEvent).not.toBe('item_search_by_topic_request');
        }
    });

    it('never points the model at a tool the catalog does not offer', () => {
        const absent = ['search_by_topic', 'search_by_metadata', 'get_item_details', 'create_note'];
        for (const tool of READ_ONLY_TOOLS) {
            for (const name of absent) {
                expect(tool.description, `${tool.name} mentions ${name}`).not.toMatch(
                    new RegExp(`\\b${name}\\b`)
                );
            }
        }
    });
});

describe('buildToolCatalog', () => {
    it('exposes only tools whose request event the provider implements', () => {
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: vi.fn() }),
            searchableLibraryIds: [1],
        });
        expect(catalog.definitions().map((t) => t.name)).toEqual(['list_libraries']);
    });

    it('builds the wire request from the model arguments and passes a transport context', async () => {
        const handle = vi.fn().mockResolvedValue({ type: 'item_search_by_metadata', request_id: 'r', items: [] });
        const catalog = buildToolCatalog({
            provider: providerWith({ item_search_by_metadata_request: handle }),
            searchableLibraryIds: [1],
        });
        await catalog.execute(
            'item_search_by_metadata',
            { author_query: 'Acemoglu', min_year: 2001, max_year: 2010, tags_filter: ['growth'] },
            signal
        );
        expect(handle).toHaveBeenCalledTimes(1);
        const [request, context] = handle.mock.calls[0];
        expect(request).toEqual({
            event: 'item_search_by_metadata_request',
            request_id: expect.any(String),
            author_query: 'Acemoglu',
            year_min: 2001,
            year_max: 2010,
            tags_filter: ['growth'],
            limit: 5,
            offset: 0,
        });
        expect(request.request_id.length).toBeGreaterThan(0);
        expect(context).toEqual({
            signal,
            receivedAt: expect.any(Number),
            reportPhase: expect.any(Function),
        });
    });

    it('fills the zotero_search defaults the handler requires', async () => {
        const handle = vi.fn().mockResolvedValue({ type: 'zotero_search', request_id: 'r', items: [], total_count: 0 });
        const catalog = buildToolCatalog({
            provider: providerWith({ zotero_search_request: handle }),
            searchableLibraryIds: [1],
        });
        const conditions = [{ field: 'title', operator: 'contains', value: 'cells' }];
        await catalog.execute('zotero_search', { conditions }, signal);
        expect(handle.mock.calls[0][0]).toMatchObject({
            event: 'zotero_search_request',
            conditions,
            join_mode: 'all',
            include_children: false,
            recursive: true,
            limit: 20,
            offset: 0,
        });
    });

    it('passes a numeric library argument as a library id and anything else as a reference', async () => {
        const handle = vi.fn().mockResolvedValue({ type: 'list_collections', request_id: 'r', collections: [], total_count: 0 });
        const catalog = buildToolCatalog({
            provider: providerWith({ list_collections_request: handle }),
            searchableLibraryIds: [1],
        });
        await catalog.execute('list_collections', { library: '3' }, signal);
        await catalog.execute('list_collections', { library: 'g42' }, signal);
        expect(handle.mock.calls[0][0]).toMatchObject({ library_id: 3 });
        expect(handle.mock.calls[1][0]).toMatchObject({ library_id: 'g42' });
    });

    it('leaves library scoping to the handlers and adds no library_ids field', async () => {
        const handle = vi.fn().mockResolvedValue({ type: 'list_items', request_id: 'r', items: [], total_count: 0 });
        const catalog = buildToolCatalog({
            provider: providerWith({ list_items_request: handle }),
            searchableLibraryIds: [3, 7],
        });
        await catalog.execute('list_items', {}, signal);
        expect(handle.mock.calls[0][0]).not.toHaveProperty('library_ids');
    });

    it('refuses a run with no searchable libraries instead of querying all of them', async () => {
        const handle = vi.fn();
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: handle }),
            searchableLibraryIds: [],
        });
        const result = await catalog.execute('list_libraries', {}, signal);
        expect(result).toMatchObject({ ok: false, retryable: false });
        expect(handle).not.toHaveBeenCalled();
    });

    it('reports an unknown tool as a retryable error naming the valid tools', async () => {
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: vi.fn() }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('nope', {}, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain('list_libraries');
    });

    it.each([
        ['an unknown argument', { note_id: 'u-ABC', bogus: 1 }, 'bogus'],
        ['a missing required argument', {}, 'note_id'],
        ['a wrongly typed argument', { note_id: 'u-ABC', limit: 'ten' }, 'limit'],
    ])('rejects %s without calling the handler', async (_label, args, mentioned) => {
        const handle = vi.fn();
        const catalog = buildToolCatalog({
            provider: providerWith({ read_note_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('read_note', args, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain(mentioned);
        expect(handle).not.toHaveBeenCalled();
    });

    it('treats a null optional argument as omitted', async () => {
        const handle = vi.fn().mockResolvedValue({ type: 'read_note', request_id: 'r', success: true, content: '' });
        const catalog = buildToolCatalog({
            provider: providerWith({ read_note_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('read_note', { note_id: 'u-ABC', limit: null }, signal);
        expect(result.ok).toBe(true);
        expect(handle.mock.calls[0][0]).not.toHaveProperty('limit');
    });

    it('asks for a search field when a metadata search names none', async () => {
        const handle = vi.fn();
        const catalog = buildToolCatalog({
            provider: providerWith({ item_search_by_metadata_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('item_search_by_metadata', { min_year: 2000 }, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        expect(handle).not.toHaveBeenCalled();
    });

    it('turns a resolved error response into a retryable tool failure', async () => {
        const handle = vi.fn().mockResolvedValue({
            type: 'list_tags',
            request_id: 'r',
            tags: [],
            error: 'Collection not found',
            error_code: 'collection_not_found',
        });
        const catalog = buildToolCatalog({
            provider: providerWith({ list_tags_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('list_tags', { collection: 'X' }, signal);
        expect(result).toEqual({ ok: false, retryable: true, error: 'Collection not found' });
    });

    it.each(['library_excluded', 'library_not_searchable'])(
        'does not invite a retry when the handler answers %s',
        async (errorCode) => {
            const handle = vi.fn().mockResolvedValue({
                type: 'find_annotations',
                request_id: 'r',
                annotations: [],
                total_count: 0,
                error: 'That library is excluded from Beaver.',
                error_code: errorCode,
            });
            const catalog = buildToolCatalog({
                provider: providerWith({ find_annotations_request: handle }),
                searchableLibraryIds: [1],
            });
            const result = await catalog.execute('find_annotations', { library: 'g9' }, signal);
            expect(result).toMatchObject({ ok: false, retryable: false });
        }
    );

    it('treats an unsuccessful read_note response as a tool failure', async () => {
        const handle = vi.fn().mockResolvedValue({
            type: 'read_note',
            request_id: 'r',
            success: false,
            error: 'Note not found',
        });
        const catalog = buildToolCatalog({
            provider: providerWith({ read_note_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('read_note', { note_id: 'u-ABC' }, signal);
        expect(result).toEqual({ ok: false, retryable: true, error: 'Note not found' });
    });

    it('maps a handler rejection through the entry error response', async () => {
        const handle = vi.fn().mockRejectedValue(new Error('database is locked'));
        const errorResponse = vi.fn((event, err) => ({
            type: 'list_libraries',
            request_id: event.request_id,
            libraries: [],
            total_count: 0,
            error: String(err),
            error_code: 'internal_error',
        }));
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: handle }, errorResponse),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('list_libraries', {}, signal);
        expect(errorResponse).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'list_libraries_request' }),
            expect.any(Error)
        );
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain('database is locked');
    });

    it('turns a rejection into a retryable error when the entry has no error response', async () => {
        const handle = vi.fn().mockRejectedValue(new Error('database is locked'));
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: handle }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('list_libraries', {}, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain('database is locked');
    });

    it('returns the response object for the UI and a trimmed JSON string for the model', async () => {
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: listLibrariesOk() }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('list_libraries', {}, signal);
        expect(result).toEqual({
            ok: true,
            content: {
                type: 'list_libraries',
                request_id: 'r',
                libraries: [{ library_id: 1, name: 'My Library' }],
                total_count: 1,
            },
            text: JSON.stringify({ libraries: [{ library_id: 1, name: 'My Library' }], total_count: 1 }),
        });
    });

    it('rejects a response that is not a plain object', async () => {
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: vi.fn().mockResolvedValue('nope') }),
            searchableLibraryIds: [1],
        });
        const result = await catalog.execute('list_libraries', {}, signal);
        expect(result).toMatchObject({ ok: false, retryable: false });
    });
});

describe('read_attachment', () => {
    const readAttachmentCatalog = (handle = vi.fn().mockResolvedValue({ type: 'read_attachment', request_id: 'r', pages: [] })) => ({
        handle,
        catalog: buildToolCatalog({
            provider: providerWith({ read_attachment_request: handle }),
            searchableLibraryIds: [1],
        }),
    });

    it('declares a closed schema with paging arguments', () => {
        const tool = READ_ONLY_TOOLS.find((t) => t.name === 'read_attachment');
        expect(tool?.parameters.additionalProperties).toBe(false);
        expect(tool?.parameters.required).toEqual(['attachment_id']);
        expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(['attachment_id', 'end_page', 'start_page']);
    });

    it('requests the first 30 pages with a text budget when no range is given', async () => {
        const { handle, catalog } = readAttachmentCatalog();
        const result = await catalog.execute('read_attachment', { attachment_id: 'u-ABC12345' }, signal);
        expect(result.ok).toBe(true);
        expect(handle.mock.calls[0][0]).toEqual({
            event: 'read_attachment_request',
            request_id: expect.any(String),
            attachment_id: 'u-ABC12345',
            start_page: 1,
            end_page: 30,
            max_chars: 60000,
        });
    });

    it('scales the text budget to a known context window, within a floor and the cap', async () => {
        const budgetFor = async (contextWindow: number | null) => {
            const handle = vi.fn().mockResolvedValue({ type: 'read_attachment', request_id: 'r', pages: [] });
            const catalog = buildToolCatalog({
                provider: providerWith({ read_attachment_request: handle }),
                searchableLibraryIds: [1],
                contextWindow,
            });
            await catalog.execute('read_attachment', { attachment_id: 'u-ABC12345' }, signal);
            return handle.mock.calls[0][0].max_chars;
        };
        // A quarter of the window, at about four characters per token.
        expect(await budgetFor(32_000)).toBe(32_000);
        expect(await budgetFor(8_000)).toBe(8_000);
        expect(await budgetFor(2_000)).toBe(READ_ATTACHMENT_MIN_CHARS);
        expect(await budgetFor(1_000_000)).toBe(READ_ATTACHMENT_MAX_CHARS);
        expect(await budgetFor(null)).toBe(READ_ATTACHMENT_MAX_CHARS);
        expect(readAttachmentMaxChars(16_000)).toBe(16_000);
    });

    it('caps a requested range at 30 pages', async () => {
        const { handle, catalog } = readAttachmentCatalog();
        await catalog.execute('read_attachment', { attachment_id: 'u-ABC12345', start_page: 10, end_page: 100 }, signal);
        expect(handle.mock.calls[0][0]).toMatchObject({ start_page: 10, end_page: 39 });
    });

    it('keeps a requested range within the cap as given', async () => {
        const { handle, catalog } = readAttachmentCatalog();
        await catalog.execute('read_attachment', { attachment_id: 'u-ABC12345', start_page: 3, end_page: 5 }, signal);
        expect(handle.mock.calls[0][0]).toMatchObject({ start_page: 3, end_page: 5 });
    });

    it('rejects an end page before the start page without calling the handler', async () => {
        const { handle, catalog } = readAttachmentCatalog();
        const result = await catalog.execute(
            'read_attachment',
            { attachment_id: 'u-ABC12345', start_page: 10, end_page: 5 },
            signal
        );
        expect(result).toMatchObject({ ok: false, retryable: true });
        expect(!result.ok && result.error).toContain('end_page');
        expect(handle).not.toHaveBeenCalled();
    });

    it('rejects a page number below 1 and an unknown argument', async () => {
        const { handle, catalog } = readAttachmentCatalog();
        expect((await catalog.execute('read_attachment', { attachment_id: 'u-A', start_page: 0 }, signal)).ok).toBe(false);
        expect((await catalog.execute('read_attachment', { attachment_id: 'u-A', mode: 'structured' }, signal)).ok).toBe(false);
        expect(handle).not.toHaveBeenCalled();
    });

    it('reports an excluded-library refusal as not retryable', async () => {
        const { catalog } = readAttachmentCatalog(
            vi.fn().mockResolvedValue({
                type: 'read_attachment',
                request_id: 'r',
                error: 'Library excluded',
                error_code: 'library_excluded',
            })
        );
        const result = await catalog.execute('read_attachment', { attachment_id: 'g5-ABC12345' }, signal);
        expect(result).toEqual({ ok: false, retryable: false, error: 'Library excluded' });
    });
});

describe('native tools', () => {
    const echoSpec = {
        name: 'echo_search',
        description: 'Echo the query back, for testing the native tool path.',
        parameters: {
            type: 'object' as const,
            properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1 } },
            required: ['query'],
            additionalProperties: false as const,
        },
    };

    const nativeTool = (run = vi.fn(async (args: Record<string, unknown>) => ({
        ok: true as const,
        content: { echoed: args.query },
        text: String(args.query),
        metadata: { supplemental_data: [] },
    }))) => ({ tool: { spec: echoSpec, run }, run });

    it('offers native tools after the handler tools, with only the model-facing fields', () => {
        const { tool } = nativeTool();
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: vi.fn() }),
            searchableLibraryIds: [1],
            nativeTools: [tool],
        });
        expect(catalog.definitions().map((t) => t.name)).toEqual(['list_libraries', 'echo_search']);
        expect(catalog.definitions()[1]).toEqual(echoSpec);
    });

    it('offers no native tool when none is given', () => {
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: vi.fn() }),
            searchableLibraryIds: [1],
        });
        expect(catalog.definitions().map((t) => t.name)).not.toContain('echo_search');
    });

    it('runs a native tool with its arguments, the signal, and passes its metadata through', async () => {
        const { tool, run } = nativeTool();
        const catalog = buildToolCatalog({ provider: {}, searchableLibraryIds: [1], nativeTools: [tool] });
        const result = await catalog.execute('echo_search', { query: 'graphene', limit: null }, signal);
        expect(run).toHaveBeenCalledWith({ query: 'graphene' }, signal);
        expect(result).toEqual({
            ok: true,
            content: { echoed: 'graphene' },
            text: 'graphene',
            metadata: { supplemental_data: [] },
        });
    });

    it('runs a native tool when no library is searchable, while handler tools still refuse', async () => {
        const { tool, run } = nativeTool();
        const handle = vi.fn();
        const catalog = buildToolCatalog({
            provider: providerWith({ list_libraries_request: handle }),
            searchableLibraryIds: [],
            nativeTools: [tool],
        });

        expect(await catalog.execute('echo_search', { query: 'x' }, signal)).toMatchObject({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);

        expect(await catalog.execute('list_libraries', {}, signal)).toMatchObject({ ok: false, retryable: false });
        expect(handle).not.toHaveBeenCalled();
    });

    it('validates native tool arguments against its schema before running it', async () => {
        const { tool, run } = nativeTool();
        const catalog = buildToolCatalog({ provider: {}, searchableLibraryIds: [1], nativeTools: [tool] });
        const result = await catalog.execute('echo_search', { query: 'x', bogus: true }, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain('bogus');
        expect(run).not.toHaveBeenCalled();
    });

    it('turns a native tool that throws into a retryable failure', async () => {
        const { tool } = nativeTool(vi.fn(async () => {
            throw new Error('socket hang up');
        }));
        const catalog = buildToolCatalog({ provider: {}, searchableLibraryIds: [1], nativeTools: [tool] });
        const result = await catalog.execute('echo_search', { query: 'x' }, signal);
        expect(result).toMatchObject({ ok: false, retryable: true });
        if (!result.ok) expect(result.error).toContain('socket hang up');
    });

    it('names native tools among the valid tools for an unknown call', async () => {
        const { tool } = nativeTool();
        const catalog = buildToolCatalog({ provider: {}, searchableLibraryIds: [1], nativeTools: [tool] });
        const result = await catalog.execute('nope', {}, signal);
        if (!result.ok) expect(result.error).toContain('echo_search');
        else throw new Error('expected failure');
    });

    it('refuses a native tool whose name collides with a handler tool', () => {
        const { tool } = nativeTool();
        expect(() =>
            buildToolCatalog({
                provider: providerWith({ list_libraries_request: vi.fn() }),
                searchableLibraryIds: [1],
                nativeTools: [{ ...tool, spec: { ...echoSpec, name: 'list_libraries' } }],
            })
        ).toThrow(/list_libraries/);
    });
});

describe('scholarly_search in the catalog', () => {
    const source = (results: unknown[] = []) => ({
        name: 'OpenAlex',
        search: vi.fn(async () => ({ ok: true as const, results: results as any[] })),
    });

    it('is offered when the scholarly search tool is given, and absent otherwise', () => {
        const enabled = buildToolCatalog({
            provider: {},
            searchableLibraryIds: [1],
            nativeTools: [createScholarlySearchTool({ sources: [source()] })],
        });
        const disabled = buildToolCatalog({ provider: {}, searchableLibraryIds: [1] });
        expect(enabled.definitions().map((t) => t.name)).toEqual(['scholarly_search']);
        expect(disabled.definitions().map((t) => t.name)).toEqual([]);
    });

    it('executes with the model query when every library is excluded', async () => {
        const s = source();
        const catalog = buildToolCatalog({
            provider: {},
            searchableLibraryIds: [],
            nativeTools: [createScholarlySearchTool({ sources: [s] })],
        });
        const result = await catalog.execute('scholarly_search', { query: 'graphene', year_from: null }, signal);
        expect(result).toMatchObject({ ok: true });
        expect(s.search.mock.calls[0][0]).toMatchObject({ query: 'graphene' });
    });
});
