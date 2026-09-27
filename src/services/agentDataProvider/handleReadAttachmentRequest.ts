/**
 * Page-window attachment reader for the in-plugin agent (`read_attachment`).
 *
 * Reads the document through `handleZoteroDocumentRequest` in object mode, so
 * extraction runs on this computer (MuPDF worker, EPUB/snapshot parsers, the
 * local document cache) and the extracted document is never serialized for a
 * remote consumer. The result is a bounded window of pages: at most the
 * requested range, and at most `max_chars` characters of page text.
 *
 * Reachable from the webpack bundle, so plugin state is read through
 * `Zotero.Beaver`, never the bare `addon` global.
 */

import type { AgentDataRequestEntry } from '@beaver/agent-core/transport/agentDataDispatch';
import type { ItemStub, ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { handleZoteroDocumentRequest } from './handleZoteroDocumentRequest';
import { checkLibraryExcluded } from './utils';
import { documentToReadPages } from '../documentExtraction/attachmentReadPages';
import {
    libraryRefForLibraryID,
    modelObjectIdFromReference,
    resolveObjectId,
    UNRESOLVED_LIBRARY_ID,
} from '../../utils/libraryIdentity';

export interface ReadAttachmentRequest {
    event: 'read_attachment_request';
    request_id: string;
    /** Model-facing attachment (or parent item) id, e.g. "u-ABC12345". */
    attachment_id: string;
    /** First page to return, 1-indexed. */
    start_page: number;
    /** Last page to return, inclusive. The caller caps the range. */
    end_page: number;
    /** Most characters of page text to return. */
    max_chars: number;
}

export interface ReadAttachmentPage {
    page_number: number;
    text: string;
    /** The page alone exceeded the text budget and was cut at it. */
    truncated?: true;
}

export interface ReadAttachmentResponse {
    type: 'read_attachment';
    request_id: string;
    attachment_id?: string;
    /** The attachment actually read (a parent item id resolves to one of its files). */
    attachment?: ZoteroItemReference;
    content_kind?: string;
    parent_item?: ItemStub;
    total_pages?: number;
    start_page?: number;
    /** Last page returned. */
    end_page?: number;
    pages?: ReadAttachmentPage[];
    /** First page not returned, when the document continues past this window. */
    next_start_page?: number;
    error?: string;
    error_code?: string;
}

export async function handleReadAttachmentRequest(
    request: ReadAttachmentRequest,
): Promise<ReadAttachmentResponse> {
    const { request_id, attachment_id, start_page: startPage, end_page: endPage, max_chars: maxChars } = request;
    const failure = (error: string, error_code: string): ReadAttachmentResponse => ({
        type: 'read_attachment',
        request_id,
        error,
        error_code,
    });

    const ref = resolveObjectId(attachment_id);
    if (!ref) {
        return failure(
            `Invalid attachment_id "${attachment_id}". Expected <library>-<zotero_key>, e.g. "u-ABC12345".`,
            'invalid_format',
        );
    }
    if (ref.library_id === UNRESOLVED_LIBRARY_ID) {
        return failure(`The library for attachment "${attachment_id}" is not available on this computer.`, 'library_unavailable');
    }
    // The document handler enforces this as well; checking here keeps the
    // boundary independent of how that handler resolves the reference.
    const excluded = checkLibraryExcluded(ref.library_id);
    if (excluded) return failure(excluded.message, 'library_excluded');

    const response = await handleZoteroDocumentRequest({
        event: 'zotero_document_request',
        request_id,
        attachment: {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            library_ref: ref.library_ref ?? libraryRefForLibraryID(ref.library_id) ?? undefined,
        },
        mode: 'markdown',
    });
    if (response.error || !response.result) {
        return failure(response.error ?? 'Failed to read attachment.', response.error_code ?? 'extraction_failed');
    }

    const document = documentToReadPages(response.result, false);
    if (!document) {
        return failure(
            `Attachment "${attachment_id}" is a ${response.result.content_kind ?? 'non-paginated'} document, ` +
                'which cannot be read by page.',
            'unsupported_type',
        );
    }

    const totalPages = document.pageCount;
    if (Number.isInteger(totalPages) && startPage > totalPages) {
        return failure(
            `Requested start_page ${startPage} is out of range; the attachment has ${totalPages} pages.`,
            'invalid_page_range',
        );
    }
    const inRange = document.pages.filter((page) => page.pageNumber >= startPage && page.pageNumber <= endPage);
    if (inRange.length === 0) {
        return failure(`Pages ${startPage}-${endPage} contain no extractable text.`, 'invalid_page_range');
    }

    const pages: ReadAttachmentPage[] = [];
    let budget = maxChars;
    for (const page of inRange) {
        const text = page.markdown ?? '';
        if (text.length <= budget) {
            pages.push({ page_number: page.pageNumber, text });
            budget -= text.length;
            continue;
        }
        // Always return something: a first page larger than the whole budget
        // is cut rather than skipped, so progressive reading cannot stall.
        if (pages.length === 0) {
            pages.push({ page_number: page.pageNumber, text: text.slice(0, budget), truncated: true });
        }
        break;
    }

    const lastReturned = pages[pages.length - 1].page_number;
    const lastPage = Number.isInteger(totalPages) ? totalPages : document.pages[document.pages.length - 1].pageNumber;
    const attachment = response.resolved_attachment ?? {
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        ...(ref.library_ref ? { library_ref: ref.library_ref } : {}),
    };

    return {
        type: 'read_attachment',
        request_id,
        attachment_id: modelObjectIdFromReference(attachment),
        attachment,
        content_kind: response.result.content_kind ?? response.content_kind,
        ...(response.parent_item ? { parent_item: response.parent_item } : {}),
        total_pages: totalPages,
        start_page: startPage,
        end_page: lastReturned,
        pages,
        ...(lastReturned < lastPage ? { next_start_page: lastReturned + 1 } : {}),
    };
}

/** Data-provider entry for `read_attachment_request`, registered by the local agent. */
export const readAttachmentEntry: AgentDataRequestEntry & {
    errorResponse: (event: ReadAttachmentRequest, err: unknown) => ReadAttachmentResponse;
} = {
    handle: (event: ReadAttachmentRequest) => handleReadAttachmentRequest(event) as Promise<Record<string, any>>,
    errorResponse: (event: ReadAttachmentRequest, err: unknown) => ({
        type: 'read_attachment',
        request_id: event.request_id,
        error: String(err),
        error_code: 'extraction_failed',
    }),
};
