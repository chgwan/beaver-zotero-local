/**
 * JSON Schema declarations for the tools the in-plugin loop offers, and the
 * mapping from a tool call's arguments to the wire request its data-provider
 * handler consumes.
 *
 * Tool names are the hosted agent's tool names, so the result views that key
 * on `tool_name` recognise a local result the same way. Argument names follow
 * the plugin's MCP tools, which describe the same handlers to external models;
 * `buildRequest` translates them into the matching `WS*Request` shape of the
 * wire protocol, whose field names it must track. Those types are not imported
 * here: the protocol module's closure needs host globals this package does not
 * declare. Every request is built from a closed schema, so a field the handler
 * does not know cannot reach it.
 */


export interface JsonSchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
}

/** Validated tool arguments, keyed by the schema's property names. */
export type ToolArgs = Record<string, any>;

/** A wire request ready for the data-provider entry of `requestEvent`. */
export interface ToolRequest {
    event: string;
    request_id: string;
    [field: string]: unknown;
}

export interface LocalToolDefinition {
    /** Name the model calls; the hosted agent's name for the same tool. */
    name: string;
    description: string;
    parameters: JsonSchema;
    /** Data-provider map key whose handler implements this tool. */
    requestEvent: string;
    /**
     * Rules the schema cannot express. Returns a message for the model when
     * the arguments are unusable, or null.
     */
    checkArgs?: (args: ToolArgs) => string | null;
    /** Build the wire request from schema-valid arguments. */
    buildRequest: (args: ToolArgs, requestId: string) => ToolRequest;
}

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number =>
    Math.min(Math.max(min, value ?? fallback), max);

/**
 * A `library` argument as the handlers accept it: a numeric id, or a string
 * they resolve as a portable reference ("u" / "g<groupID>") or a name.
 */
const libraryArg = (value: unknown): number | string | null => {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    const text = String(value);
    return /^\d+$/.test(text) ? Number(text) : text;
};

const libraryProperty = {
    type: 'string',
    description:
        'Library reference from `list_libraries` ("u" for the personal library, "g<groupID>" for a group), numeric ID, or name. Omit for the personal library.',
};

const limitProperty = (fallback: number, max: number) => ({
    type: 'integer',
    minimum: 1,
    maximum: max,
    description: `Max results per page (default ${fallback}, max ${max}).`,
});

const offsetProperty = {
    type: 'integer',
    minimum: 0,
    description: 'Results to skip for pagination (default 0).',
};

const tagsFilterProperty = {
    type: 'array',
    items: { type: 'string' },
    description:
        'Zotero tags to filter results (OR logic). Matched ignoring case; a tag the library does not have is reported as an error, so use `list_tags` to discover them.',
};

const collectionsFilterProperty = {
    type: 'array',
    items: { type: 'string' },
    description:
        'Collection names or keys to filter results (OR logic). Each collection includes its subcollections.',
};

const itemIdDescription =
    'in the form `<library>-<zotero_key>` as returned by other tools (e.g. "u-ABC12345"; legacy numeric ids like "1-ABC12345" are also accepted)';

export const ITEM_SEARCH_BY_METADATA_TOOL: LocalToolDefinition = {
    name: 'item_search_by_metadata',
    description:
        "Search the user's Zotero library by bibliographic metadata: author name, title keywords, or " +
        'publication/journal name. At least one of author_query, title_query, or publication_query must be ' +
        'provided; they are combined with AND. Use this when you know specific details about the papers ' +
        'you are looking for. Each result carries the item ID to use with `get_metadata`.',
    parameters: {
        type: 'object',
        properties: {
            author_query: {
                type: 'string',
                description:
                    'Creator name tokens (first, last, full, or institutional), matched case-insensitively within one creator.',
            },
            title_query: {
                type: 'string',
                description: 'Keyword or phrase from the title (e.g. "colonial origins").',
            },
            publication_query: {
                type: 'string',
                description: 'Journal or publication name (e.g. "American Economic Review").',
            },
            min_year: { type: 'integer', description: 'Earliest publication year (inclusive).' },
            max_year: { type: 'integer', description: 'Latest publication year (inclusive).' },
            libraries_filter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Library references, names, or IDs to restrict the search scope.',
            },
            tags_filter: tagsFilterProperty,
            collections_filter: collectionsFilterProperty,
            limit: limitProperty(5, 25),
            offset: offsetProperty,
        },
        additionalProperties: false,
    },
    requestEvent: 'item_search_by_metadata_request',
    checkArgs: (args) =>
        args.author_query || args.title_query || args.publication_query
            ? null
            : 'At least one search field must be provided: author_query, title_query, or publication_query.',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'item_search_by_metadata_request',
        request_id: requestId,
        title_query: args.title_query,
        author_query: args.author_query,
        publication_query: args.publication_query,
        year_min: args.min_year,
        year_max: args.max_year,
        libraries_filter: args.libraries_filter,
        tags_filter: args.tags_filter,
        collections_filter: args.collections_filter,
        limit: clamp(args.limit, 5, 1, 25),
        offset: Math.max(0, args.offset ?? 0),
    }),
};

/** Operators the Zotero search handler maps onto `Zotero.Search`. */
const ZOTERO_SEARCH_OPERATORS = [
    'is',
    'isNot',
    'contains',
    'doesNotContain',
    'beginsWith',
    'isLessThan',
    'isGreaterThan',
    'isBefore',
    'isAfter',
    'isInTheLast',
];

export const ZOTERO_SEARCH_TOOL: LocalToolDefinition = {
    name: 'zotero_search',
    description:
        "Run a Zotero advanced search over one library of the user's Zotero data. Each condition names a " +
        'Zotero search field, an operator, and a value; conditions are combined by join_mode. Use this for ' +
        'precise field queries (item type, date added, DOI, tag, collection) that `item_search_by_metadata` ' +
        'cannot express. Conditions Zotero rejects are reported back as warnings.',
    parameters: {
        type: 'object',
        properties: {
            conditions: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    properties: {
                        field: {
                            type: 'string',
                            description:
                                'Zotero search field, e.g. "title", "creator", "date", "dateAdded", "itemType", "tag", "collection", "DOI", "publicationTitle", "abstractNote", "anyField", "fulltextContent".',
                        },
                        operator: { type: 'string', enum: ZOTERO_SEARCH_OPERATORS },
                        value: {
                            type: 'string',
                            description:
                                'Value to compare against. Dates use YYYY-MM-DD; isInTheLast takes a duration like "7 days". Collection conditions take a key from `list_collections`.',
                        },
                    },
                    required: ['field', 'operator'],
                    additionalProperties: false,
                },
                description: 'Search conditions.',
            },
            join_mode: {
                type: 'string',
                enum: ['all', 'any'],
                description: 'Match all conditions (AND) or any of them (OR). Default: "all".',
            },
            library: libraryProperty,
            item_category: {
                type: 'string',
                enum: ['regular', 'note', 'attachment', 'all'],
                description:
                    'Item type to return: "regular" (bibliographic items), "note", "attachment", or "all". Default: "regular".',
            },
            include_children: {
                type: 'boolean',
                description: 'Also match child notes and attachments. Default: false.',
            },
            recursive: {
                type: 'boolean',
                description: 'Collection conditions include subcollections. Default: true.',
            },
            has_attachments: {
                type: 'boolean',
                description: 'Only items with (true) or without (false) attachments. Omit for no filter.',
            },
            sort_by: {
                type: 'string',
                enum: ['dateAdded', 'dateModified', 'title', 'creator', 'year'],
                description: 'Sort field. Omit for Zotero order.',
            },
            sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Default: "desc".' },
            limit: limitProperty(20, 100),
            offset: offsetProperty,
        },
        required: ['conditions'],
        additionalProperties: false,
    },
    requestEvent: 'zotero_search_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'zotero_search_request',
        request_id: requestId,
        conditions: args.conditions,
        join_mode: args.join_mode ?? 'all',
        library_id: libraryArg(args.library),
        item_category: args.item_category ?? 'regular',
        include_children: args.include_children ?? false,
        recursive: args.recursive ?? true,
        has_attachments: args.has_attachments,
        sort_by: args.sort_by,
        sort_order: args.sort_order,
        limit: clamp(args.limit, 20, 1, 100),
        offset: Math.max(0, args.offset ?? 0),
    }),
};

const LIST_ITEMS_SORT_FIELDS = ['dateAdded', 'dateModified', 'title', 'creator', 'year'];

export const LIST_ITEMS_TOOL: LocalToolDefinition = {
    name: 'list_items',
    description:
        "Browse items in the user's Zotero library, optionally filtered by collection and/or tag. Unlike the " +
        'search tools this needs no query: it lists the items matching the filters, sorted by the given field. ' +
        'Use it to enumerate a collection, find recently added items, or survey a tag. Filters are cumulative. ' +
        'By default only regular bibliographic items are returned; use item_category for notes, attachments, ' +
        'or all. Call `get_metadata` for full details of a listed item.',
    parameters: {
        type: 'object',
        properties: {
            library: libraryProperty,
            collection: { type: 'string', description: 'Collection name or key to list items from.' },
            tag: { type: 'string', description: 'Tag to filter items by.' },
            item_category: {
                type: 'string',
                enum: ['regular', 'note', 'attachment', 'all'],
                description:
                    'Item type to return: "regular" (bibliographic items), "note", "attachment", or "all". Default: "regular".',
            },
            recursive: {
                type: 'boolean',
                description: 'Include items from subcollections. Default: true.',
            },
            sort_by: {
                type: 'string',
                enum: LIST_ITEMS_SORT_FIELDS,
                description: 'Sort field. Default: "dateModified".',
            },
            sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Default: "desc".' },
            limit: limitProperty(20, 100),
            offset: offsetProperty,
        },
        additionalProperties: false,
    },
    requestEvent: 'list_items_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'list_items_request',
        request_id: requestId,
        library_id: libraryArg(args.library),
        collection_key: args.collection ?? null,
        tag: args.tag ?? null,
        item_category: args.item_category ?? 'regular',
        recursive: args.recursive ?? true,
        sort_by: LIST_ITEMS_SORT_FIELDS.includes(args.sort_by) ? args.sort_by : 'dateModified',
        sort_order: args.sort_order === 'asc' ? 'asc' : 'desc',
        limit: clamp(args.limit, 20, 1, 100),
        offset: Math.max(0, args.offset ?? 0),
    }),
};

export const GET_METADATA_TOOL: LocalToolDefinition = {
    name: 'get_metadata',
    description:
        "Get complete bibliographic metadata for specific items in the user's Zotero library: every Zotero " +
        'field (title, creators, abstract, DOI, journal, volume, pages, date, …) plus tags and collection ' +
        'memberships. Use it after finding items via search or listing. Set include_attachments to see the ' +
        "item's files and their availability (attachment IDs for `read_attachment`), and include_notes to " +
        'list its child notes for `read_note`.',
    parameters: {
        type: 'object',
        properties: {
            item_ids: {
                type: 'array',
                minItems: 1,
                maxItems: 25,
                items: { type: 'string' },
                description: `Item IDs ${itemIdDescription}. Maximum 25.`,
            },
            include_attachments: {
                type: 'boolean',
                description: 'Include attachment metadata (filenames, types, availability). Default: false.',
            },
            include_notes: {
                type: 'boolean',
                description: 'Include child notes (title, last modified) for each item. Default: false.',
            },
        },
        required: ['item_ids'],
        additionalProperties: false,
    },
    requestEvent: 'get_metadata_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'get_metadata_request',
        request_id: requestId,
        item_ids: args.item_ids,
        include_attachments: args.include_attachments ?? false,
        include_notes: args.include_notes ?? false,
    }),
};

export const LIST_COLLECTIONS_TOOL: LocalToolDefinition = {
    name: 'list_collections',
    description:
        "List collections (folders) in the user's Zotero library to see how their references are organized. " +
        'Returns collection names, keys, item counts, and subcollection counts. item_count covers regular ' +
        'items only. Use the keys or names as collection filters in the search and list tools, or set ' +
        'parent_collection to explore nested subcollections.',
    parameters: {
        type: 'object',
        properties: {
            library: libraryProperty,
            parent_collection: {
                type: 'string',
                description: 'Collection key to list subcollections within. Omit for top-level collections.',
            },
            recursive: {
                type: 'boolean',
                description:
                    'List every descendant collection instead of direct children only. Each result carries parent_key. Default: false.',
            },
            include_item_counts: {
                type: 'boolean',
                description: 'Include the number of items in each collection. Default: true.',
            },
            limit: limitProperty(50, 100),
            offset: offsetProperty,
        },
        additionalProperties: false,
    },
    requestEvent: 'list_collections_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'list_collections_request',
        request_id: requestId,
        library_id: libraryArg(args.library),
        parent_collection_key: args.parent_collection ?? null,
        include_item_counts: args.include_item_counts ?? true,
        recursive: args.recursive ?? false,
        limit: clamp(args.limit, 50, 1, 100),
        offset: Math.max(0, args.offset ?? 0),
    }),
};

export const LIST_TAGS_TOOL: LocalToolDefinition = {
    name: 'list_tags',
    description:
        "List tags in the user's Zotero library with per-type counts (item_count, attachment_count, " +
        'note_count, annotation_count). Use it to discover tags before filtering by them. Set name_query to ' +
        'search tag names in a large library, and min_item_count to drop rarely used tags. tag_type selects ' +
        '"manual" (added by the user, the default), "automatic" (imported with item metadata), or "all".',
    parameters: {
        type: 'object',
        properties: {
            library: libraryProperty,
            collection: {
                type: 'string',
                description: 'Collection key to list tags within that collection only.',
            },
            name_query: {
                type: 'string',
                description: 'Only return tags whose name contains this text (case-insensitive).',
            },
            min_item_count: {
                type: 'integer',
                minimum: 0,
                description: 'Minimum number of tagged objects a tag must have. Default: 1.',
            },
            tag_type: {
                type: 'string',
                enum: ['manual', 'automatic', 'all'],
                description: 'Which tags to list. Default: "manual".',
            },
            limit: limitProperty(50, 100),
            offset: offsetProperty,
        },
        additionalProperties: false,
    },
    requestEvent: 'list_tags_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'list_tags_request',
        request_id: requestId,
        library_id: libraryArg(args.library),
        collection_key: args.collection ?? null,
        min_item_count: args.min_item_count ?? 1,
        name_query: args.name_query ?? null,
        tag_type: args.tag_type ?? 'manual',
        limit: clamp(args.limit, 50, 1, 100),
        offset: Math.max(0, args.offset ?? 0),
    }),
};

export const LIST_LIBRARIES_TOOL: LocalToolDefinition = {
    name: 'list_libraries',
    description:
        'List the Zotero libraries available to Beaver, with portable library reference, name, read-only ' +
        'status, and item, note, collection, and tag counts. Use the library reference as the library ' +
        'argument of other tools.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    requestEvent: 'list_libraries_request',
    buildRequest: (_args, requestId): ToolRequest => ({
        event: 'list_libraries_request',
        request_id: requestId,
    }),
};

export const READ_NOTE_TOOL: LocalToolDefinition = {
    name: 'read_note',
    description:
        "Read a Zotero note's content as simplified HTML, in which citations, annotations, and images appear " +
        'as self-closing tags. Use note IDs returned by `get_metadata` with include_notes, or by the search ' +
        'and list tools. Use offset and limit to page through a long note by line.',
    parameters: {
        type: 'object',
        properties: {
            note_id: { type: 'string', minLength: 1, description: `The note ID ${itemIdDescription}.` },
            offset: {
                type: 'integer',
                minimum: 1,
                description: '1-indexed start line. Defaults to the beginning of the note.',
            },
            limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
        },
        required: ['note_id'],
        additionalProperties: false,
    },
    requestEvent: 'read_note_request',
    buildRequest: (args, requestId): ToolRequest => ({
        event: 'read_note_request',
        request_id: requestId,
        note_id: args.note_id,
        offset: args.offset,
        limit: args.limit,
    }),
};

const nonEmptyString = { type: 'string', minLength: 1 };

export const FIND_ANNOTATIONS_TOOL: LocalToolDefinition = {
    name: 'find_annotations',
    description:
        'Find highlights, underlines, and note annotations in a Zotero library. Filters are combined with ' +
        'AND; omit them to browse all annotations with pagination. Returns annotation text, comments, tags, ' +
        'source IDs, and pagination. Defaults to the personal library; use `list_libraries` for others.',
    parameters: {
        type: 'object',
        properties: {
            text_contains: { ...nonEmptyString, description: 'Substring in highlighted text.' },
            comment_contains: { ...nonEmptyString, description: 'Substring in annotation comments.' },
            tag: nonEmptyString,
            color: {
                ...nonEmptyString,
                description: 'Zotero color name or hex color (matched to the nearest palette color).',
            },
            annotation_type: { type: 'string', enum: ['highlight', 'underline', 'note'] },
            author: {
                ...nonEmptyString,
                description: 'Annotation creator name substring, not the paper author.',
            },
            attachment_id: {
                ...nonEmptyString,
                description:
                    'File attachment ID. Parent item IDs are not supported; use `get_metadata` with include_attachments to find attachment IDs.',
            },
            collection: { ...nonEmptyString, description: 'Collection key or name.' },
            library: {
                type: ['string', 'integer'],
                description: 'Library reference ("u" or "g<groupID>"), numeric ID, or name.',
            },
            recursive: { type: 'boolean', description: 'Include subcollections. Default: true.' },
            modified_in_last: {
                ...nonEmptyString,
                description: 'Relative duration, e.g. "7 days" or "2 months".',
            },
            sort_by: {
                type: 'string',
                enum: ['date_modified', 'date_added', 'reading_order'],
                description: 'Default: "date_modified".',
            },
            sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Default: "desc".' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 25, max 50.' },
            offset: offsetProperty,
        },
        additionalProperties: false,
    },
    requestEvent: 'find_annotations_request',
    buildRequest: (args, requestId): ToolRequest => {
        const { library, ...filters } = args;
        return {
            ...filters,
            event: 'find_annotations_request',
            request_id: requestId,
            library_id: library,
            recursive: args.recursive ?? true,
            sort_by: args.sort_by ?? 'date_modified',
            sort_order: args.sort_order ?? 'desc',
            limit: args.limit ?? 25,
            offset: args.offset ?? 0,
        };
    },
};

/** Most pages one `read_attachment` call returns. */
export const READ_ATTACHMENT_MAX_PAGES = 30;

/**
 * Most characters of page text one `read_attachment` call returns. Pages past
 * the budget are left for a follow-up call, so a dense document cannot flood
 * the model's context in one read.
 */
export const READ_ATTACHMENT_MAX_CHARS = 60_000;

const pageNumberProperty = (description: string) => ({ type: 'integer', minimum: 1, description });

export const READ_ATTACHMENT_TOOL: LocalToolDefinition = {
    name: 'read_attachment',
    description:
        "Read the text of a PDF, EPUB, or web snapshot attachment from the user's Zotero library, page by " +
        `page. Returns up to ${READ_ATTACHMENT_MAX_PAGES} pages per call (EPUB and snapshot pages are ` +
        'sections of the document); a long page range may stop early to bound the text, in which case the ' +
        'result gives `next_start_page`. For long documents, read progressively by page range. Get ' +
        'attachment IDs from `get_metadata` with include_attachments, or from search results; a parent ' +
        "item ID reads that item's best attachment.",
    parameters: {
        type: 'object',
        properties: {
            attachment_id: {
                type: 'string',
                minLength: 1,
                description: `The attachment ID ${itemIdDescription}.`,
            },
            start_page: pageNumberProperty('First page to read (1-indexed). Defaults to page 1.'),
            end_page: pageNumberProperty(
                `Last page to read (inclusive). Defaults to start_page + ${READ_ATTACHMENT_MAX_PAGES - 1}; ` +
                    `at most ${READ_ATTACHMENT_MAX_PAGES} pages are read per call.`
            ),
        },
        required: ['attachment_id'],
        additionalProperties: false,
    },
    checkArgs: (args) =>
        args.end_page !== undefined && args.end_page < (args.start_page ?? 1)
            ? 'end_page must be greater than or equal to start_page.'
            : null,
    requestEvent: 'read_attachment_request',
    buildRequest: (args, requestId): ToolRequest => {
        const startPage: number = args.start_page ?? 1;
        const lastAllowed = startPage + READ_ATTACHMENT_MAX_PAGES - 1;
        return {
            event: 'read_attachment_request',
            request_id: requestId,
            attachment_id: args.attachment_id,
            start_page: startPage,
            end_page: Math.min(args.end_page ?? lastAllowed, lastAllowed),
            max_chars: READ_ATTACHMENT_MAX_CHARS,
        };
    },
};

/**
 * The read-only tool set. Write actions are absent because they require the
 * approval flow, which local mode does not implement; topic search is absent
 * because it depends on server-side embeddings.
 */
export const READ_ONLY_TOOLS: readonly LocalToolDefinition[] = [
    ITEM_SEARCH_BY_METADATA_TOOL,
    ZOTERO_SEARCH_TOOL,
    LIST_ITEMS_TOOL,
    GET_METADATA_TOOL,
    LIST_COLLECTIONS_TOOL,
    LIST_TAGS_TOOL,
    LIST_LIBRARIES_TOOL,
    READ_NOTE_TOOL,
    FIND_ANNOTATIONS_TOOL,
    READ_ATTACHMENT_TOOL,
];
