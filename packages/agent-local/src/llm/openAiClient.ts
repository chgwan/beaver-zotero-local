/**
 * Streaming client for OpenAI-compatible `/chat/completions` endpoints.
 *
 * Covers OpenAI itself and the many servers that copy its shape, including
 * local ones. Tool arguments arrive as `function.arguments` fragments keyed by
 * `index` and are reassembled by `ToolCallAccumulator`; nothing is parsed until
 * the stream closes.
 *
 * Hosted web search is sent only to OpenRouter, as its `openrouter:web_search`
 * server tool (https://openrouter.ai/docs/guides/features/server-tools/web-search):
 * a tools-array entry `{ type: 'openrouter:web_search', parameters? }`, run by
 * OpenRouter inside the request and billed per search by OpenRouter. The
 * model decides whether to search, unlike the deprecated `web` plugin, which
 * searched once on every request. Cited sources come back as OpenAI-style
 * `url_citation` annotations. Chat Completions has no general hosted search
 * tool, so other endpoints get nothing added.
 */

import { readSseEvents } from './sseReader';
import { ToolCallAccumulator, wireArguments } from './toolCallAccumulator';
import { supportsHostedWebSearch } from './webSearchCapability';
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

const wireMessage = (message: LlmMessage): Record<string, unknown> => {
    if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: wireArguments(call) },
            })),
        };
    }
    return { role: message.role, content: message.content };
};

const mapFinishReason = (reason: string | null | undefined): LlmFinishReason => {
    if (reason === 'stop') return 'stop';
    if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls';
    if (reason === 'length') return 'length';
    return 'unknown';
};

/** Read `usage` off a frame, if it carries one. A frame with no usage yields null. */
const readUsage = (frame: any): LlmUsage | null => {
    const usage = frame?.usage;
    if (!usage || typeof usage !== 'object') return null;
    return {
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    };
};

/**
 * The accumulator slot a streamed tool-call fragment belongs to.
 *
 * `index` is the standard key. Some compatible servers omit it; then:
 *  - a fragment with an `id` keys on that id, so each call keeps its own slot;
 *  - a fragment with neither, in a delta that carries several calls, keys on
 *    its position in that delta — parallel calls sent side by side;
 *  - a lone fragment with neither continues the call opened last, which is
 *    how such servers stream one call's arguments after its first fragment.
 */
const toolCallKey = (call: any, position: number, parallel: boolean, lastKey: string | null): string => {
    if (typeof call?.index === 'number') return `index:${call.index}`;
    if (typeof call?.id === 'string' && call.id.length > 0) return `id:${call.id}`;
    if (parallel || lastKey === null) return `position:${position}`;
    return lastKey;
};

const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === 'AbortError';

/** Collect `url_citation` annotations, which may sit on the delta or a message. */
const readAnnotations = (annotations: unknown, citations: LlmCitation[]): void => {
    if (!Array.isArray(annotations)) return;
    for (const annotation of annotations) {
        if (annotation?.type !== 'url_citation') continue;
        const cited = annotation.url_citation ?? annotation;
        addCitation(citations, cited?.url, cited?.title);
    }
};

export function createOpenAiClient(): LlmClient {
    return {
        async streamTurn(
            request: LlmTurnRequest,
            handlers: LlmStreamHandlers,
            signal: AbortSignal
        ): Promise<LlmTurnResult> {
            const { model, messages, tools } = request;
            // The capability check is repeated here so a caller that asks for
            // web search on an endpoint without it gets a plain request.
            const webSearch =
                request.webSearch?.enabled && supportsHostedWebSearch(model) === 'openrouter'
                    ? request.webSearch
                    : null;

            const payload: Record<string, unknown> = {
                model: model.snapshot,
                stream: true,
                messages: messages.map(wireMessage),
            };
            const wireTools: Record<string, unknown>[] = tools.map((tool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            }));
            if (webSearch) {
                const maxUses = webSearch.maxUses;
                wireTools.push({
                    type: 'openrouter:web_search',
                    // `max_uses` is honoured by the providers that support it
                    // and ignored by the rest.
                    ...(maxUses && Number.isInteger(maxUses) && maxUses > 0 ? { parameters: { max_uses: maxUses } } : {}),
                });
            }
            // An empty `tools` array is rejected by some compatible servers.
            if (wireTools.length > 0) {
                payload.tools = wireTools;
                if (request.toolChoice === 'none') payload.tool_choice = 'none';
            }
            if (model.reasoning_effort) {
                payload.reasoning_effort = model.reasoning_effort;
            }
            // Deliberately not requesting `stream_options: { include_usage: true }`:
            // it is an OpenAI extension some OpenAI-compatible servers reject as an
            // unknown field, and the user's own endpoint must keep working
            // unchanged. Usage is read opportunistically from whatever a given
            // provider sends instead.

            const url = joinEndpoint(model.api_base ?? '', 'chat/completions');

            let response: Response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        // A keyless local server gets no auth header at all.
                        ...(model.api_key?.trim() ? { Authorization: `Bearer ${model.api_key}` } : {}),
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

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                const message = providerErrorMessage(body, `${response.status} ${response.statusText}`);
                if (webSearch && response.status === 400 && namesWebSearchTool(message)) {
                    throw webSearchUnsupportedError(message);
                }
                throw new LlmRequestError(classifyHttpStatus(response.status), message);
            }
            if (!response.body) {
                throw new LlmRequestError('server', 'The provider returned no response body.');
            }

            const accumulator = new ToolCallAccumulator();
            let lastKey: string | null = null;
            let text = '';
            let thinking = '';
            let finishReason: LlmFinishReason = 'unknown';
            let usage: LlmUsage | null = null;
            const citations: LlmCitation[] = [];

            for await (const event of readSseEvents(response.body, signal)) {
                if (event.data === '[DONE]') break;

                let frame: any;
                try {
                    frame = JSON.parse(event.data);
                } catch {
                    // A keep-alive or partial frame; the next one carries the state.
                    continue;
                }

                // Usage can arrive on any chunk, including a final one with no
                // (or empty) `choices` — read it before that guard drops the chunk.
                const chunkUsage = readUsage(frame);
                if (chunkUsage) usage = chunkUsage;

                const choice = frame?.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta ?? {};
                readAnnotations(delta.annotations, citations);
                readAnnotations(choice.message?.annotations, citations);

                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    text += delta.content;
                    handlers.onTextDelta(text);
                }

                // The reasoning field name varies across compatible servers.
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === 'string' && reasoning.length > 0) {
                    thinking += reasoning;
                    handlers.onThinkingDelta(thinking);
                }

                if (Array.isArray(delta.tool_calls)) {
                    const parallel = delta.tool_calls.length > 1;
                    delta.tool_calls.forEach((call: any, position: number) => {
                        const key = toolCallKey(call, position, parallel, lastKey);
                        lastKey = key;
                        accumulator.open(key, { id: call.id, name: call.function?.name });
                        if (typeof call.function?.arguments === 'string') {
                            accumulator.appendArguments(key, call.function.arguments);
                        }
                    });
                }

                if (choice.finish_reason) {
                    finishReason = mapFinishReason(choice.finish_reason);
                }
            }

            // A signal that fired mid-stream must not be swallowed into a
            // partial success: the loop reads `signal.aborted` to tell a
            // user-requested stop from a provider failure, and needs a
            // consistent answer regardless of when the abort landed.
            if (signal.aborted) {
                throw new LlmRequestError('cancelled', 'The request was cancelled.');
            }

            const toolCalls = accumulator.close();
            // Some servers omit finish_reason but do stream tool calls.
            if (finishReason === 'unknown' && toolCalls.length > 0) {
                finishReason = 'tool_calls';
            }

            return {
                text,
                thinking,
                toolCalls,
                finishReason,
                usage,
                ...(citations.length > 0 ? { citations } : {}),
            };
        },
    };
}
