/**
 * Keeping a local run's transcript inside the model's context window.
 *
 * Token counts are estimated, not measured: about four characters per token,
 * which is close for English prose and JSON under common tokenizers and errs
 * low for dense scripts. No tokenizer ships with the plugin, and the budgets
 * below leave enough headroom for the estimate to be off.
 *
 * When a transcript is over budget, the text of older tool results is
 * replaced by a short marker, oldest first. Nothing else changes: the system
 * message, the user's messages, the assistant turns and every tool-call /
 * tool-result pair stay in place, so providers still accept the transcript
 * and the model can call a tool again for anything it lost.
 */

import type { LlmMessage } from '../llm/types';

/** Characters per token assumed by every estimate in local mode. */
export const CHARS_PER_TOKEN = 4;

/** Context window assumed for a model whose window the user did not set. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * Share of the context window the transcript may fill. The rest is left for
 * the reply and for the error in the estimate; tool definitions are
 * subtracted separately.
 */
export const TRANSCRIPT_CONTEXT_SHARE = 0.7;

/** Smallest transcript budget, however small the window. */
export const MIN_TRANSCRIPT_BUDGET = 1_000;

/** What an elided tool result is replaced with. */
export const ELIDED_TOOL_RESULT = '[earlier tool result omitted to save context; call the tool again if needed]';

/** Estimated tokens for a number of characters. */
export const tokensForChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const transcriptChars = (messages: readonly LlmMessage[]): number => {
    let chars = 0;
    for (const message of messages) {
        // Raw provider blocks can hold whole search results or encrypted
        // reasoning. Some clients send them in place of the text and calls,
        // others alongside them, so both are counted.
        if (message.providerBlocks?.length) {
            chars += JSON.stringify(message.providerBlocks).length;
        }
        chars += message.content.length;
        for (const call of message.toolCalls ?? []) chars += call.name.length + call.rawArgs.length;
    }
    return chars;
};

/** Estimated tokens of a transcript: message text, tool-call arguments, and replayed provider blocks. */
export function estimateTokens(messages: readonly LlmMessage[]): number {
    return tokensForChars(transcriptChars(messages));
}

/**
 * Tokens the transcript may use for a model: a share of its window (or of
 * `DEFAULT_CONTEXT_WINDOW` when unknown), less what the tool definitions
 * cost, but never below `MIN_TRANSCRIPT_BUDGET`.
 */
export function transcriptBudget(contextWindow: number | null | undefined, toolDefinitionTokens: number): number {
    const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
    return Math.max(MIN_TRANSCRIPT_BUDGET, Math.floor(window * TRANSCRIPT_CONTEXT_SHARE) - toolDefinitionTokens);
}

/**
 * Elide tool results, oldest first, until the transcript fits `budget`.
 * Tool results at or after `keepFrom` are never elided. Returns a new array;
 * the input is not changed. A transcript that still does not fit is returned
 * with everything eligible elided.
 */
export function elideToolResults(
    messages: readonly LlmMessage[],
    budget: number,
    keepFrom: number = messages.length
): LlmMessage[] {
    const result = [...messages];
    const budgetChars = budget * CHARS_PER_TOKEN;
    let chars = transcriptChars(result);
    for (let i = 0; i < Math.min(keepFrom, result.length) && chars > budgetChars; i++) {
        const message = result[i];
        if (message.role !== 'tool' || message.content.length <= ELIDED_TOOL_RESULT.length) continue;
        chars -= message.content.length - ELIDED_TOOL_RESULT.length;
        result[i] = { ...message, content: ELIDED_TOOL_RESULT };
    }
    return result;
}

/**
 * Fit a run's transcript to `budget` before a provider call. The results of
 * the latest tool round — everything after the last assistant turn — are
 * kept intact: the model has not seen them yet.
 */
export function fitTranscript(messages: readonly LlmMessage[], budget: number): LlmMessage[] {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            lastAssistant = i;
            break;
        }
    }
    const keepFrom = lastAssistant >= 0 ? lastAssistant + 1 : messages.length;
    return elideToolResults(messages, budget, keepFrom);
}
