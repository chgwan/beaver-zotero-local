/**
 * Streaming client for Anthropic's Messages API.
 *
 * Differs from the OpenAI shape in ways that matter to every layer: the system
 * prompt is a top-level parameter rather than a message, auth is `x-api-key`
 * with a version header, and content arrives as indexed blocks whose deltas are
 * typed. Tool input streams as `input_json_delta.partial_json`, reassembled by
 * the shared accumulator keyed on the block index.
 *
 * With hosted web search enabled, the provider runs searches inside the turn:
 * `server_tool_use` and `web_search_tool_result` blocks arrive alongside text,
 * cited text carries `citations_delta` events, and a long turn may end with
 * `pause_turn`. Such a turn is also returned as raw content blocks, because
 * the provider only accepts it back unchanged.
 */

import { readSseEvents } from './sseReader';
import { ToolCallAccumulator } from './toolCallAccumulator';
import {
    LlmRequestError,
    addCitation,
    classifyHttpStatus,
    joinEndpoint,
    namesWebSearchTool,
    providerErrorMessage,
    webSearchUnsupportedError,
    type LlmCitation,
    type LlmClient,
    type LlmFinishReason,
    type LlmMessage,
    type LlmStreamHandlers,
    type LlmTurnRequest,
    type LlmTurnResult,
    type LlmUsage,
} from './types';

/** Messages API version this client is written against. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** `max_tokens` is required by the API, so a default is not optional. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/**
 * The hosted web search server tool version, as documented at
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 *
 * `web_search_20250305` is the basic tool. Every web-search-capable model and
 * platform accepts it, it is eligible for zero data retention, and a turn
 * that uses it holds only `server_tool_use`, `web_search_tool_result`, and
 * cited text, so a paused or later turn is continued by replaying those
 * blocks alone. Searches are billed per search by the provider, on top of
 * tokens.
 *
 * Later versions (`web_search_20260209` and on) add dynamic filtering: the
 * search runs inside the provider's code execution, whose container state a
 * continued turn may need back. Enabling them would mean capturing the
 * response's `container.id` (from `message_start` / `message_delta`) and
 * sending it as `container` on the next request of the run, and accepting
 * code-execution blocks in replayed turns.
 */
export const ANTHROPIC_WEB_SEARCH_TOOL = 'web_search_20250305';

const mapStopReason = (reason: string | null | undefined): LlmFinishReason => {
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'max_tokens') return 'length';
    // A long hosted-search turn paused server-side; resending it continues.
    if (reason === 'pause_turn') return 'pause';
    return 'unknown';
};

/** Block types this client can rebuild from `content` and `toolCalls` alone. */
const PLAIN_BLOCK_TYPES = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);

/** User-facing copy for a `web_search_tool_result_error` code. */
const webSearchErrorMessage = (code: unknown): string => {
    if (code === 'max_uses_exceeded') return 'Web search reached its search limit for this turn.';
    if (code === 'too_many_requests') return 'Web search was rate limited by the provider.';
    return `Web search failed (${typeof code === 'string' ? code : 'unknown error'}).`;
};

const parseJsonObject = (text: string): Record<string, unknown> => {
    if (!text.trim()) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

/**
 * Rebuilds a turn's content blocks from the stream, so a turn with
 * server-side content can be sent back exactly as it was received.
 */
class ContentBlockRecorder {
    private readonly blocks = new Map<number, Record<string, any>>();
    private readonly inputText = new Map<number, string>();

    start(index: number, block: Record<string, any>): void {
        this.blocks.set(index, { ...block });
    }

    delta(index: number, delta: Record<string, any>): void {
        const block = this.blocks.get(index);
        if (!block) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = (block.text ?? '') + delta.text;
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = (block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = delta.signature;
        } else if (delta.type === 'citations_delta' && delta.citation) {
            block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            this.inputText.set(index, (this.inputText.get(index) ?? '') + delta.partial_json);
        }
    }

    /**
     * The blocks in index order, or undefined when every block is one this
     * client rebuilds on its own (plain text without citations, local tool
     * calls, reasoning).
     */
    close(): unknown[] | undefined {
        const indices = [...this.blocks.keys()].sort((a, b) => a - b);
        const blocks: Record<string, any>[] = [];
        let needsReplay = false;
        for (const index of indices) {
            const block = this.blocks.get(index)!;
            const input = this.inputText.get(index);
            if (input !== undefined) block.input = parseJsonObject(input);
            else if ((block.type === 'server_tool_use' || block.type === 'tool_use') && !block.input) block.input = {};
            if (block.type === 'text') {
                if (!Array.isArray(block.citations) || block.citations.length === 0) delete block.citations;
                // The API rejects an empty text block.
                if (!block.text && !block.citations) continue;
                if (block.citations) needsReplay = true;
            } else if (!PLAIN_BLOCK_TYPES.has(block.type)) {
                needsReplay = true;
            }
            blocks.push(block);
        }
        return needsReplay ? blocks : undefined;
    }
}

const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === 'AbortError';

/**
 * The Anthropic Messages endpoint is `<base>/v1/messages`. Some users copy the
 * endpoint from an OpenAI-style field and include a trailing `/v1` (the UI's
 * only placeholder shows that shape), which would otherwise double up to
 * `/v1/v1/messages`. Strip one trailing `/v1` (with or without a trailing
 * slash) before joining, so both `https://api.anthropic.com` and
 * `https://api.anthropic.com/v1` resolve to the same URL.
 */
const stripTrailingV1 = (apiBase: string): string => apiBase.replace(/\/v1\/?$/, '');

/** A wire message's content, normalised to content blocks for merging. */
const asContentBlocks = (content: unknown): unknown[] => {
    if (Array.isArray(content)) return content;
    if (typeof content === 'string') {
        return content.length > 0 ? [{ type: 'text', text: content }] : [];
    }
    return [];
};

/**
 * Rebuild the transcript in Anthropic's content-block form.
 *
 * Translation alone does not guarantee an alternating `user`/`assistant`
 * sequence: two tool results become two `user`-role entries, and replayed
 * history can legitimately contain two human turns or two assistant turns in
 * a row (for example, a run cancelled before the model replied). Anthropic
 * rejects a non-alternating transcript with a 400, so every adjacent run of
 * same-role entries is merged into one message, concatenating their content
 * blocks in order (a string message is normalised to a single text block
 * before merging; an empty one contributes nothing).
 */
const buildMessages = (
    messages: LlmMessage[]
): { system: string | undefined; wire: Record<string, unknown>[] } => {
    const systemParts: string[] = [];
    const translated: { role: string; content: unknown }[] = [];

    for (const message of messages) {
        if (message.role === 'system') {
            systemParts.push(message.content);
            continue;
        }

        // Server-side content (hosted search calls, encrypted results, cited
        // text) is only valid if sent back unchanged.
        if (message.role === 'assistant' && message.providerBlocks?.length) {
            translated.push({ role: 'assistant', content: [...message.providerBlocks] });
            continue;
        }

        if (message.role === 'tool') {
            translated.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: message.toolCallId,
                        content: message.content,
                    },
                ],
            });
            continue;
        }

        if (message.role === 'assistant' && message.toolCalls?.length) {
            const content: unknown[] = [];
            if (message.content.length > 0) {
                content.push({ type: 'text', text: message.content });
            }
            for (const call of message.toolCalls) {
                content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
            }
            translated.push({ role: 'assistant', content });
            continue;
        }

        translated.push({ role: message.role, content: message.content });
    }

    const wire: Record<string, unknown>[] = [];
    for (const message of translated) {
        const previous = wire[wire.length - 1];
        if (previous && previous.role === message.role) {
            previous.content = [
                ...asContentBlocks(previous.content),
                ...asContentBlocks(message.content),
            ];
        } else {
            wire.push({ role: message.role, content: message.content });
        }
    }

    // A transcript that opens with an assistant message is equally invalid,
    // and there is no earlier user turn left to attribute it to. Dropping it
    // is the least surprising option: fabricating a placeholder user turn
    // would put words in the user's mouth, and the alternative of sending it
    // anyway just relocates the same 400 to a payload the model can't act on
    // either way.
    while (wire.length > 0 && wire[0].role === 'assistant') {
        wire.shift();
    }

    return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, wire };
};

export function createAnthropicClient(): LlmClient {
    return {
        async streamTurn(
            request: LlmTurnRequest,
            handlers: LlmStreamHandlers,
            signal: AbortSignal
        ): Promise<LlmTurnResult> {
            const { model, messages, tools } = request;
            const { system, wire } = buildMessages(messages);
            const webSearch = request.webSearch?.enabled ? request.webSearch : null;

            const localTools = tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
            }));
            const buildPayload = (withWebSearch: boolean): Record<string, unknown> => {
                const payload: Record<string, unknown> = {
                    model: model.snapshot,
                    stream: true,
                    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
                    messages: wire,
                };
                if (system) payload.system = system;
                const allTools: Record<string, unknown>[] = [...localTools];
                if (withWebSearch) {
                    const maxUses = webSearch?.maxUses;
                    allTools.push({
                        type: ANTHROPIC_WEB_SEARCH_TOOL,
                        name: 'web_search',
                        ...(maxUses && Number.isInteger(maxUses) && maxUses > 0 ? { max_uses: maxUses } : {}),
                    });
                }
                if (allTools.length > 0) {
                    payload.tools = allTools;
                    if (request.toolChoice === 'none') payload.tool_choice = { type: 'none' };
                }
                return payload;
            };

            const url = joinEndpoint(stripTrailingV1(model.api_base ?? ''), 'v1/messages');

            const post = async (payload: Record<string, unknown>): Promise<Response> => {
                try {
                    return await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            // A keyless local server gets no auth header at all.
                            ...(model.api_key?.trim() ? { 'x-api-key': model.api_key } : {}),
                            'anthropic-version': ANTHROPIC_VERSION,
                            // A privileged Gecko `fetch` can still attach an `Origin`
                            // header, which Anthropic's browser-key check would
                            // otherwise reject; this request always carries the
                            // user's own key from a trusted context, so opting out
                            // of that check has no downside here.
                            'anthropic-dangerous-direct-browser-access': 'true',
                        },
                        body: JSON.stringify(payload),
                        signal,
                    });
                } catch (error) {
                    if (signal.aborted || isAbortError(error)) {
                        throw new LlmRequestError('cancelled', 'The request was cancelled.');
                    }
                    throw new LlmRequestError(
                        'network',
                        `Could not reach ${url}: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                }
            };

            const readError = async (failed: Response): Promise<string> => {
                const body = await failed.text().catch(() => '');
                return providerErrorMessage(body, `${failed.status} ${failed.statusText}`);
            };

            const response = await post(buildPayload(webSearch !== null));
            const errorMessage = response.ok ? null : await readError(response);

            if (!response.ok) {
                const message = errorMessage ?? `${response.status} ${response.statusText}`;
                if (webSearch && response.status === 400 && namesWebSearchTool(message)) {
                    throw webSearchUnsupportedError(message);
                }
                throw new LlmRequestError(classifyHttpStatus(response.status), message);
            }
            if (!response.body) {
                throw new LlmRequestError('server', 'The provider returned no response body.');
            }

            const accumulator = new ToolCallAccumulator();
            // A server tool (`server_tool_use`, e.g. hosted web search) streams
            // `input_json_delta` in the same shape as a `tool_use` block this
            // client executes, but for a call this client never issued and has
            // no handler for. The block type is only known from its
            // `content_block_start`, so it is tracked per index and consulted
            // before any delta is allowed to reach the accumulator — anything
            // this client doesn't recognize as `tool_use` is dropped rather
            // than turning into a phantom call with an empty name.
            const blockTypes = new Map<number, string>();
            const recorder = new ContentBlockRecorder();
            // Text resumed after a search (or any other non-text block) is a
            // new paragraph; text blocks that follow each other directly are
            // one passage that citations split up, and join as they are.
            let previousBlockType: string | null = null;
            let separateNextText = false;
            const citations: LlmCitation[] = [];
            let text = '';
            let thinking = '';
            let finishReason: LlmFinishReason = 'unknown';
            // Input and output tokens arrive on separate frame types
            // (`message_start` and `message_delta`), so each is tracked
            // independently and combined only once the stream ends.
            // `input_tokens` excludes the cached part of the prompt, which
            // arrives in the two cache fields; a provider that caches
            // automatically reports only a few uncached tokens there.
            let inputTokens: number | null = null;
            let cacheWriteTokens: number | null = null;
            let cacheReadTokens: number | null = null;
            let outputTokens: number | null = null;

            for await (const event of readSseEvents(response.body, signal)) {
                let frame: any;
                try {
                    frame = JSON.parse(event.data);
                } catch {
                    // A keep-alive or partial frame; the next one carries the state.
                    continue;
                }

                const type = event.event ?? frame?.type;

                if (type === 'error') {
                    throw new LlmRequestError(
                        'server',
                        providerErrorMessage(event.data, 'The provider reported an error.')
                    );
                }

                if (type === 'message_start') {
                    const startUsage = frame.message?.usage ?? {};
                    if (typeof startUsage.input_tokens === 'number') inputTokens = startUsage.input_tokens;
                    if (typeof startUsage.cache_creation_input_tokens === 'number') {
                        cacheWriteTokens = startUsage.cache_creation_input_tokens;
                    }
                    if (typeof startUsage.cache_read_input_tokens === 'number') {
                        cacheReadTokens = startUsage.cache_read_input_tokens;
                    }
                    continue;
                }

                if (type === 'content_block_start') {
                    const block = frame.content_block ?? {};
                    const index = frame.index ?? 0;
                    blockTypes.set(index, block.type);
                    recorder.start(index, block);
                    if (block.type === 'text' && previousBlockType !== null && previousBlockType !== 'text') {
                        separateNextText = true;
                    }
                    previousBlockType = block.type;
                    if (block.type === 'tool_use') {
                        accumulator.open(index, { id: block.id, name: block.name });
                    }
                    // A hosted search that failed still returns 200: its
                    // result block carries an error object instead of a list,
                    // and the model carries on without it.
                    if (
                        block.type === 'web_search_tool_result' &&
                        block.content &&
                        !Array.isArray(block.content)
                    ) {
                        handlers.onWarning?.(webSearchErrorMessage(block.content.error_code));
                    }
                    continue;
                }

                if (type === 'content_block_delta') {
                    const index = frame.index ?? 0;
                    const delta = frame.delta ?? {};
                    recorder.delta(index, delta);
                    if (delta.type === 'citations_delta') {
                        addCitation(citations, delta.citation?.url, delta.citation?.title);
                    }
                    // `text_delta`/`thinking_delta` are already scoped to their
                    // block type by the Anthropic protocol itself — unlike
                    // `input_json_delta`, no other block type emits them — so
                    // no separate block-type check is needed here.
                    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                        if (separateNextText && delta.text.length > 0) {
                            if (text.length > 0 && !/\s$/.test(text)) text += '\n\n';
                            separateNextText = false;
                        }
                        text += delta.text;
                        handlers.onTextDelta(text);
                    } else if (
                        delta.type === 'thinking_delta' &&
                        typeof delta.thinking === 'string'
                    ) {
                        thinking += delta.thinking;
                        handlers.onThinkingDelta(thinking);
                    } else if (
                        delta.type === 'input_json_delta' &&
                        typeof delta.partial_json === 'string' &&
                        blockTypes.get(index) === 'tool_use'
                    ) {
                        accumulator.appendArguments(index, delta.partial_json);
                    }
                    continue;
                }

                if (type === 'message_delta') {
                    finishReason = mapStopReason(frame.delta?.stop_reason);
                    const deltaOutputTokens = frame.usage?.output_tokens;
                    if (typeof deltaOutputTokens === 'number') outputTokens = deltaOutputTokens;
                    continue;
                }

                if (type === 'message_stop') break;
            }

            // A signal that fired mid-stream must not be swallowed into a
            // partial success: the loop reads `signal.aborted` to tell a
            // user-requested stop from a provider failure, and needs a
            // consistent answer regardless of when the abort landed.
            if (signal.aborted) {
                throw new LlmRequestError('cancelled', 'The request was cancelled.');
            }

            const toolCalls = accumulator.close();
            if (finishReason === 'unknown' && toolCalls.length > 0) {
                finishReason = 'tool_calls';
            }

            // Null unless the provider sent at least one of the counts.
            const reportsCache = cacheWriteTokens !== null || cacheReadTokens !== null;
            const usage: LlmUsage | null =
                inputTokens !== null || outputTokens !== null || reportsCache
                    ? {
                          inputTokens: (inputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0),
                          outputTokens: outputTokens ?? 0,
                          ...(reportsCache
                              ? { cacheWriteTokens: cacheWriteTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0 }
                              : {}),
                      }
                    : null;

            const providerBlocks = recorder.close();
            return {
                text,
                thinking,
                toolCalls,
                finishReason,
                usage,
                ...(citations.length > 0 ? { citations } : {}),
                ...(providerBlocks ? { providerBlocks } : {}),
            };
        },
    };
}
