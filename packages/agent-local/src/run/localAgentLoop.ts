/**
 * The local agent loop: prompt, stream, run tools, repeat.
 *
 * It emits the same frames as the hosted backend through `WSCallbacks`, so the
 * renderer treats a local run like any other. All frames go through a
 * `FrameEmitter`, which owns the coordinate rules; this loop decides what goes
 * at each coordinate:
 *
 *  - Round `r` writes its assistant message at index `2r` and its tool
 *    returns at `2r+1`. Within the message, a part index is claimed the first
 *    time a kind of content appears (thinking, text) and never reassigned, and
 *    tool calls follow in the order the provider sent them. Text is written at
 *    exactly one coordinate, so it can never render twice.
 *  - Every tool call gets exactly one tool return.
 *  - A failing tool is not a failing run. Unparseable arguments and handler
 *    errors go back to the model as failed tool returns so it can correct
 *    itself; a call whose arguments did not parse is never executed.
 *  - A turn the provider paused (a long hosted web search) is sent again with
 *    its partial content appended, and continues at the same coordinates. It
 *    stays one round: continuations do not count against the round cap, and
 *    are bounded by `MAX_PAUSE_CONTINUATIONS` instead.
 *  - Sources cited by hosted web search are appended to the round's text as a
 *    markdown list, at the text's own coordinate.
 *  - A cancelled run ends silently: the caller that aborted the signal owns
 *    reporting it. A provider failure ends the run with an error and no
 *    completion frames.
 */

import type { BeaverAgentPrompt, ModelRequestUsage, RunUsage } from '@beaver/agent-core/agents/types';
import type { WSCallbacks, WSReadyData } from '@beaver/agent-core/protocol/agentProtocol';
import { ProcessingMode, SubscriptionStatus } from '@beaver/agent-core/types/profile';
import type { LocalAgentConfig } from '../config/localAgentConfig';
import type { AccumulatedToolCall } from '../llm/toolCallAccumulator';
import {
    LlmRequestError,
    addCitation,
    type LlmCitation,
    type LlmClient,
    type LlmMessage,
    type LlmTurnResult,
    type LlmUsage,
    type LlmWebSearchOptions,
} from '../llm/types';
import type { LocalToolCatalog } from '../tools/toolCatalog';
import { fitTranscript, tokensForChars, transcriptBudget } from './contextBudget';
import { FrameEmitter, type RoundFrames } from './frameEmitter';
import { buildSystemPrompt } from './systemPrompt';
import { buildToolReturnMetadata } from './toolReturnMetadata';
import { renderUserPrompt } from './userPrompt';

export interface LocalAgentLoopOptions {
    runId: string;
    /** The run's thread, or null to start a new one. */
    threadId: string | null;
    /** Mints the id announced via `onThread` when `threadId` is null. */
    newThreadId: () => string;
    /**
     * The user's message, already scoped to the searchable libraries (see
     * `scopePromptToLibraries`). It is rendered into the user turn by
     * `renderUserPrompt`; `custom_instructions` is appended to the system
     * prompt.
     */
    userPrompt: BeaverAgentPrompt;
    /** Earlier turns of the same thread, oldest first. */
    history?: LlmMessage[];
    config: LocalAgentConfig;
    client: LlmClient;
    catalog: LocalToolCatalog;
    callbacks: WSCallbacks;
    signal: AbortSignal;
    /** Replaces the built-in system prompt. */
    systemPrompt?: string;
    /** Provider-hosted web search, passed to every provider request of the run. */
    webSearch?: LlmWebSearchOptions;
}

/** Times one round may continue a paused turn before settling for what it has. */
export const MAX_PAUSE_CONTINUATIONS = 4;

/**
 * Session data for `onReady`. A local run has no subscription, is processed
 * entirely on this device, and uses no remote index.
 */
const LOCAL_READY_DATA: WSReadyData = {
    subscriptionStatus: SubscriptionStatus.FREE,
    processingMode: ProcessingMode.FRONTEND,
    indexingComplete: false,
};

/** The outcome of one tool call, in both the forms the loop needs. */
interface ToolCallOutcome {
    outcome: 'success' | 'failed';
    /** Rendered by the result card: the handler response, or an error message. */
    content: Record<string, unknown> | string;
    /** Sent back to the model. */
    transcriptText: string;
    metadata?: Record<string, unknown>;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Sums per-round provider usage into the run's usage. */
class UsageTally {
    private readonly perRequest: ModelRequestUsage[] = [];
    private requests = 0;
    private toolCalls = 0;
    private reported = false;

    addRequest(usage: LlmUsage | null): void {
        this.requests++;
        if (!usage) return;
        this.reported = true;
        this.perRequest.push({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens });
    }

    addSuccessfulToolCall(): void {
        this.toolCalls++;
    }

    /** Null when no request reported usage, so the UI shows none rather than zero. */
    toRunUsage(): RunUsage | null {
        if (!this.reported) return null;
        let input = 0;
        let output = 0;
        for (const entry of this.perRequest) {
            input += entry.input_tokens;
            output += entry.output_tokens ?? 0;
        }
        return {
            requests: this.requests,
            tool_calls: this.toolCalls,
            input_tokens: input,
            output_tokens: output,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            input_audio_tokens: 0,
            cache_audio_read_tokens: 0,
            model_requests: [...this.perRequest],
        };
    }
}

/** Escape the characters that would end a markdown link label early. */
const escapeLinkLabel = (label: string): string => label.replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ');

/** A markdown "Sources" list for cited URLs, or '' when there are none. */
export function formatSources(citations: readonly LlmCitation[]): string {
    if (citations.length === 0) return '';
    const lines = citations.map((citation) => `- [${escapeLinkLabel(citation.title)}](${citation.url.replace(/\)/g, '%29')})`);
    return `\n\nSources:\n${lines.join('\n')}`;
}

/**
 * Join text from before a paused turn with its continuation. The pause fell
 * at a search, so the continuation starts a new paragraph unless the earlier
 * text already ends in whitespace.
 */
const joinContinuation = (before: string, next: string): string =>
    before.length > 0 && next.length > 0 && !/\s$/.test(before) && !/^\s/.test(next)
        ? `${before}\n\n${next}`
        : before + next;

/** One round's result. */
interface RoundResult {
    /** The whole round as rendered: text and reasoning across continuations, with sources. */
    turn: LlmTurnResult;
    /**
     * The round's transcript entries, oldest first: one assistant message per
     * paused request, then the last request's message, whose content carries
     * the sources list. Only needed when the round called tools.
     */
    messages: LlmMessage[];
}

/**
 * Stream one assistant turn into `frames`, then emit its tool calls.
 *
 * The client reports text and reasoning cumulatively, so each re-emit replaces
 * the part at its coordinate. After the stream, the turn's final text is
 * written to the same coordinate if it differs from the last streamed value
 * (or claims one if nothing streamed) — a provider that also returns an
 * aggregated message never produces a second copy.
 *
 * A paused turn is continued in place: the next request's text and reasoning
 * are written after what the paused one produced, at the same coordinates.
 */
async function streamRound(
    frames: RoundFrames,
    options: LocalAgentLoopOptions,
    transcript: LlmMessage[],
    allowTools: boolean,
    hooks: { onRequest(usage: LlmUsage | null): void; onWarning(message: string): void }
): Promise<RoundResult> {
    const { client, config, catalog, signal } = options;
    let nextPartIndex = 0;
    let thinkingIndex: number | null = null;
    let textIndex: number | null = null;
    let lastThinking = '';
    let lastText = '';

    const writeThinking = (content: string) => {
        if (thinkingIndex === null) thinkingIndex = nextPartIndex++;
        lastThinking = content;
        frames.thinking(thinkingIndex, content);
    };
    const writeText = (content: string) => {
        if (textIndex === null) textIndex = nextPartIndex++;
        lastText = content;
        frames.text(textIndex, content);
    };

    // A problem repeated across a round's requests (a search limit hit again
    // after a pause) is reported once.
    const warned = new Set<string>();
    const warnOnce = (message: string) => {
        if (warned.has(message)) return;
        warned.add(message);
        hooks.onWarning(message);
    };
    const paused: LlmMessage[] = [];
    const citations: LlmCitation[] = [];
    let textBefore = '';
    let thinkingBefore = '';
    let turn: LlmTurnResult;
    for (let continuation = 0; ; continuation++) {
        turn = await client.streamTurn(
            {
                model: config.model,
                messages: [...transcript, ...paused],
                tools: catalog.definitions(),
                ...(allowTools ? {} : { toolChoice: 'none' as const }),
                ...(options.webSearch ? { webSearch: options.webSearch } : {}),
            },
            {
                onThinkingDelta: (fullText) => {
                    if (fullText) writeThinking(joinContinuation(thinkingBefore, fullText));
                },
                onTextDelta: (fullText) => {
                    if (fullText) writeText(joinContinuation(textBefore, fullText));
                },
                onWarning: warnOnce,
            },
            signal
        );
        hooks.onRequest(turn.usage);
        for (const citation of turn.citations ?? []) addCitation(citations, citation.url, citation.title);

        if (turn.finishReason !== 'pause') break;
        if (continuation >= MAX_PAUSE_CONTINUATIONS) {
            warnOnce(
                'The provider paused its web search too many times; showing the answer so far. ' +
                    'Send a follow-up to continue.'
            );
            break;
        }
        paused.push({
            role: 'assistant',
            content: turn.text,
            ...(turn.providerBlocks ? { providerBlocks: turn.providerBlocks } : {}),
        });
        textBefore = joinContinuation(textBefore, turn.text);
        thinkingBefore = joinContinuation(thinkingBefore, turn.thinking);
    }

    const sources = formatSources(citations);
    const text = joinContinuation(textBefore, turn.text) + sources;
    const thinking = joinContinuation(thinkingBefore, turn.thinking);
    if (thinking && thinking !== lastThinking) writeThinking(thinking);
    if (text && text !== lastText) writeText(text);

    for (const call of turn.toolCalls) {
        frames.toolCall(nextPartIndex++, {
            id: call.id,
            name: call.name,
            args: call.parseError ? call.rawArgs : call.args,
        });
    }
    frames.sealParts();

    const last: LlmMessage = {
        role: 'assistant',
        content: turn.text + sources,
        toolCalls: turn.toolCalls,
        ...(turn.providerBlocks ? { providerBlocks: turn.providerBlocks } : {}),
    };
    return {
        turn: { ...turn, text, thinking, ...(citations.length > 0 ? { citations } : {}) },
        messages: [...paused, last],
    };
}

async function runToolCall(call: AccumulatedToolCall, catalog: LocalToolCatalog, signal: AbortSignal): Promise<ToolCallOutcome> {
    if (call.parseError) {
        const message = `The call to "${call.name}" was not run. ${call.parseError} Send the arguments again as a single JSON object.`;
        return { outcome: 'failed', content: message, transcriptText: message };
    }

    const result = await catalog.execute(call.name, call.args, signal);
    if (!result.ok) {
        const message = result.retryable ? result.error : `${result.error} Retrying this call will not help.`;
        return { outcome: 'failed', content: message, transcriptText: message };
    }

    return {
        outcome: 'success',
        content: result.content,
        transcriptText: result.text,
        // A tool that supplies its own render metadata knows its card best;
        // handler tools get theirs derived from the response.
        metadata: result.metadata ?? buildToolReturnMetadata(call.name, result.content, call.args),
    };
}

function roundCapReturn(call: AccumulatedToolCall, maxRounds: number): ToolCallOutcome {
    const message = `The call to "${call.name}" was not run: this run reached its limit of ${maxRounds} rounds.`;
    return { outcome: 'failed', content: message, transcriptText: message };
}

/**
 * Run one local agent turn to completion, cancellation, or failure. Resolves
 * in every case, once every frame it emitted has been delivered and its
 * callback settled; outcomes are reported through `options.callbacks`.
 */
export async function runLocalAgentLoop(options: LocalAgentLoopOptions): Promise<void> {
    const { runId, config, catalog, callbacks, signal } = options;
    const emitter = new FrameEmitter({ runId, callbacks });
    const usage = new UsageTally();

    const systemPrompt =
        options.systemPrompt ??
        buildSystemPrompt({
            toolNames: catalog.definitions().map((tool) => tool.name),
            customInstructions: options.userPrompt.custom_instructions,
        });
    let transcript: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        ...(options.history ?? []),
        { role: 'user', content: renderUserPrompt(options.userPrompt, { webSearchRequested: options.webSearch?.enabled === true }) },
    ];

    // Tool results are what grows a run's transcript; older ones are elided
    // before any call that would overflow the model's context window.
    const toolDefinitionTokens = tokensForChars(JSON.stringify(catalog.definitions()).length);
    const budget = transcriptBudget(config.model.context_window, toolDefinitionTokens);

    callbacks.onReady(LOCAL_READY_DATA);
    if (options.threadId === null) {
        callbacks.onThread(options.newThreadId());
    }

    try {
        for (let round = 0; round < config.maxRounds; round++) {
            const frames = emitter.beginRound();
            transcript = fitTranscript(transcript, budget);
            // The last allowed round forbids tool calls: results from it
            // could never reach the model, so it has to answer instead.
            const lastRound = round === config.maxRounds - 1;
            const { turn, messages } = await streamRound(frames, options, transcript, !lastRound, {
                onRequest: (requestUsage) => usage.addRequest(requestUsage),
                onWarning: (message) => emitter.warning({ type: 'local_web_search', message }),
            });

            if (turn.toolCalls.length === 0) {
                await emitter.finish(usage.toRunUsage());
                return;
            }

            // The renderer must hold each tool call before its return arrives.
            await emitter.flush();

            transcript.push(...messages);

            for (const call of turn.toolCalls) {
                // A provider that ignores the last round's tool_choice still
                // gets an answer for every call, but nothing is run for it.
                const result = lastRound ? roundCapReturn(call, config.maxRounds) : await runToolCall(call, catalog, signal);
                // Cancelled while the tool ran: the run is over, and its frames
                // must not land on a run the UI has already stopped.
                if (signal.aborted) {
                    await emitter.flush();
                    return;
                }
                if (result.outcome === 'success') usage.addSuccessfulToolCall();

                frames.toolReturn({
                    part_kind: 'tool-return',
                    tool_name: call.name,
                    tool_call_id: call.id,
                    content: result.content,
                    outcome: result.outcome,
                    ...(result.metadata ? { metadata: result.metadata } : {}),
                });
                transcript.push({ role: 'tool', content: result.transcriptText, toolCallId: call.id });
            }
            await emitter.flush();
        }

        // Out of rounds with the model still calling tools. Stop cleanly: what
        // it has written so far is more useful than an error.
        emitter.warning({
            type: 'local_round_cap',
            message:
                `Stopped after ${config.maxRounds} rounds of tool calls without a final answer. ` +
                'Send a follow-up to continue, or narrow the question.',
        });
        await emitter.finish(usage.toRunUsage());
    } catch (error) {
        const cancelled = (error instanceof LlmRequestError && error.kind === 'cancelled') || signal.aborted;
        if (cancelled) {
            // Frames emitted before the stop still reach the renderer, in order.
            await emitter.flush();
            return;
        }

        await emitter.fail({
            type: error instanceof LlmRequestError ? 'local_provider_error' : 'local_agent_error',
            message: describeError(error),
            details: error instanceof LlmRequestError ? error.kind : undefined,
            // Not retried automatically. The error view still offers a manual
            // retry, which starts a new local run.
            is_retryable: false,
        });
    }
}
