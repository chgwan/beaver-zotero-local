/**
 * Earlier runs of a thread, replayed to the model as conversation history.
 *
 * Each run contributes its user message, the assistant's text, and every tool
 * call that has a matching tool return, with the return right after the call
 * that asked for it. Reasoning is not replayed. A call without a return (the
 * run was stopped while the tool ran) and a return without a call are both
 * dropped: providers reject a transcript in which either is unpaired.
 */

import type { AgentRun, ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import type { LlmMessage } from '../llm/types';

export interface RunHistoryOptions {
    /**
     * The model's context window in tokens. When set, the oldest runs are
     * dropped until the history fits in `HISTORY_CONTEXT_SHARE` of it, leaving
     * the rest for the system prompt, tool definitions, the new message, and
     * the reply.
     */
    contextWindow?: number | null;
}

/** The share of the context window history may use. */
export const HISTORY_CONTEXT_SHARE = 0.5;

/** Envelope and diagnostic fields that carry nothing for the model. */
const TRANSCRIPT_OMITTED_FIELDS = new Set(['type', 'request_id', 'timing']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** A rough token count: about four characters per token for typical text. */
export function estimateTokens(messages: readonly LlmMessage[]): number {
    let chars = 0;
    for (const message of messages) {
        chars += message.content.length;
        for (const call of message.toolCalls ?? []) chars += call.name.length + call.rawArgs.length;
    }
    return Math.ceil(chars / 4);
}

/**
 * A stored call's arguments, replayable as-is. Arguments that were not a JSON
 * object when the model sent them (the call was refused, never run) replay as
 * `{}`: strict servers reject a transcript with invalid tool-call arguments.
 */
function toolCallArgs(part: ToolCallPart): { args: Record<string, unknown>; rawArgs: string } {
    if (isRecord(part.args)) return { args: part.args, rawArgs: JSON.stringify(part.args) };
    if (typeof part.args === 'string') {
        try {
            const parsed: unknown = JSON.parse(part.args);
            if (isRecord(parsed)) return { args: parsed, rawArgs: part.args };
        } catch {
            // Replayed as an empty object below.
        }
    }
    return { args: {}, rawArgs: '{}' };
}

/** The text a tool return carried to the model when it was first produced. */
function toolReturnText(part: ToolReturnPart): string {
    if (typeof part.content === 'string') return part.content;
    if (isRecord(part.content)) {
        return JSON.stringify(
            Object.fromEntries(Object.entries(part.content).filter(([key]) => !TRANSCRIPT_OMITTED_FIELDS.has(key)))
        );
    }
    return JSON.stringify(part.content ?? null);
}

/** One run's messages, or an empty list when the run has no user message. */
function runMessages(run: AgentRun): LlmMessage[] {
    const prompt = run.user_prompt?.content ?? '';
    if (prompt.trim().length === 0) return [];

    const returns = new Map<string, ToolReturnPart>();
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'request') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-return') returns.set(part.tool_call_id, part);
        }
    }

    const messages: LlmMessage[] = [{ role: 'user', content: prompt }];
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'response') continue;
        let text = '';
        const calls: ToolCallPart[] = [];
        for (const part of message.parts) {
            if (part.part_kind === 'text') text += part.content;
            else if (part.part_kind === 'tool-call' && returns.has(part.tool_call_id)) calls.push(part);
        }
        if (text.length === 0 && calls.length === 0) continue;

        messages.push({
            role: 'assistant',
            content: text,
            ...(calls.length > 0
                ? {
                      toolCalls: calls.map((call) => ({
                          id: call.tool_call_id,
                          name: call.tool_name,
                          ...toolCallArgs(call),
                          parseError: null,
                      })),
                  }
                : {}),
        });
        for (const call of calls) {
            messages.push({
                role: 'tool',
                content: toolReturnText(returns.get(call.tool_call_id)!),
                toolCallId: call.tool_call_id,
            });
        }
    }
    return messages;
}

/**
 * Build the history for a new run from the thread's earlier runs, oldest
 * first. Only runs belonging to `threadId` are used; a new thread (null) has
 * no history.
 */
export function buildRunHistory(
    runs: readonly AgentRun[],
    threadId: string | null,
    options: RunHistoryOptions = {}
): LlmMessage[] {
    if (threadId === null) return [];
    const groups = runs
        .filter((run) => run.thread_id === threadId)
        .map(runMessages)
        .filter((group) => group.length > 0);

    const contextWindow = options.contextWindow;
    if (contextWindow && contextWindow > 0) {
        const budget = Math.floor(contextWindow * HISTORY_CONTEXT_SHARE);
        let total = groups.reduce((sum, group) => sum + estimateTokens(group), 0);
        while (groups.length > 0 && total > budget) {
            total -= estimateTokens(groups.shift()!);
        }
    }
    return groups.flat();
}
