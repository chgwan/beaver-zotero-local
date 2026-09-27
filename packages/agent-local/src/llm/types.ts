/**
 * The provider-agnostic contract the loop programs against.
 *
 * Text is delivered **cumulatively**, not as deltas: a part frame replaces the
 * content at its coordinate, so a client that handed out deltas would force
 * every caller to re-accumulate and get it wrong somewhere.
 */

import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import type { ToolSpec } from '../tools/toolSchemas';
import type { AccumulatedToolCall } from './toolCallAccumulator';

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Present on an assistant turn that called tools. */
    toolCalls?: AccumulatedToolCall[];
    /** Present on a tool result, naming the call it answers. */
    toolCallId?: string;
    /**
     * Provider content from an assistant turn that must be sent back
     * unchanged (hosted search calls, their encrypted results, cited text,
     * encrypted reasoning). The client that produced it decides how: the
     * Anthropic client replays these blocks instead of `content` and
     * `toolCalls`; the OpenAI Responses client sends them (reasoning items)
     * ahead of both. Other clients ignore them.
     */
    providerBlocks?: unknown[];
}

/** A source the provider's hosted web search cited. */
export interface LlmCitation {
    url: string;
    title: string;
}

export interface LlmStreamHandlers {
    /** Called with the full text accumulated so far. */
    onTextDelta(fullText: string): void;
    /** Called with the full reasoning text accumulated so far. */
    onThinkingDelta(fullText: string): void;
    /**
     * A non-fatal problem the user should know about, such as a hosted search
     * that failed while the turn itself went on.
     */
    onWarning?(message: string): void;
}

/**
 * `'pause'`: the provider paused a long server-side turn (hosted search) and
 * expects the same request again with the partial turn appended, to continue.
 */
export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'pause' | 'unknown';

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
    /** Sources cited by hosted web search in this turn, unique by URL. */
    citations?: LlmCitation[];
    /** See `LlmMessage.providerBlocks`; set only when the turn needs it. */
    providerBlocks?: unknown[];
}

/** Hosted web search for one turn. */
export interface LlmWebSearchOptions {
    enabled: boolean;
    /** Upper bound on searches in one provider request, where supported. */
    maxUses?: number;
}

export interface LlmTurnRequest {
    model: CustomChatModel;
    messages: LlmMessage[];
    tools: ToolSpec[];
    /**
     * `'none'` forbids tool calls this turn while still declaring the tools,
     * which a transcript that already contains tool calls needs. Defaults to
     * letting the model choose.
     */
    toolChoice?: 'auto' | 'none';
    /**
     * Ask the provider to run its own hosted web search. A client whose
     * provider has none adds nothing.
     */
    webSearch?: LlmWebSearchOptions;
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

/** Whether a provider error message is about the hosted web search tool. */
export function namesWebSearchTool(message: string): boolean {
    return /web[_ ]?search|server[_ ]tool|allowed_callers/i.test(message);
}

/** The error for a provider that rejected its hosted web search tool. */
export function webSearchUnsupportedError(providerMessage: string): LlmRequestError {
    return new LlmRequestError(
        'bad_request',
        'Web search is not available for this provider or model. ' +
            `Turn off web search for this message and try again. (${providerMessage})`
    );
}

/** Add a citation unless one with the same URL is already listed. */
export function addCitation(citations: LlmCitation[], url: unknown, title: unknown): void {
    if (typeof url !== 'string' || url.length === 0) return;
    if (citations.some((existing) => existing.url === url)) return;
    citations.push({ url, title: typeof title === 'string' && title.trim() ? title.trim() : url });
}

/** Join an endpoint base and a path without doubling the separator. */
export function joinEndpoint(apiBase: string, path: string): string {
    return `${apiBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
