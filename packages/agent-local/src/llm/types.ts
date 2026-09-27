/**
 * The provider-agnostic contract the loop programs against.
 *
 * Text is delivered **cumulatively**, not as deltas: a part frame replaces the
 * content at its coordinate, so a client that handed out deltas would force
 * every caller to re-accumulate and get it wrong somewhere.
 */

import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import type { LocalToolDefinition } from '../tools/toolSchemas';
import type { AccumulatedToolCall } from './toolCallAccumulator';

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Present on an assistant turn that called tools. */
    toolCalls?: AccumulatedToolCall[];
    /** Present on a tool result, naming the call it answers. */
    toolCallId?: string;
}

export interface LlmStreamHandlers {
    /** Called with the full text accumulated so far. */
    onTextDelta(fullText: string): void;
    /** Called with the full reasoning text accumulated so far. */
    onThinkingDelta(fullText: string): void;
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'unknown';

/** Token accounting for one turn, in the provider-neutral shape the loop sums. */
export interface LlmUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface LlmTurnResult {
    text: string;
    thinking: string;
    toolCalls: AccumulatedToolCall[];
    finishReason: LlmFinishReason;
    /** Null when the provider never reported usage for this turn. */
    usage: LlmUsage | null;
}

export interface LlmTurnRequest {
    model: CustomChatModel;
    messages: LlmMessage[];
    tools: LocalToolDefinition[];
}

export interface LlmClient {
    /**
     * Run one turn to completion or rejection.
     *
     * Cancellation contract: once `signal` is aborted, `streamTurn` must
     * reject with `LlmRequestError('cancelled', ...)` rather than resolve
     * with a partial result — before the request is sent, while it is
     * in flight, and after the stream ends. A caller that reads `signal`
     * to distinguish "the user stopped this" from "the provider failed"
     * must get a consistent answer regardless of when the abort happened.
     */
    streamTurn(
        request: LlmTurnRequest,
        handlers: LlmStreamHandlers,
        signal: AbortSignal
    ): Promise<LlmTurnResult>;
}

/** How a provider failure should be described to the user. */
export type LlmErrorKind = 'auth' | 'rate_limit' | 'server' | 'network' | 'bad_request' | 'cancelled';

export class LlmRequestError extends Error {
    constructor(
        readonly kind: LlmErrorKind,
        message: string
    ) {
        super(message);
        this.name = 'LlmRequestError';
    }
}

/** Map an HTTP status to the error kind the user sees. */
export function classifyHttpStatus(status: number): LlmErrorKind {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'server';
    return 'bad_request';
}

/** Pull the provider's own message out of an error body, if it has one. */
export function providerErrorMessage(body: string, fallback: string): string {
    try {
        const parsed = JSON.parse(body);
        const message = parsed?.error?.message ?? parsed?.message;
        if (typeof message === 'string' && message.length > 0) return message;
    } catch {
        // Not JSON; fall through to the raw body.
    }
    return body.trim().length > 0 ? body.trim().slice(0, 500) : fallback;
}

/** Join an endpoint base and a path without doubling the separator. */
export function joinEndpoint(apiBase: string, path: string): string {
    return `${apiBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
