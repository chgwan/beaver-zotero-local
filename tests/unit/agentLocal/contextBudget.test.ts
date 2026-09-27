import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CONTEXT_WINDOW,
    ELIDED_TOOL_RESULT,
    MIN_TRANSCRIPT_BUDGET,
    elideToolResults,
    estimateTokens,
    fitTranscript,
    transcriptBudget,
} from '@beaver/agent-local/run/contextBudget';
import type { LlmMessage } from '@beaver/agent-local/llm/types';

const big = (n: number) => 'x'.repeat(n * 4); // n tokens
const toolCall = (id: string) => ({ id, name: 'read_attachment', args: {}, rawArgs: '{}', parseError: null });

/** system, user, then `rounds` rounds of one call + one 1000-token result. */
const transcript = (rounds: number): LlmMessage[] => {
    const messages: LlmMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'question' },
    ];
    for (let i = 0; i < rounds; i++) {
        messages.push({ role: 'assistant', content: '', toolCalls: [toolCall(`c${i}`)] });
        messages.push({ role: 'tool', content: big(1000), toolCallId: `c${i}` });
    }
    return messages;
};

describe('transcriptBudget', () => {
    it('is a share of a known window less the tool definitions', () => {
        expect(transcriptBudget(100_000, 5_000)).toBe(65_000);
    });

    it('uses a conservative default window when the window is unknown', () => {
        expect(transcriptBudget(null, 0)).toBe(transcriptBudget(DEFAULT_CONTEXT_WINDOW, 0));
        expect(transcriptBudget(undefined, 0)).toBe(transcriptBudget(DEFAULT_CONTEXT_WINDOW, 0));
    });

    it('never drops below a floor', () => {
        expect(transcriptBudget(2_000, 5_000)).toBe(MIN_TRANSCRIPT_BUDGET);
    });
});

describe('fitTranscript', () => {
    it('leaves a transcript under budget untouched', () => {
        const messages = transcript(2);
        expect(fitTranscript(messages, 10_000)).toEqual(messages);
    });

    it('elides older tool results first and keeps the latest round intact', () => {
        const messages = transcript(4);
        const fitted = fitTranscript(messages, 2_500);
        const tools = fitted.filter((m) => m.role === 'tool').map((m) => m.content);
        expect(tools).toEqual([ELIDED_TOOL_RESULT, ELIDED_TOOL_RESULT, big(1000), big(1000)]);
        expect(estimateTokens(fitted)).toBeLessThanOrEqual(2_500);
    });

    it('never touches the system message, the user message, or tool-call pairing', () => {
        const messages = transcript(4);
        const fitted = fitTranscript(messages, 10);
        expect(fitted[0]).toEqual(messages[0]);
        expect(fitted[1]).toEqual(messages[1]);
        expect(fitted.map((m) => m.role)).toEqual(messages.map((m) => m.role));
        expect(fitted.map((m) => m.toolCallId)).toEqual(messages.map((m) => m.toolCallId));
        expect(fitted.map((m) => m.toolCalls)).toEqual(messages.map((m) => m.toolCalls));
        // The latest round's result survives even when the budget cannot be met.
        expect(fitted[fitted.length - 1].content).toBe(big(1000));
    });

    it('does not mutate its input', () => {
        const messages = transcript(3);
        const before = JSON.stringify(messages);
        fitTranscript(messages, 100);
        expect(JSON.stringify(messages)).toBe(before);
    });
});

describe('elideToolResults', () => {
    it('can elide every tool result when nothing is protected', () => {
        const fitted = elideToolResults(transcript(2), 10);
        expect(fitted.filter((m) => m.role === 'tool').every((m) => m.content === ELIDED_TOOL_RESULT)).toBe(true);
    });
});

describe('estimateTokens with provider blocks', () => {
    it('counts an assistant turn replayed from raw provider blocks', () => {
        const blocks = [{ type: 'web_search_tool_result', content: [{ encrypted_content: big(1_000) }] }];
        const plain: LlmMessage = { role: 'assistant', content: 'ok' };
        expect(estimateTokens([{ ...plain, providerBlocks: blocks }])).toBeGreaterThan(estimateTokens([plain]) + 900);
    });
});
