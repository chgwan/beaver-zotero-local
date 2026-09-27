import { describe, it, expect } from 'vitest';
import { buildToolReturnMetadata } from '@beaver/agent-local/run/toolReturnMetadata';
import {
    isGetAnnotationsResult,
    isItemSearchResult,
    extractGetAnnotationsData,
    extractItemSearchData,
} from '@beaver/agent-core/run-state/toolResultTypes';

describe('buildToolReturnMetadata', () => {
    it('builds the item summary a metadata search card renders from', () => {
        const content = {
            type: 'item_search_by_metadata',
            request_id: 'r',
            items: [
                { item: { library_id: 1, zotero_key: 'AAA', library_ref: 'u', item_type: 'book' }, attachments: [] },
                { item: { library_id: 7, zotero_key: 'BBB', item_type: 'journalArticle' }, attachments: [] },
            ],
        };
        const metadata = buildToolReturnMetadata('item_search_by_metadata', content, {});
        expect(metadata).toEqual({
            summary: {
                tool_name: 'item_search_by_metadata',
                result_count: 2,
                items: [
                    { library_id: 1, zotero_key: 'AAA', library_ref: 'u' },
                    { library_id: 7, zotero_key: 'BBB' },
                ],
            },
        });
        expect(isItemSearchResult('item_search_by_metadata', content, metadata)).toBe(true);
        expect(extractItemSearchData(content, metadata)?.items).toHaveLength(2);
    });

    it('skips metadata search rows without an item reference', () => {
        const content = { items: [{ item: { zotero_key: 'AAA' } }, null, { item: { library_id: 1, zotero_key: 'B' } }] };
        const metadata = buildToolReturnMetadata('item_search_by_metadata', content, {});
        expect(metadata?.summary.items).toEqual([{ library_id: 1, zotero_key: 'B' }]);
        expect(metadata?.summary.result_count).toBe(1);
    });

    it('builds the annotation summary an annotation card renders from', () => {
        const content = {
            type: 'find_annotations',
            request_id: 'r',
            annotations: [
                { result_type: 'annotation', annotation_id: '1-ANN1' },
                { result_type: 'annotation', annotation_id: 'g42-ANN2', library_ref: 'g42' },
            ],
            total_count: 5,
        };
        const metadata = buildToolReturnMetadata('find_annotations', content, { offset: 0 });
        expect(metadata?.summary).toMatchObject({
            tool_name: 'find_annotations',
            result_count: 2,
            total_count: 5,
            has_more: true,
        });
        expect(metadata?.summary.annotations[0]).toMatchObject({ library_id: 1, zotero_key: 'ANN1' });
        expect(metadata?.summary.annotations[1]).toMatchObject({ zotero_key: 'ANN2', library_ref: 'g42' });
        expect(isGetAnnotationsResult('find_annotations', content, metadata)).toBe(true);
        expect(extractGetAnnotationsData(content, metadata)?.totalCount).toBe(5);
    });

    it('reports no further annotation page once the last one is returned', () => {
        const content = {
            annotations: [{ annotation_id: '1-ANN1' }, { annotation_id: '1-ANN2' }],
            total_count: 4,
        };
        expect(buildToolReturnMetadata('find_annotations', content, { offset: 2 })?.summary.has_more).toBe(false);
    });

    it('skips annotation rows whose id does not parse', () => {
        const content = { annotations: [{ annotation_id: 'nonsense' }, { annotation_id: '1-OK' }], total_count: 2 };
        const metadata = buildToolReturnMetadata('find_annotations', content, {});
        expect(metadata?.summary.annotations).toHaveLength(1);
    });

    it('adds nothing for tools whose cards render from content alone', () => {
        for (const tool of ['zotero_search', 'list_items', 'get_metadata', 'list_collections', 'list_tags', 'read_note', 'list_libraries']) {
            expect(buildToolReturnMetadata(tool, { items: [] }, {})).toBeUndefined();
        }
    });

    it('adds nothing when the content does not have the expected shape', () => {
        expect(buildToolReturnMetadata('item_search_by_metadata', { items: 'x' }, {})).toBeUndefined();
        expect(buildToolReturnMetadata('find_annotations', { annotations: null }, {})).toBeUndefined();
    });
});
