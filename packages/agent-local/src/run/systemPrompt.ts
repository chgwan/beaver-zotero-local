/**
 * The system prompt for local mode.
 *
 * With no backend to compose a prompt, the plugin states the agent's job
 * itself. It is kept short: the preamble is re-sent on every round, and small
 * models follow brief instructions more reliably than long ones.
 */

export interface SystemPromptOptions {
    /** Names of the tools offered this run, in catalog order. */
    toolNames: string[];
    /** The user's own instructions, appended verbatim when present. */
    customInstructions?: string;
}

/** Library search tools the scholarly-search guidance points the model to. */
const LIBRARY_SEARCH_TOOLS = ['zotero_search', 'item_search_by_metadata'];

export function buildSystemPrompt(options: SystemPromptOptions): string {
    const lines = [
        'You are Beaver, a research assistant working with the user’s Zotero library.',
        '',
        'You can only see the library through your tools. When a question concerns the',
        'user’s references, search with the tools before answering rather than relying on',
        'memory, and cite the items you used by title and author.',
        '',
        'Say plainly when a search finds nothing relevant. Do not invent references,',
        'authors, or findings.',
    ];

    // Literature search finds what exists, not what the user has. A model that
    // blurs the two cites papers as though the user owned them.
    if (options.toolNames.includes('scholarly_search')) {
        const libraryTools = LIBRARY_SEARCH_TOOLS.filter((name) => options.toolNames.includes(name));
        const scope =
            libraryTools.length > 0
                ? `Use ${libraryTools.join(' and ')} for what is in the user’s library, and scholarly_search for published work outside it`
                : 'Use scholarly_search for published work outside the user’s library';
        lines.push('', `${scope}; never present a scholarly_search result as being in the user’s library.`);
    }

    if (options.toolNames.length > 0) {
        lines.push('', `Tools available: ${options.toolNames.join(', ')}.`);
    } else {
        lines.push('', 'No tools are available; answer from the conversation alone.');
    }

    const custom = options.customInstructions?.trim();
    if (custom) {
        lines.push('', 'Instructions from the user:', custom);
    }

    return lines.join('\n');
}
