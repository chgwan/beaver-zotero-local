/**
 * Streaming client for Anthropic's Messages API.
 *
 * Differs from the OpenAI shape in ways that matter to every layer: the system
 * prompt is a top-level parameter rather than a message, auth is `x-api-key`
 * with a version header, and content arrives as indexed blocks whose deltas are
 * typed. Tool input streams as `input_json_delta.partial_json`, reassembled by
 * the shared accumulator keyed on the block index.
 */

import { readSseEvents } from './sseReader';
import { ToolCallAccumulator } from './toolCallAccumulator';
import {
    LlmRequestError,
    classifyHttpStatus,
    joinEndpoint,
    providerErrorMessage,
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

const mapStopReason = (reason: string | null | undefined): LlmFinishReason => {
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'max_tokens') return 'length';
    return 'unknown';
};

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

            const payload: Record<string, unknown> = {
                model: model.snapshot,
                stream: true,
                max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
                messages: wire,
            };
            if (system) payload.system = system;
            if (tools.length > 0) {
                payload.tools = tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.parameters,
                }));
            }

            const url = joinEndpoint(stripTrailingV1(model.api_base ?? ''), 'v1/messages');

            let response: Response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': model.api_key,
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

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new LlmRequestError(
                    classifyHttpStatus(response.status),
                    providerErrorMessage(body, `${response.status} ${response.statusText}`)
                );
            }
            if (!response.body) {
                throw new LlmRequestError('server', 'The provider returned no response body.');
            }

            const accumulator = new ToolCallAccumulator();
            let text = '';
            let thinking = '';
            let finishReason: LlmFinishReason = 'unknown';
            // Input and output tokens arrive on separate frame types
            // (`message_start` and `message_delta`), so each is tracked
            // independently and combined only once the stream ends.
            let inputTokens: number | null = null;
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
                    const startInputTokens = frame.message?.usage?.input_tokens;
                    if (typeof startInputTokens === 'number') inputTokens = startInputTokens;
                    continue;
                }

                if (type === 'content_block_start') {
                    const block = frame.content_block ?? {};
                    if (block.type === 'tool_use') {
                        accumulator.open(frame.index ?? 0, { id: block.id, name: block.name });
                    }
                    continue;
                }

                if (type === 'content_block_delta') {
                    const delta = frame.delta ?? {};
                    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
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
                        typeof delta.partial_json === 'string'
                    ) {
                        accumulator.appendArguments(frame.index ?? 0, delta.partial_json);
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

            // Null unless the provider sent at least one of the two counts.
            const usage: LlmUsage | null =
                inputTokens !== null || outputTokens !== null
                    ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
                    : null;

            return { text, thinking, toolCalls, finishReason, usage };
        },
    };
}
