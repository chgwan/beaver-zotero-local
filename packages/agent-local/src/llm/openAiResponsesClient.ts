/**
 * Streaming client for OpenAI's Responses API (`POST {api_base}/responses`).
 *
 * OpenAI's hosted web search exists only in this API, so a run on
 * api.openai.com with web search on is sent here; every other OpenAI-format
 * run keeps using Chat Completions (see `clientForRun`). The request and
 * stream shapes follow the API reference:
 *   https://developers.openai.com/api/reference/resources/responses/methods/create
 *   https://developers.openai.com/api/reference/resources/responses/streaming-events
 *   https://developers.openai.com/api/docs/guides/tools-web-search
 *   https://developers.openai.com/api/docs/guides/function-calling
 *   https://developers.openai.com/api/docs/guides/reasoning
 *
 * Request:
 * - System messages become `instructions`; the rest of the transcript becomes
 *   `input` items: `{role, content}` messages, `{type:'function_call',
 *   call_id, name, arguments}` for the assistant's calls and
 *   `{type:'function_call_output', call_id, output}` for their results.
 * - Function tools are `{type:'function', name, description, parameters,
 *   strict:false}`. Strict mode would reject any schema that is not fully
 *   closed, so it is turned off explicitly. The hosted tool is
 *   `{type:'web_search'}`; `max_tool_calls` caps the number of hosted-tool
 *   calls in one response and carries the search limit.
 * - `store: false`, with no `previous_response_id`. Each request carries the
 *   whole transcript, as the Chat Completions and Anthropic clients do, so
 *   the loop, context trimming and cross-run history work unchanged, and
 *   nothing about the conversation is kept on the provider beyond the request.
 * - `max_output_tokens` is not sent, so the model's own limit applies, as on
 *   the Chat Completions path.
 *
 * Stream (SSE, the event type is repeated in the JSON `type` field):
 * - `response.output_text.delta` {item_id, output_index, content_index, delta}
 *   and `response.refusal.delta` extend the text.
 * - `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`
 *   extend the reasoning.
 * - `response.output_item.added` {output_index, item} opens a function call
 *   (`item.id`, `item.call_id`, `item.name`); `response.function_call_arguments.delta`
 *   {item_id, output_index, delta} streams its arguments. They are reassembled
 *   per item by `ToolCallAccumulator` and parsed once, at close.
 * - `response.output_item.done` {output_index, item} carries each finished
 *   item: a `web_search_call` (never a tool call), a `reasoning` item with
 *   the `encrypted_content` that stateless multi-turn use needs, a
 *   `function_call`, or a `message` whose `output_text` parts hold
 *   `url_citation` annotations.
 * - `response.output_text.annotation.added` {annotation} carries a citation
 *   as it streams: `{type:'url_citation', url, title, start_index, end_index}`.
 * - `response.completed` / `response.incomplete` {response} end the stream
 *   with `response.usage` {input_tokens, output_tokens}; an incomplete
 *   response names its cause in `response.incomplete_details.reason`.
 * - `response.failed` {response.error {code, message}} and `error`
 *   {code, message, param} report a failure.
 *
 * The Responses API has no paused-turn state, so this client never returns
 * `'pause'`.
 */

import { readSseEvents } from './sseReader';
import { ToolCallAccumulator, wireArguments, type AccumulatedToolCall } from './toolCallAccumulator';
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
    type LlmErrorKind,
    type LlmFinishReason,
    type LlmMessage,
    type LlmStreamHandlers,
    type LlmTurnRequest,
    type LlmTurnResult,
    type LlmUsage,
} from './types';

/** The hosted web search tool type in the Responses API. */
export const OPENAI_WEB_SEARCH_TOOL = 'web_search';

const cancelled = () => new LlmRequestError('cancelled', 'The request was cancelled.');

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/**
 * Translate the transcript into `instructions` and `input` items.
 *
 * An assistant turn this client produced carries its output items in
 * `providerBlocks`: reasoning, hosted search calls, messages and function
 * calls, in the order the response returned them. Because responses are not
 * stored, the API can only connect a reasoning item to what followed it if
 * every item comes back inline, unchanged and in order, so those items are
 * sent in place of the turn's text and calls. Turns without them (history
 * from earlier runs) are translated from their text and calls.
 */
export function buildResponsesInput(messages: LlmMessage[]): { instructions: string | null; input: unknown[] } {
    const system: string[] = [];
    const input: unknown[] = [];

    for (const message of messages) {
        if (message.role === 'system') {
            if (message.content.trim()) system.push(message.content);
            continue;
        }
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
            continue;
        }
        if (message.role === 'assistant') {
            if (message.providerBlocks?.length) {
                input.push(...message.providerBlocks);
                continue;
            }
            if (message.content.length > 0) input.push({ role: 'assistant', content: message.content });
            for (const call of message.toolCalls ?? []) {
                input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: wireArguments(call) });
            }
            continue;
        }
        input.push({ role: 'user', content: message.content });
    }

    return { instructions: system.length > 0 ? system.join('\n\n') : null, input };
}

const readUsage = (response: any): LlmUsage | null => {
    const usage = response?.usage;
    if (!usage || typeof usage !== 'object') return null;
    return {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    };
};

/** Map a stream-reported error code to the error kind the user sees. */
const classifyStreamError = (code: unknown): LlmErrorKind => {
    const value = typeof code === 'string' ? code : '';
    if (/rate_limit|quota/i.test(value)) return 'rate_limit';
    if (/invalid|unsupported|not_found/i.test(value)) return 'bad_request';
    return 'server';
};

const readCitation = (annotation: any, citations: LlmCitation[]): void => {
    if (annotation?.type !== 'url_citation') return;
    addCitation(citations, annotation.url, annotation.title);
};

/**
 * The output items to send back for a finished turn, in output order.
 *
 * A function call is sent with the arguments `wireArguments` settles on, so
 * a call whose streamed arguments were not a JSON object is replayed as `{}`,
 * and with the id its tool result answers. A call or text that streamed but
 * whose item never finished is still recorded, so the next request has the
 * call each tool result refers to.
 */
function replayItems(
    outputItems: { item: Record<string, unknown>; callKey?: string }[],
    callKeys: string[],
    toolCalls: AccumulatedToolCall[],
    text: string
): unknown[] {
    const callByKey = new Map<string, AccumulatedToolCall>();
    callKeys.forEach((key, position) => {
        const call = toolCalls[position];
        if (call) callByKey.set(key, call);
    });

    const replay: unknown[] = [];
    const replayedKeys = new Set<string>();
    for (const { item, callKey } of outputItems) {
        const call = callKey ? callByKey.get(callKey) : undefined;
        if (!call) {
            replay.push(item);
            continue;
        }
        replayedKeys.add(callKey!);
        replay.push({ ...item, call_id: call.id, arguments: wireArguments(call) });
    }

    if (text.length > 0 && !outputItems.some(({ item }) => item.type === 'message')) {
        replay.push({ role: 'assistant', content: text });
    }
    for (const key of callKeys) {
        const call = callByKey.get(key);
        if (!call || replayedKeys.has(key)) continue;
        replay.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: wireArguments(call) });
    }
    return replay;
}

export function createOpenAiResponsesClient(): LlmClient {
    return {
        async streamTurn(
            request: LlmTurnRequest,
            handlers: LlmStreamHandlers,
            signal: AbortSignal
        ): Promise<LlmTurnResult> {
            if (signal.aborted) throw cancelled();

            const { model, messages, tools } = request;
            const webSearch = request.webSearch?.enabled ? request.webSearch : null;
            const { instructions, input } = buildResponsesInput(messages);

            const payload: Record<string, unknown> = {
                model: model.snapshot,
                stream: true,
                store: false,
                ...(instructions !== null ? { instructions } : {}),
                input,
            };
            const wireTools: Record<string, unknown>[] = tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: false,
            }));
            if (webSearch) {
                wireTools.push({ type: OPENAI_WEB_SEARCH_TOOL });
                const maxUses = webSearch.maxUses;
                if (maxUses && Number.isInteger(maxUses) && maxUses > 0) payload.max_tool_calls = maxUses;
            }
            if (wireTools.length > 0) {
                payload.tools = wireTools;
                // `none` forbids hosted search as well as function calls, so the
                // loop's last round answers from what it already has.
                if (request.toolChoice === 'none') payload.tool_choice = 'none';
            }
            if (model.reasoning_effort) {
                payload.reasoning = { effort: model.reasoning_effort };
            }

            const url = joinEndpoint(model.api_base ?? '', 'responses');

            let response: Response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(model.api_key?.trim() ? { Authorization: `Bearer ${model.api_key}` } : {}),
                    },
                    body: JSON.stringify(payload),
                    signal,
                });
            } catch (error) {
                if (signal.aborted || isAbortError(error)) throw cancelled();
                throw new LlmRequestError(
                    'network',
                    `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`
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
            // Argument deltas name their item by id and by output index.
            const callKeyByItemId = new Map<string, string>();
            const callKeyByOutputIndex = new Map<number, string>();
            const argsReceived = new Set<string>();
            // Accumulator keys in the order the accumulator will close them.
            const callKeys: string[] = [];
            // Every finished output item, in output order, for replay.
            const outputItems: { item: Record<string, unknown>; callKey?: string }[] = [];
            const citations: LlmCitation[] = [];
            let text = '';
            let thinking = '';
            let separateNextText = false;
            let separateNextThinking = false;
            let finishReason: LlmFinishReason = 'unknown';
            let usage: LlmUsage | null = null;

            const appendText = (delta: string) => {
                if (!delta) return;
                // Text after a search belongs to a new message item; keep it
                // from running into the sentence before it.
                if (separateNextText && text.length > 0 && !/\s$/.test(text) && !/^\s/.test(delta)) text += '\n\n';
                separateNextText = false;
                text += delta;
                handlers.onTextDelta(text);
            };
            const appendThinking = (delta: string) => {
                if (!delta) return;
                if (separateNextThinking && thinking.length > 0 && !/\s$/.test(thinking)) thinking += '\n\n';
                separateNextThinking = false;
                thinking += delta;
                handlers.onThinkingDelta(thinking);
            };

            const callKey = (itemId: unknown, outputIndex: unknown): string | null => {
                if (typeof itemId === 'string' && callKeyByItemId.has(itemId)) return callKeyByItemId.get(itemId)!;
                if (typeof outputIndex === 'number' && callKeyByOutputIndex.has(outputIndex)) {
                    return callKeyByOutputIndex.get(outputIndex)!;
                }
                return null;
            };
            const openCall = (item: any, outputIndex: unknown): string => {
                const existing = callKey(item?.id, outputIndex);
                const key =
                    existing ??
                    (typeof item?.id === 'string' && item.id ? `item:${item.id}` : `output:${String(outputIndex)}`);
                if (!existing) callKeys.push(key);
                if (typeof item?.id === 'string' && item.id) callKeyByItemId.set(item.id, key);
                if (typeof outputIndex === 'number') callKeyByOutputIndex.set(outputIndex, key);
                accumulator.open(key, {
                    id: typeof item?.call_id === 'string' ? item.call_id : undefined,
                    name: typeof item?.name === 'string' ? item.name : undefined,
                });
                return key;
            };

            for await (const event of readSseEvents(response.body, signal)) {
                let frame: any;
                try {
                    frame = JSON.parse(event.data);
                } catch {
                    continue;
                }
                const type: string = typeof frame?.type === 'string' ? frame.type : event.event ?? '';

                switch (type) {
                    case 'response.output_item.added': {
                        const item = frame.item;
                        if (item?.type === 'function_call') openCall(item, frame.output_index);
                        else if (item?.type === 'message') separateNextText = true;
                        else if (item?.type === 'reasoning') separateNextThinking = true;
                        break;
                    }
                    case 'response.function_call_arguments.delta': {
                        const key = callKey(frame.item_id, frame.output_index) ?? openCall({ id: frame.item_id }, frame.output_index);
                        if (typeof frame.delta === 'string' && frame.delta) {
                            accumulator.appendArguments(key, frame.delta);
                            argsReceived.add(key);
                        }
                        break;
                    }
                    case 'response.function_call_arguments.done': {
                        const key = callKey(frame.item_id, frame.output_index);
                        if (key && !argsReceived.has(key) && typeof frame.arguments === 'string' && frame.arguments) {
                            accumulator.appendArguments(key, frame.arguments);
                            argsReceived.add(key);
                        }
                        break;
                    }
                    case 'response.output_item.done': {
                        const item = frame.item;
                        if (item?.type === 'function_call') {
                            const key = openCall(item, frame.output_index);
                            if (!argsReceived.has(key) && typeof item.arguments === 'string' && item.arguments) {
                                accumulator.appendArguments(key, item.arguments);
                                argsReceived.add(key);
                            }
                            outputItems.push({ item, callKey: key });
                        } else if (item?.type === 'reasoning') {
                            // Without its encrypted content a reasoning item
                            // refers to stored state that does not exist.
                            if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
                                outputItems.push({ item });
                            }
                        } else if (item && typeof item === 'object' && typeof item.type === 'string') {
                            if (item.type === 'message' && Array.isArray(item.content)) {
                                for (const part of item.content) {
                                    if (Array.isArray(part?.annotations)) {
                                        for (const annotation of part.annotations) readCitation(annotation, citations);
                                    }
                                }
                            } else if (item.type === 'web_search_call' && item.status === 'failed') {
                                handlers.onWarning?.('Web search failed.');
                            }
                            outputItems.push({ item });
                        }
                        break;
                    }
                    case 'response.output_text.delta':
                    case 'response.refusal.delta':
                        if (typeof frame.delta === 'string') appendText(frame.delta);
                        break;
                    case 'response.output_text.annotation.added':
                        readCitation(frame.annotation, citations);
                        break;
                    case 'response.reasoning_summary_part.added':
                        separateNextThinking = true;
                        break;
                    case 'response.reasoning_summary_text.delta':
                    case 'response.reasoning_text.delta':
                        if (typeof frame.delta === 'string') appendThinking(frame.delta);
                        break;
                    case 'response.completed':
                        usage = readUsage(frame.response) ?? usage;
                        finishReason = 'stop';
                        break;
                    case 'response.incomplete':
                        usage = readUsage(frame.response) ?? usage;
                        // `max_output_tokens` is a cut-off answer; any other cause
                        // (a content filter) ends the turn without a clear reason.
                        finishReason =
                            frame.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'unknown';
                        break;
                    case 'response.failed': {
                        if (signal.aborted) throw cancelled();
                        const error = frame.response?.error;
                        const message =
                            typeof error?.message === 'string' && error.message ? error.message : 'The provider failed to generate a response.';
                        throw new LlmRequestError(classifyStreamError(error?.code), message);
                    }
                    case 'error': {
                        if (signal.aborted) throw cancelled();
                        const message =
                            typeof frame.message === 'string' && frame.message ? frame.message : 'The provider reported an error.';
                        throw new LlmRequestError(classifyStreamError(frame.code), message);
                    }
                    default:
                        break;
                }
            }

            if (signal.aborted) throw cancelled();

            const toolCalls = accumulator.close();
            if (toolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_calls';
            if (toolCalls.length > 0 && finishReason === 'unknown') finishReason = 'tool_calls';
            const providerBlocks = replayItems(outputItems, callKeys, toolCalls, text);

            return {
                text,
                thinking,
                toolCalls,
                finishReason,
                usage,
                ...(citations.length > 0 ? { citations } : {}),
                ...(providerBlocks.length > 0 ? { providerBlocks } : {}),
            };
        },
    };
}
