/**
 * Which provider-hosted web search, if any, a model's endpoint offers.
 *
 * Web search in local mode is always the provider's own hosted tool; there is
 * no plugin-side search engine to fall back to. A provider without one simply
 * has no web search.
 */

import { OPENROUTER_API_BASE, type CustomChatModel } from '@beaver/agent-core/types/customChatModel';

/**
 * - `anthropic`: the Messages API `web_search` server tool.
 * - `openrouter`: OpenRouter's `openrouter:web_search` server tool.
 * - `openai-responses`: OpenAI's hosted `web_search` tool, which exists only
 *   in the Responses API, not in the Chat Completions API this package speaks.
 */
export type HostedWebSearchKind = 'anthropic' | 'openrouter' | 'openai-responses';

/** The kinds this package can currently send a request for. */
const AVAILABLE_KINDS: ReadonlySet<HostedWebSearchKind> = new Set<HostedWebSearchKind>(['anthropic', 'openrouter']);

const hostOf = (apiBase: string): string | null => {
    try {
        return new URL(apiBase.trim()).hostname.toLowerCase();
    } catch {
        return null;
    }
};

/** Pure: reads only the model's format, provider, and endpoint host. */
export function supportsHostedWebSearch(model: CustomChatModel | null | undefined): HostedWebSearchKind | null {
    if (!model) return null;
    if (model.format === 'anthropic') return 'anthropic';

    // A native OpenRouter entry may leave `api_base` blank.
    const isOpenRouterEntry = model.provider?.toLowerCase() === 'openrouter';
    const apiBase = model.api_base?.trim() || (isOpenRouterEntry ? OPENROUTER_API_BASE : '');
    const host = hostOf(apiBase);
    if (host === 'openrouter.ai') return 'openrouter';
    if (host === 'api.openai.com') return 'openai-responses';
    return null;
}

/** Whether a run on this model can request hosted web search today. */
export function isHostedWebSearchAvailable(model: CustomChatModel | null | undefined): boolean {
    const kind = supportsHostedWebSearch(model);
    return kind !== null && AVAILABLE_KINDS.has(kind);
}
