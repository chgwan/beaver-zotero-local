import { describe, expect, it } from 'vitest';
import type { BeaverAgentPrompt } from '@beaver/agent-core/agents/types';
import type { MessageAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { renderUserPrompt, scopePromptToLibraries } from '@beaver/agent-local/run/userPrompt';

const SEARCHABLE = new Set([1, 2]);
const isSearchable = (id: number) => SEARCHABLE.has(id);

const item: MessageAttachment = {
    type: 'item',
    library_id: 1,
    library_ref: 'u',
    zotero_key: 'ITEMKEY1',
    item: { item_id: 'u-ITEMKEY1', title: 'Deep Learning', display_name: 'LeCun et al. 2015' },
};
const source: MessageAttachment = {
    type: 'source',
    library_id: 1,
    library_ref: 'u',
    zotero_key: 'PDFKEY01',
    include: 'fulltext',
    attachment: { attachment_id: 'u-PDFKEY01', title: 'Full Text PDF', content_kind: 'pdf', parent_item_id: 'u-ITEMKEY1' },
};
const note: MessageAttachment = { type: 'note', library_id: 2, library_ref: 'g42', zotero_key: 'NOTEKEY1', title: 'Reading notes' };
const annotation: MessageAttachment = {
    type: 'annotation',
    library_id: 1,
    library_ref: 'u',
    zotero_key: 'ANNOKEY1',
    parent_key: 'PDFKEY01',
    annotation_type: 'highlight',
    text: 'Representation learning matters.',
    comment: 'key claim',
    color: '#ffd400',
    page_label: '3',
    position: { page_index: 2, rects: [] },
    date_modified: '2026-01-01 00:00:00',
};
const excludedItem: MessageAttachment = {
    type: 'item',
    library_id: 9,
    zotero_key: 'SECRET01',
    item: { item_id: '9-SECRET01', title: 'Confidential Draft' },
};
const externalFile: MessageAttachment = {
    type: 'external_file',
    ext_key: 'EXTKEY01',
    filename: 'draft.pdf',
    content_kind: 'pdf',
    mime_type: 'application/pdf',
    file_size: 100,
};

describe('renderUserPrompt', () => {
    it('renders a plain message as its text unchanged', () => {
        expect(renderUserPrompt({ content: 'What is in my library?' })).toBe('What is in my library?');
    });

    it('adds the prompt of each invoked action', () => {
        const text = renderUserPrompt({
            content: '/summarize',
            actions: [{ command: 'summarize', action_id: 'a1', title: 'Summarize', prompt: 'Summarize the attached paper in five bullets.' }],
        });
        expect(text).toContain('/summarize');
        expect(text).toContain('Summarize the attached paper in five bullets.');
    });

    it('skips an action whose definition no longer exists', () => {
        expect(renderUserPrompt({ content: '/gone', actions: [{ command: 'gone', action_id: 'x', prompt: null }] })).toBe('/gone');
    });

    it('lists attached items, attachments, notes and annotations by the ids the tools accept', () => {
        const text = renderUserPrompt({ content: 'Explain', attachments: [item, source, note, annotation] });
        expect(text).toContain('Item u-ITEMKEY1 "LeCun et al. 2015"');
        expect(text).toContain('Attachment u-PDFKEY01 "Full Text PDF" (pdf) of item u-ITEMKEY1');
        expect(text).toContain('Note g42-NOTEKEY1 "Reading notes"');
        expect(text).toContain('Annotation u-ANNOKEY1 (highlight, page 3) on attachment u-PDFKEY01: "Representation learning matters."');
        expect(text).toContain('comment: "key claim"');
        expect(text).toMatch(/read_attachment/);
    });

    it('says an attached external file cannot be read', () => {
        const text = renderUserPrompt({ content: 'Look', attachments: [externalFile] });
        expect(text).toContain('"draft.pdf"');
        expect(text).toContain('not available');
    });

    it('describes the reader state: open attachment, page and selected text', () => {
        const text = renderUserPrompt({
            content: 'What does this mean?',
            application_state: {
                current_view: 'file_reader',
                reader_state: {
                    library_id: 1,
                    library_ref: 'u',
                    zotero_key: 'PDFKEY01',
                    current_page: 7,
                    text_selection: { text: 'the vanishing gradient', page: 7 },
                },
            },
        });
        expect(text).toContain('attachment u-PDFKEY01, on page 7');
        expect(text).toContain('Selected text (page 7): "the vanishing gradient"');
    });

    it('lists selected collections and a bounded number of selected items', () => {
        const selection = Array.from({ length: 25 }, (_, i) => ({ library_id: 1, library_ref: 'u', zotero_key: `KEY${String(i).padStart(5, '0')}` }));
        const text = renderUserPrompt({
            content: 'Summarize my selection',
            application_state: {
                current_view: 'library',
                current_collections: [{ library_id: 1, library_ref: 'u', collection_key: 'COLLKEY1', name: 'Thesis' }],
                library_selection: selection,
            },
        });
        expect(text).toContain('collection "Thesis" (key COLLKEY1 in library u)');
        expect(text).toContain('u-KEY00000');
        expect(text).not.toContain('u-KEY00024');
        expect(text).toContain('and 5 more');
    });
});

describe('scopePromptToLibraries', () => {
    const prompt: BeaverAgentPrompt = {
        content: 'Compare these',
        custom_instructions: 'Be brief.',
        attachments: [item, excludedItem, externalFile, { type: 'table', reference: { key: 't' } as any }],
        application_state: {
            current_view: 'file_reader',
            reader_state: { library_id: 9, zotero_key: 'SECRETPDF', current_page: 1 },
            note_state: { library_id: 9, zotero_key: 'SECRETNOTE', title: 'Secret note' },
            current_library: { library_id: 9, name: 'Secret Group', is_group: true, read_only: false, is_synced: false },
            current_collections: [
                { library_id: 9, collection_key: 'SECRETCO', name: 'Secret collection' },
                { library_id: 1, collection_key: 'COLLKEY1', name: 'Thesis' },
            ],
            library_selection: [
                { library_id: 9, zotero_key: 'SECRET02' },
                { library_id: 1, zotero_key: 'ITEMKEY1' },
                { library_id: 0, library_ref: 'g77', zotero_key: 'UNRESOLV' },
            ],
            libraries: [{ library_id: 9, name: 'Secret Group' } as any],
        },
        filters: { libraries: [{ library_id: 9, name: 'Secret Group' } as any] },
        tool_requests: [{ function: 'search_external_references', parameters: {} } as any],
    };

    it('drops attachments and application state from libraries outside the searchable set', () => {
        const scoped = scopePromptToLibraries(prompt, isSearchable);
        const rendered = renderUserPrompt(scoped);
        expect(JSON.stringify(scoped)).not.toMatch(/SECRET|Secret|UNRESOLV/);
        expect(rendered).not.toMatch(/SECRET|Secret/);
        expect(scoped.attachments).toEqual([item, externalFile]);
        expect(scoped.application_state?.reader_state).toBeUndefined();
        expect(scoped.application_state?.note_state).toBeUndefined();
        expect(scoped.application_state?.current_collections?.map((c) => c.collection_key)).toEqual(['COLLKEY1']);
        expect(scoped.application_state?.library_selection?.map((i) => i.zotero_key)).toEqual(['ITEMKEY1']);
    });

    it('keeps only the fields the renderer reads', () => {
        const scoped = scopePromptToLibraries(prompt, isSearchable);
        expect(Object.keys(scoped).sort()).toEqual(['application_state', 'attachments', 'content', 'custom_instructions']);
        expect(scoped.application_state?.current_library).toBeUndefined();
        expect(scoped.application_state?.libraries).toBeUndefined();
    });

    it('keeps everything renderable when every library is searchable', () => {
        const scoped = scopePromptToLibraries(
            {
                content: 'x',
                attachments: [item, note],
                application_state: {
                    current_view: 'file_reader',
                    reader_state: { library_id: 1, zotero_key: 'PDFKEY01', current_page: 2 },
                },
            },
            isSearchable
        );
        expect(scoped.attachments).toEqual([item, note]);
        expect(scoped.application_state?.reader_state?.zotero_key).toBe('PDFKEY01');
    });

    it('fails closed when nothing is searchable', () => {
        const scoped = scopePromptToLibraries(prompt, () => false);
        expect(scoped.attachments).toEqual([externalFile]);
        expect(renderUserPrompt(scoped)).not.toMatch(/SECRET|Secret|ITEMKEY1|COLLKEY1/);
    });
});
