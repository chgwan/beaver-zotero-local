/**
 * Page-addressed projection of an extracted document, shared by the tools that
 * read an attachment page by page (the MCP `read_attachment` tool and the
 * in-plugin agent's attachment reader).
 *
 * PDF pages keep their physical 1-based index. EPUB and snapshot items carry a
 * stamped page number, so grouping by it keeps these reads aligned with the
 * hosted agent's read pagination. React-free and Zotero-free.
 */

import type { WSZoteroDocumentResponse } from '@beaver/agent-core/protocol/agentProtocol';

export type ExtractedDocumentResult = NonNullable<WSZoteroDocumentResponse['result']>;

/** One page of a read: markdown text, or located passages when requested. */
export interface AttachmentReadPage {
    pageNumber: number;
    markdown?: string;
    passages?: Record<string, unknown>[];
}

export interface AttachmentReadDocument {
    pageCount: number;
    pages: AttachmentReadPage[];
}

/**
 * Project an extracted document into pages. Markdown pages need a markdown
 * extraction and located passages a structured one; `null` means the result
 * cannot be read in the requested form (including plain-text documents,
 * which have lines rather than pages).
 */
export function documentToReadPages(
    result: ExtractedDocumentResult,
    includeLocations: boolean,
): AttachmentReadDocument | null {
    if (result.content_kind === 'epub' || result.content_kind === 'snapshot') {
        return domDocumentToPages(result, includeLocations);
    } else if (result.content_kind !== 'text') {
        if (result.mode === 'markdown' && !includeLocations) {
            return {
                pageCount: result.document.pageCount,
                pages: result.document.pages.map(page => ({ pageNumber: page.index + 1, markdown: page.markdown ?? '' })),
            };
        } else if (result.mode === 'structured' && includeLocations) {
            return {
                pageCount: result.document.pageCount,
                pages: result.document.pages.map(page => ({
                    pageNumber: page.index + 1,
                    passages: page.items.flatMap(item => {
                        const parts = 'sentences' in item && item.sentences?.length
                            ? item.sentences.map(sentence => ({ text: sentence.text, boxes: sentence.bboxes }))
                            : 'text' in item ? [{ text: item.text, boxes: [item.bbox] }] : [];
                        return parts.filter(part => part.boxes.length > 0).map(part => ({
                            text: part.text,
                            page_locations: [{
                                page_idx: page.index,
                                ...(page.label ? { page_label: page.label } : {}),
                                boxes: part.boxes.map(([l, t, r, b]) => ({ l, t, r, b, coord_origin: 't' })),
                            }],
                            ...(page.label ? { page_label: page.label } : {}),
                            note_position: {
                                page_index: page.index, side: 'right', coord_origin: 't',
                                x: part.boxes[0][2], y: (part.boxes[0][1] + part.boxes[0][3]) / 2,
                            },
                        }));
                    }),
                })),
            };
        }
    }
    return null;
}

type DomReadItem = {
    kind: string;
    sectionIndex: number;
    order: number;
    text?: string;
    level?: number;
    sentences?: Array<{ text: string }>;
    pageNumber?: number;
    sectionHref?: string;
    anchorId?: string;
};

function domDocumentToPages(
    document: Extract<NonNullable<WSZoteroDocumentResponse['result']>, { content_kind: 'epub' | 'snapshot' }>,
    includeLocations: boolean,
): AttachmentReadDocument {
    const pagesByNumber = new Map<number, DomReadItem[]>();
    const orderedItems = document.sections
        .slice()
        .sort((a, b) => a.index - b.index)
        .flatMap((section) => section.items
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((item) => ({
                ...item,
                sectionHref: section.rawHref,
                sectionIndex: section.index,
                pageNumber: item.pageNumber ?? section.index + 1,
            })));

    for (const item of orderedItems) {
        const pageNumber = item.pageNumber ?? 1;
        const pageItems = pagesByNumber.get(pageNumber);
        if (pageItems) {
            pageItems.push(item);
        } else {
            pagesByNumber.set(pageNumber, [item]);
        }
    }

    // An item is stamped with the page of its first text node, so a single item
    // longer than the synthetic page interval (a long <p>/<pre> or a linearized
    // table) spans interior pages that no item is stamped to.
    const observedPageCount = Math.max(0, ...Array.from(pagesByNumber.keys()));
    const pageCount = Math.max(document.pageCount ?? observedPageCount, observedPageCount);
    const pages: AttachmentReadPage[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        const items = pagesByNumber.get(pageNumber) ?? [];
        pages.push({
            pageNumber,
            ...(includeLocations ? {
                passages: items.filter(item => item.kind !== 'picture').flatMap(item => {
                    const texts = item.sentences?.length ? item.sentences.map(sentence => sentence.text) : [item.text ?? ''];
                    return texts.filter(text => text.trim()).map(text => ({
                        text,
                        ...(document.content_kind === 'epub' ? { section_href: item.sectionHref, section_ordinal: item.sectionIndex + 1 } : {}),
                        ...(item.anchorId ? { anchor_id: item.anchorId } : {}),
                    }));
                }),
            } : {
                markdown: items.map(domItemToMarkdown).filter(text => text.length > 0).join('\n\n'),
            }),
        });
    }
    return { pageCount, pages };
}

function domItemToMarkdown(item: { kind: string; text?: string; level?: number; sentences?: Array<{ text: string }> }): string {
    const text = normalizeMarkdownText(
        item.text ?? item.sentences?.map((sentence) => sentence.text).join(' ') ?? '',
    );
    if (!text) return '';

    switch (item.kind) {
        case 'section_header': {
            const level = Math.min(Math.max(item.level ?? 2, 1), 6);
            return `${'#'.repeat(level)} ${text}`;
        }
        case 'list_item':
            return `- ${text}`;
        case 'caption':
            return `_${text}_`;
        case 'footnote':
            return `[^] ${text}`;
        default:
            return text;
    }
}

function normalizeMarkdownText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}
