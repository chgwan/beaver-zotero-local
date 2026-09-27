/**
 * Render metadata for local tool returns.
 *
 * The result cards are built by the renderer from a tool return's `content`
 * and `metadata.summary`. Most tools' cards read the handler response in
 * `content` directly. The rest read only a summary of item or page
 * references, which the hosted agent attaches to the return; local mode
 * derives the same summary from the handler response here, so those cards
 * render identically.
 *
 * Returns `undefined` when a tool needs no summary or the response does not
 * have the expected shape — the card then falls back to its content-only path.
 */

import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { PageReference } from '@beaver/agent-core/run-state/toolResultTypes';
import { resolveObjectIdReference } from '@beaver/agent-core/identity/libraryRef';

export interface ItemSearchSummary {
    tool_name: string;
    result_count: number;
    items: ZoteroItemReference[];
}

export interface AnnotationListSummary {
    tool_name: 'find_annotations';
    result_count: number;
    total_count: number;
    has_more: boolean;
    annotations: ZoteroItemReference[];
}

/** The page list an attachment read card renders (the backend's read-pages summary). */
export interface ReadPagesSummary {
    tool_name: 'read_attachment';
    result_count: number;
    pages: PageReference[];
}

export type ToolReturnMetadata =
    | { summary: ItemSearchSummary }
    | { summary: AnnotationListSummary }
    | { summary: ReadPagesSummary };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** A reference from an object carrying `library_id` + `zotero_key`, or null. */
const referenceFrom = (value: unknown): ZoteroItemReference | null => {
    if (!isRecord(value)) return null;
    const { library_id, zotero_key, library_ref } = value;
    if (typeof library_id !== 'number' || typeof zotero_key !== 'string' || !zotero_key) return null;
    return {
        library_id,
        zotero_key,
        ...(typeof library_ref === 'string' && library_ref ? { library_ref } : {}),
    };
};

function itemSearchSummary(toolName: string, content: Record<string, unknown>): ItemSearchSummary | null {
    if (!Array.isArray(content.items)) return null;
    const items = content.items
        .map((row) => (isRecord(row) ? referenceFrom(row.item) : null))
        .filter((ref): ref is ZoteroItemReference => ref !== null);
    return { tool_name: toolName, result_count: items.length, items };
}

function annotationSummary(
    content: Record<string, unknown>,
    args: Record<string, unknown>
): AnnotationListSummary | null {
    if (!Array.isArray(content.annotations)) return null;
    const annotations: ZoteroItemReference[] = [];
    for (const row of content.annotations) {
        if (!isRecord(row) || typeof row.annotation_id !== 'string') continue;
        const ref = resolveObjectIdReference(row.annotation_id);
        if (!ref) continue;
        const libraryRef = ref.library_ref ?? (typeof row.library_ref === 'string' ? row.library_ref : undefined);
        annotations.push({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            ...(libraryRef ? { library_ref: libraryRef } : {}),
        });
    }
    const totalCount = typeof content.total_count === 'number' ? content.total_count : annotations.length;
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    return {
        tool_name: 'find_annotations',
        result_count: annotations.length,
        total_count: totalCount,
        has_more: offset + content.annotations.length < totalCount,
        annotations,
    };
}

function readPagesSummary(content: Record<string, unknown>): ReadPagesSummary | null {
    const attachment = referenceFrom(content.attachment);
    if (!attachment || !Array.isArray(content.pages)) return null;
    const pages: PageReference[] = [];
    for (const page of content.pages) {
        if (!isRecord(page) || typeof page.page_number !== 'number') continue;
        pages.push({ ...attachment, page_number: page.page_number });
    }
    return { tool_name: 'read_attachment', result_count: pages.length, pages };
}

/**
 * Metadata to attach to a successful tool return, derived from the handler
 * response (`content`) and the call's arguments.
 */
export function buildToolReturnMetadata(
    toolName: string,
    content: Record<string, unknown>,
    args: Record<string, unknown>
): ToolReturnMetadata | undefined {
    switch (toolName) {
        case 'item_search_by_metadata': {
            const summary = itemSearchSummary(toolName, content);
            return summary ? { summary } : undefined;
        }
        case 'find_annotations': {
            const summary = annotationSummary(content, args);
            return summary ? { summary } : undefined;
        }
        case 'read_attachment': {
            const summary = readPagesSummary(content);
            return summary ? { summary } : undefined;
        }
        default:
            return undefined;
    }
}
