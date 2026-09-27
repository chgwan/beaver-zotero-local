/**
 * The user turn a local run sends to the model.
 *
 * The hosted backend expands a `BeaverAgentPrompt` into the model's context
 * server-side. Local mode has no backend, so this module does the same in the
 * plugin: the message text, the prompt of each invoked action, the objects the
 * user attached (by the ids the tools accept), and what the user has open.
 *
 * Two steps, kept separate so the access boundary is explicit:
 *  - `scopePromptToLibraries` drops everything from a library outside the
 *    searchable set, and everything this module does not render. The caller
 *    runs it with the host's library scope before the prompt reaches the loop.
 *  - `renderUserPrompt` turns a scoped prompt into text. It never checks scope
 *    itself.
 */

import type { BeaverAgentPrompt, PromptAction } from '@beaver/agent-core/agents/types';
import type { ApplicationStateInput } from '@beaver/agent-core/protocol/agentProtocol';
import type { MessageAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { modelObjectIdFromReference } from '@beaver/agent-core/identity/libraryRef';

/** Longest excerpt of annotation or selected text quoted into the prompt. */
export const PROMPT_EXCERPT_MAX_CHARS = 1_000;

/** Most selected library items listed by id. */
export const PROMPT_SELECTION_MAX_ITEMS = 20;

type LibraryCheck = (libraryId: number) => boolean;

/**
 * The prompt restricted to what may reach the model: attachments and
 * application state from searchable libraries only, and only the fields
 * `renderUserPrompt` reads. Search filters, tool requests and every other
 * field are dropped, so nothing unrendered can carry library data along.
 * A reference whose library is unknown (id 0, unresolved) counts as not
 * searchable.
 */
export function scopePromptToLibraries(prompt: BeaverAgentPrompt, isSearchable: LibraryCheck): BeaverAgentPrompt {
    const allowed = (libraryId: unknown) => typeof libraryId === 'number' && libraryId > 0 && isSearchable(libraryId);

    const attachments = (prompt.attachments ?? []).filter((attachment) => {
        if (attachment.type === 'external_file') return true;
        if (attachment.type === 'table') return false;
        return allowed(attachment.library_id);
    });

    const scoped: BeaverAgentPrompt = { content: prompt.content ?? '' };
    if (prompt.custom_instructions !== undefined) scoped.custom_instructions = prompt.custom_instructions;
    if (prompt.actions?.length) scoped.actions = prompt.actions;
    if (attachments.length > 0) scoped.attachments = attachments;

    const state = prompt.application_state;
    if (state) {
        const scopedState: ApplicationStateInput = { current_view: state.current_view };
        if (state.reader_state && allowed(state.reader_state.library_id)) {
            const { library_id, library_ref, zotero_key, current_page, content_kind, text_selection } = state.reader_state;
            scopedState.reader_state = { library_id, library_ref, zotero_key, current_page, content_kind, text_selection };
        }
        if (state.note_state && allowed(state.note_state.library_id)) {
            const { library_id, library_ref, zotero_key, title } = state.note_state;
            scopedState.note_state = { library_id, library_ref, zotero_key, title };
        }
        const collections = (state.current_collections ?? (state.current_collection ? [state.current_collection] : []))
            .filter((collection) => allowed(collection.library_id))
            .map(({ library_id, library_ref, collection_key, name }) => ({ library_id, library_ref, collection_key, name }));
        if (collections.length > 0) scopedState.current_collections = collections;
        const selection = (state.library_selection ?? [])
            .filter((item) => allowed(item.library_id))
            .map(({ library_id, library_ref, zotero_key }) => ({ library_id, library_ref, zotero_key }));
        if (selection.length > 0) scopedState.library_selection = selection;
        scoped.application_state = scopedState;
    }

    return scoped;
}

const excerpt = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PROMPT_EXCERPT_MAX_CHARS ? `${flat.slice(0, PROMPT_EXCERPT_MAX_CHARS)}…` : flat;
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const quoted = (text: string | null | undefined): string => (text ? ` "${excerpt(text)}"` : '');

/** The id the tools accept for an object `key` in `ref`'s library. */
const idFor = (ref: { library_id: number; library_ref?: string | null }, key: string): string =>
    modelObjectIdFromReference({ library_id: ref.library_id, library_ref: ref.library_ref, zotero_key: key });

/** A collection as the tools accept it: by key, within its library. */
const describeCollection = (
    ref: { library_id: number; library_ref?: string | null },
    key: string,
    name: string | null | undefined
): string => {
    const id = idFor(ref, key);
    const library = id.slice(0, id.length - key.length - 1);
    return `collection${quoted(name)} (key ${key} in library ${library})`;
};

function describeAttachment(attachment: MessageAttachment): string | null {
    switch (attachment.type) {
        case 'item': {
            const label = attachment.item?.display_name ?? attachment.item?.title;
            return `- Item ${idFor(attachment, attachment.zotero_key)}${quoted(label)}`;
        }
        case 'source': {
            const stub = attachment.attachment;
            const parent = attachment.parent_item?.item_id ?? stub?.parent_item_id;
            const label = stub?.title ?? stub?.filename;
            return (
                `- Attachment ${idFor(attachment, attachment.zotero_key)}${quoted(label)}` +
                (stub?.content_kind ? ` (${stub.content_kind})` : '') +
                (parent ? ` of item ${parent}` : '')
            );
        }
        case 'note':
            return `- Note ${idFor(attachment, attachment.zotero_key)}${quoted(attachment.title)}`;
        case 'annotation': {
            const page = attachment.page_label ? `, page ${attachment.page_label}` : '';
            const comment = attachment.comment ? ` — comment:${quoted(attachment.comment)}` : '';
            return (
                `- Annotation ${idFor(attachment, attachment.zotero_key)} (${attachment.annotation_type}${page}) ` +
                `on attachment ${idFor(attachment, attachment.parent_key)}:${quoted(attachment.text) || ' (no text)'}${comment}`
            );
        }
        case 'collection':
            return `- ${capitalize(describeCollection(attachment, attachment.zotero_key, attachment.name))}`;
        case 'external_file':
            return (
                `- File "${attachment.filename}" (${attachment.content_kind}) attached from the user's computer; ` +
                'its content is not available to you here'
            );
        default:
            return null;
    }
}

function describeActions(actions: readonly PromptAction[]): string[] {
    const lines: string[] = [];
    for (const action of actions) {
        const prompt = action.prompt?.trim();
        if (!prompt) continue;
        const title = action.title ? ` (${action.title})` : '';
        lines.push(`/${action.command}${title}:`, prompt, '');
    }
    if (lines.length === 0) return [];
    lines.pop();
    return ['The message invokes these saved actions; each /command stands for these instructions:', ...lines];
}

function describeState(state: ApplicationStateInput): string[] {
    const lines: string[] = [];
    const reader = state.reader_state;
    if (reader) {
        const page = reader.current_page ? `, on page ${reader.current_page}` : '';
        lines.push(`- Open in the reader: attachment ${idFor(reader, reader.zotero_key)}${page}`);
        const selection = reader.text_selection;
        if (selection?.text) {
            const selectionPage = selection.page ? ` (page ${selection.page})` : '';
            lines.push(`- Selected text${selectionPage}:${quoted(selection.text)}`);
        }
    }
    const note = state.note_state;
    if (note) {
        lines.push(`- Open in the note editor: note ${idFor(note, note.zotero_key)}${quoted(note.title)}`);
    }
    for (const collection of state.current_collections ?? []) {
        lines.push(`- Selected ${describeCollection(collection, collection.collection_key, collection.name)}`);
    }
    const selection = state.library_selection ?? [];
    if (selection.length > 0) {
        const ids = selection.slice(0, PROMPT_SELECTION_MAX_ITEMS).map((item) => idFor(item, item.zotero_key));
        const more = selection.length > ids.length ? ` and ${selection.length - ids.length} more` : '';
        lines.push(`- Selected items: ${ids.join(', ')}${more}`);
    }
    return lines.length > 0 ? ['What the user has open in Zotero:', ...lines] : [];
}

/**
 * The text of the user turn: the message, then one section per kind of
 * context that is present. A prompt with nothing but text renders as that
 * text unchanged.
 */
export function renderUserPrompt(prompt: BeaverAgentPrompt): string {
    const sections: string[] = [prompt.content ?? ''];

    const actions = describeActions(prompt.actions ?? []);
    if (actions.length > 0) sections.push(actions.join('\n'));

    const attachments = (prompt.attachments ?? [])
        .map(describeAttachment)
        .filter((line): line is string => line !== null);
    if (attachments.length > 0) {
        sections.push(
            [
                'Attached to this message (pass these ids to get_metadata, read_attachment, read_note or find_annotations; collection keys to list_items):',
                ...attachments,
            ].join('\n')
        );
    }

    const state = prompt.application_state ? describeState(prompt.application_state) : [];
    if (state.length > 0) sections.push(state.join('\n'));

    return sections.filter((section) => section.length > 0).join('\n\n');
}
