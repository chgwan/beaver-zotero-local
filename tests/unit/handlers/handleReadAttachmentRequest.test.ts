/**
 * The in-plugin agent's attachment reader: resolves a model attachment id,
 * reads the document through the object-mode document handler, and returns a
 * bounded page window. The library-exclusion boundary must hold before any
 * item lookup or extraction.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchableLibraryIds: [1] as number[],
    // When set, replaces the document handler; otherwise the real one runs.
    documentImpl: null as null | ((...args: any[]) => Promise<any>),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => mocks.searchableLibraryIds), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));
vi.mock('../../../src/services/agentDataProvider/handleZoteroDocumentRequest', async () => {
    const actual = await vi.importActual<
        typeof import('../../../src/services/agentDataProvider/handleZoteroDocumentRequest')
    >('../../../src/services/agentDataProvider/handleZoteroDocumentRequest');
    return {
        ...actual,
        handleZoteroDocumentRequest: vi.fn((...args: any[]) =>
            mocks.documentImpl
                ? mocks.documentImpl(...args)
                : (actual.handleZoteroDocumentRequest as any)(...args),
        ),
    };
});

import {
    handleReadAttachmentRequest,
    readAttachmentEntry,
} from '../../../src/services/agentDataProvider/handleReadAttachmentRequest';
import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { buildToolCatalog } from '@beaver/agent-local/tools/toolCatalog';

const request = (overrides: Record<string, unknown> = {}) => ({
    event: 'read_attachment_request' as const,
    request_id: 'req-1',
    attachment_id: '1-ABC12345',
    start_page: 1,
    end_page: 30,
    max_chars: 60000,
    ...overrides,
});

/** An object-mode markdown PDF result with one page per given text. */
const pdfResponse = (texts: string[], pageCount = texts.length) => ({
    type: 'zotero_document',
    request_id: 'doc',
    resolved_attachment: { library_id: 1, zotero_key: 'ABC12345', library_ref: 'u' },
    content_kind: 'pdf',
    parent_item: { item_id: 'u-PARENT01', title: 'A Paper' },
    result: {
        content_kind: 'pdf',
        mode: 'markdown',
        document: {
            pageCount,
            pages: texts.map((markdown, index) => ({ index, markdown })),
        },
    },
});

describe('handleReadAttachmentRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.searchableLibraryIds = [1];
        mocks.documentImpl = null;
        Zotero.Beaver = {
            ...Zotero.Beaver,
            libraryScopeInitialized: true,
            get searchableLibraryIds() {
                return mocks.searchableLibraryIds;
            },
        } as any;
        (globalThis as any).Zotero.Libraries = {
            userLibraryID: 1,
            get: vi.fn((libraryId: number) =>
                libraryId === 1 || libraryId === 5 ? { libraryID: libraryId, name: `Library ${libraryId}` } : null,
            ),
        };
        (globalThis as any).Zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn(() => false),
            getGroupIDFromLibraryID: vi.fn(() => false),
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Utilities = {
            ...(globalThis as any).Zotero.Utilities,
            isValidObjectKey: (key: string) => /^[A-Z0-9]{8}$/.test(key),
        };
    });

    describe('library exclusion', () => {
        it('refuses an attachment in an excluded library before any item lookup', async () => {
            const response = await handleReadAttachmentRequest(request({ attachment_id: '5-ABC12345' }));

            expect(response).toMatchObject({
                type: 'read_attachment',
                request_id: 'req-1',
                error_code: 'library_excluded',
            });
            expect(response.pages).toBeUndefined();
            expect(handleZoteroDocumentRequest).not.toHaveBeenCalled();
            expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        });

        it('is refused by the document handler itself as well', async () => {
            const response = await handleZoteroDocumentRequest({
                event: 'zotero_document_request',
                request_id: 'doc',
                attachment: { library_id: 5, zotero_key: 'ABC12345' },
                mode: 'markdown',
            });

            expect(response.error_code).toBe('library_excluded');
            expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        });

        it('reaches the model as a non-retryable tool failure', async () => {
            const catalog = buildToolCatalog({
                provider: { read_attachment_request: readAttachmentEntry },
                searchableLibraryIds: [1],
            });

            const result = await catalog.execute(
                'read_attachment',
                { attachment_id: '5-ABC12345' },
                new AbortController().signal,
            );

            expect(result).toMatchObject({ ok: false, retryable: false });
            expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        });
    });

    it('reads the requested page window from an object-mode markdown extraction', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue(pdfResponse(['one', 'two', 'three', 'four', 'five']));

        const response = await handleReadAttachmentRequest(request({ start_page: 2, end_page: 3 }));

        const [documentRequest, options] = vi.mocked(handleZoteroDocumentRequest).mock.calls[0] as any[];
        expect(documentRequest).toMatchObject({
            event: 'zotero_document_request',
            attachment: { library_id: 1, zotero_key: 'ABC12345' },
            mode: 'markdown',
        });
        expect(options?.responseMode).not.toBe('websocket');
        expect(response).toEqual({
            type: 'read_attachment',
            request_id: 'req-1',
            attachment_id: 'u-ABC12345',
            attachment: { library_id: 1, zotero_key: 'ABC12345', library_ref: 'u' },
            content_kind: 'pdf',
            parent_item: { item_id: 'u-PARENT01', title: 'A Paper' },
            total_pages: 5,
            start_page: 2,
            end_page: 3,
            pages: [
                { page_number: 2, text: 'two' },
                { page_number: 3, text: 'three' },
            ],
            next_start_page: 4,
        });
    });

    it('omits next_start_page once the last page is read', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue(pdfResponse(['one', 'two']));

        const response = await handleReadAttachmentRequest(request());

        expect(response.pages).toHaveLength(2);
        expect(response.end_page).toBe(2);
        expect(response.next_start_page).toBeUndefined();
    });

    it('stops at the text budget and points at the next unread page', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue(pdfResponse(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]));

        const response = await handleReadAttachmentRequest(request({ max_chars: 100 }));

        expect(response.pages?.map((page) => page.page_number)).toEqual([1, 2]);
        expect(response.end_page).toBe(2);
        expect(response.next_start_page).toBe(3);
    });

    it('cuts a single page that alone exceeds the budget and says so', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue(pdfResponse(['x'.repeat(500), 'y']));

        const response = await handleReadAttachmentRequest(request({ max_chars: 100 }));

        expect(response.pages).toEqual([{ page_number: 1, text: 'x'.repeat(100), truncated: true }]);
        expect(response.next_start_page).toBe(2);
    });

    it('rejects a start page past the end of the document', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue(pdfResponse(['one', 'two']));

        const response = await handleReadAttachmentRequest(request({ start_page: 9, end_page: 10 }));

        expect(response.error).toContain('out of range');
        expect(response.error).toContain('2 pages');
        expect(response.error_code).toBe('invalid_page_range');
    });

    it('passes a document error through with its code', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue({
            type: 'zotero_document',
            request_id: 'doc',
            error: 'Attachment 1-ABC12345 file is missing.',
            error_code: 'file_missing',
        });

        const response = await handleReadAttachmentRequest(request());

        expect(response).toMatchObject({
            error: 'Attachment 1-ABC12345 file is missing.',
            error_code: 'file_missing',
        });
    });

    it('reports a plain-text document as unsupported', async () => {
        mocks.documentImpl = vi.fn().mockResolvedValue({
            type: 'zotero_document',
            request_id: 'doc',
            resolved_attachment: { library_id: 1, zotero_key: 'ABC12345' },
            content_kind: 'text',
            result: { content_kind: 'text', mode: 'text', document: { lineCount: 1, lines: [] } },
        });

        const response = await handleReadAttachmentRequest(request());

        expect(response.error_code).toBe('unsupported_type');
    });

    it('rejects a malformed attachment id without reading', async () => {
        const response = await handleReadAttachmentRequest(request({ attachment_id: 'not-an-id!' }));

        expect(response.error_code).toBe('invalid_format');
        expect(handleZoteroDocumentRequest).not.toHaveBeenCalled();
    });

    it('rejects a portable id whose library is not on this computer', async () => {
        const response = await handleReadAttachmentRequest(request({ attachment_id: 'g999-ABC12345' }));

        expect(response.error_code).toBe('library_unavailable');
        expect(handleZoteroDocumentRequest).not.toHaveBeenCalled();
    });

    it('answers a rejection through the entry error response', () => {
        expect(readAttachmentEntry.errorResponse(request(), new Error('boom'))).toEqual({
            type: 'read_attachment',
            request_id: 'req-1',
            error: 'Error: boom',
            error_code: 'extraction_failed',
        });
    });
});
