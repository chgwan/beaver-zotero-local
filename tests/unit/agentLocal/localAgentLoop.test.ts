import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLocalAgentLoop, type LocalAgentLoopOptions } from '@beaver/agent-local/run/localAgentLoop';
import { LlmRequestError, type LlmTurnResult, type LlmUsage } from '@beaver/agent-local/llm/types';
import type { AccumulatedToolCall } from '@beaver/agent-local/llm/toolCallAccumulator';
import type { LocalAgentConfig } from '@beaver/agent-local/config/localAgentConfig';
import { ELIDED_TOOL_RESULT } from '@beaver/agent-local/run/contextBudget';
import { ProcessingMode, SubscriptionStatus } from '@beaver/agent-core/types/profile';
import { isExternalSearchResult } from '@beaver/agent-core/run-state/toolResultTypes';

const config: LocalAgentConfig = {
    model: {
        name: 'GPT',
        snapshot: 'gpt-4.1',
        api_key: 'sk',
        api_base: 'https://api.openai.com/v1',
        format: 'openai',
    } as LocalAgentConfig['model'],
    maxRounds: 20,
};

const recordingCallbacks = () => ({
    onReady: vi.fn(),
    onThread: vi.fn(),
    onPart: vi.fn(),
    onToolReturn: vi.fn(),
    onToolCallProgress: vi.fn(),
    onToolCallArgsStream: vi.fn(),
    onRunComplete: vi.fn(),
    onStreamingDone: vi.fn(),
    onRunCitations: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
});

interface ScriptedTurn {
    textChunks?: string[];
    thinkingChunks?: string[];
    /** Final text the provider reports, when it differs from the last delta. */
    finalText?: string;
    toolCalls?: AccumulatedToolCall[];
    usage?: LlmUsage | null;
}

/** A client that replays scripted turns, one per round. */
const scriptedClient = (turns: ScriptedTurn[]) => {
    let i = 0;
    return {
        streamTurn: vi.fn(async (_request: any, handlers: any): Promise<LlmTurnResult> => {
            const turn = turns[i++];
            for (const chunk of turn.thinkingChunks ?? []) handlers.onThinkingDelta(chunk);
            for (const chunk of turn.textChunks ?? []) handlers.onTextDelta(chunk);
            return {
                text: turn.finalText ?? turn.textChunks?.[turn.textChunks.length - 1] ?? '',
                thinking: turn.thinkingChunks?.[turn.thinkingChunks.length - 1] ?? '',
                toolCalls: turn.toolCalls ?? [],
                finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
                usage: turn.usage ?? null,
            };
        }),
    };
};

const okResult = (content: Record<string, unknown> = { items: [], total_count: 0 }) => ({
    ok: true as const,
    content,
    text: JSON.stringify(content),
});

const stubCatalog = (overrides: Record<string, unknown> = {}) => ({
    definitions: () => [
        {
            name: 'zotero_search',
            description: 'd',
            parameters: { type: 'object' as const, properties: {}, additionalProperties: false as const },
            requestEvent: 'zotero_search_request',
            buildRequest: () => ({ event: 'zotero_search_request', request_id: 'x' }),
        },
    ],
    execute: vi.fn(async (): Promise<any> => okResult()),
    ...overrides,
});

const call = (
    id: string,
    args: Record<string, unknown>,
    parseError: string | null = null,
    name = 'zotero_search'
): AccumulatedToolCall => ({
    id,
    name,
    args,
    rawArgs: parseError ? '{"query": "x' : JSON.stringify(args),
    parseError,
});

const run = (
    client: any,
    callbacks: ReturnType<typeof recordingCallbacks>,
    catalog: any = stubCatalog(),
    extra: Partial<LocalAgentLoopOptions> = {}
) =>
    runLocalAgentLoop({
        runId: 'run-1',
        threadId: 'thread-1',
        newThreadId: () => 'new-thread',
        userPrompt: { content: 'find papers on x' },
        config,
        client,
        catalog,
        callbacks: callbacks as any,
        signal: new AbortController().signal,
        ...extra,
    });

const partsOf = (callbacks: ReturnType<typeof recordingCallbacks>) =>
    callbacks.onPart.mock.calls.map(([e]) => e);

describe('runLocalAgentLoop', () => {
    let callbacks: ReturnType<typeof recordingCallbacks>;
    beforeEach(() => {
        vi.clearAllMocks();
        callbacks = recordingCallbacks();
    });

    it('signals ready with local session data before the first provider request', async () => {
        const client = scriptedClient([{ textChunks: ['Ready.'] }]);
        await run(client, callbacks);
        expect(callbacks.onReady).toHaveBeenCalledTimes(1);
        expect(callbacks.onReady).toHaveBeenCalledWith({
            subscriptionStatus: SubscriptionStatus.FREE,
            processingMode: ProcessingMode.FRONTEND,
            indexingComplete: false,
        });
        expect(callbacks.onReady.mock.invocationCallOrder[0]).toBeLessThan(
            client.streamTurn.mock.invocationCallOrder[0]
        );
    });

    it('assigns a new thread right after ready when the run has none', async () => {
        const client = scriptedClient([{ textChunks: ['Ready.'] }]);
        await run(client, callbacks, stubCatalog(), { threadId: null });
        expect(callbacks.onThread).toHaveBeenCalledTimes(1);
        expect(callbacks.onThread).toHaveBeenCalledWith('new-thread');
        expect(callbacks.onReady.mock.invocationCallOrder[0]).toBeLessThan(
            callbacks.onThread.mock.invocationCallOrder[0]
        );
        expect(callbacks.onThread.mock.invocationCallOrder[0]).toBeLessThan(
            client.streamTurn.mock.invocationCallOrder[0]
        );
    });

    it('does not announce a thread when continuing an existing one', async () => {
        await run(scriptedClient([{ textChunks: ['Ready.'] }]), callbacks);
        expect(callbacks.onThread).not.toHaveBeenCalled();
    });

    it('sends system prompt, history, then the user prompt, with custom instructions in the system prompt', async () => {
        const client = scriptedClient([{ textChunks: ['Ready.'] }]);
        await run(client, callbacks, stubCatalog(), {
            userPrompt: { content: 'and now?', custom_instructions: 'Answer in French.' },
            history: [
                { role: 'user', content: 'earlier question' },
                { role: 'assistant', content: 'earlier answer' },
            ],
        });
        const messages = client.streamTurn.mock.calls[0][0].messages;
        expect(messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(messages[0].content).toContain('zotero_search');
        expect(messages[0].content).toContain('Answer in French.');
        expect(messages[3].content).toBe('and now?');
    });

    it('sends the rendered user prompt: text plus action prompts, attachments and reader state', async () => {
        const client = scriptedClient([{ textChunks: ['Ready.'] }]);
        await run(client, callbacks, stubCatalog(), {
            userPrompt: {
                content: '/summarize',
                actions: [{ command: 'summarize', action_id: 'a', prompt: 'Summarize in three bullets.' }],
                attachments: [{ type: 'note', library_id: 1, library_ref: 'u', zotero_key: 'NOTEKEY1' }],
                application_state: {
                    current_view: 'file_reader',
                    reader_state: { library_id: 1, library_ref: 'u', zotero_key: 'PDFKEY01', current_page: 4 },
                },
            },
        });
        const user = client.streamTurn.mock.calls[0][0].messages[1];
        expect(user.role).toBe('user');
        expect(user.content).toContain('/summarize');
        expect(user.content).toContain('Summarize in three bullets.');
        expect(user.content).toContain('u-NOTEKEY1');
        expect(user.content).toContain('attachment u-PDFKEY01, on page 4');
    });

    it('offers the catalog definitions to the provider', async () => {
        const client = scriptedClient([{ textChunks: ['Ready.'] }]);
        await run(client, callbacks);
        const request = client.streamTurn.mock.calls[0][0];
        expect(request.tools.map((t: any) => t.name)).toEqual(['zotero_search']);
        expect(request.model).toBe(config.model);
    });

    it('emits every text part at one coordinate so nothing duplicates', async () => {
        await run(scriptedClient([{ textChunks: ['Rea', 'Ready.'] }]), callbacks);
        const parts = partsOf(callbacks);
        const coordinates = new Set(parts.map((p) => `${p.message_index}:${p.part_index}`));
        expect(coordinates.size).toBe(1);
        expect(parts[parts.length - 1].part.content).toBe('Ready.');
    });

    it('keeps one coordinate when the provider also returns a final aggregated message', async () => {
        await run(
            scriptedClient([{ textChunks: ['Rea', 'Ready'], finalText: 'Ready.' }]),
            callbacks
        );
        const textParts = partsOf(callbacks).filter((p) => p.part.part_kind === 'text');
        const coordinates = new Set(textParts.map((p) => `${p.message_index}:${p.part_index}`));
        expect(coordinates.size).toBe(1);
        expect(textParts[textParts.length - 1].part.content).toBe('Ready.');
    });

    it('does not re-emit final text that matches what was streamed', async () => {
        await run(scriptedClient([{ textChunks: ['Rea', 'Ready.'], finalText: 'Ready.' }]), callbacks);
        expect(callbacks.onPart).toHaveBeenCalledTimes(2);
    });

    it('emits the final text once when the provider streamed no deltas', async () => {
        await run(scriptedClient([{ finalText: 'Ready.' }]), callbacks);
        const parts = partsOf(callbacks);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ message_index: 0, part_index: 0, part: { part_kind: 'text', content: 'Ready.' } });
    });

    it('places thinking and text on different part indices of the same message', async () => {
        await run(scriptedClient([{ thinkingChunks: ['hmm'], textChunks: ['Ready.'] }]), callbacks);
        const parts = partsOf(callbacks);
        const byKind = new Map(parts.map((e) => [e.part.part_kind, e.part_index]));
        expect(byKind.get('thinking')).toBe(0);
        expect(byKind.get('text')).toBe(1);
        expect(new Set(parts.map((e) => e.message_index))).toEqual(new Set([0]));
    });

    it('places tool calls after the text of the same assistant message', async () => {
        const client = scriptedClient([
            { textChunks: ['Looking…'], toolCalls: [call('c1', { query: 'x' }), call('c2', { query: 'y' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks);
        const firstRound = partsOf(callbacks).filter((p) => p.message_index === 0);
        expect(firstRound.map((p) => [p.part_index, p.part.part_kind])).toEqual([
            [0, 'text'],
            [1, 'tool-call'],
            [2, 'tool-call'],
        ]);
        expect(firstRound[1].part).toMatchObject({
            tool_name: 'zotero_search',
            tool_call_id: 'c1',
            args: { query: 'x' },
        });
    });

    it('keeps a second round on message indices the first round never used', async () => {
        const client = scriptedClient([
            { textChunks: ['Looking…'], toolCalls: [call('c1', { query: 'x' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks);
        const partIndices = callbacks.onPart.mock.calls.map(([e]) => e.message_index);
        const returnIndices = callbacks.onToolReturn.mock.calls.map(([e]) => e.message_index);
        expect(new Set(partIndices)).toEqual(new Set([0, 2]));
        expect(new Set(returnIndices)).toEqual(new Set([1]));
    });

    it('emits exactly one tool return per call', async () => {
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' }), call('c2', { query: 'y' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks);
        expect(callbacks.onToolReturn).toHaveBeenCalledTimes(2);
        const ids = callbacks.onToolReturn.mock.calls.map(([e]) => e.part.tool_call_id);
        expect(ids).toEqual(['c1', 'c2']);
    });

    it('returns the handler response object as content with a success outcome', async () => {
        const content = { items: [{ item_id: 'u-ABC' }], total_count: 1 };
        const catalog = stubCatalog({ execute: vi.fn(async () => okResult(content)) });
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        expect(catalog.execute).toHaveBeenCalledWith('zotero_search', { query: 'x' }, expect.anything());
        const part = callbacks.onToolReturn.mock.calls[0][0].part;
        expect(part).toMatchObject({
            part_kind: 'tool-return',
            tool_name: 'zotero_search',
            tool_call_id: 'c1',
            outcome: 'success',
        });
        expect(part.content).toEqual(content);
    });

    it('feeds the transcript text of a tool result back to the provider on the next round', async () => {
        const content = { items: [], total_count: 0 };
        const catalog = stubCatalog({
            execute: vi.fn(async () => ({ ok: true, content, text: 'TRANSCRIPT TEXT' })),
        });
        const client = scriptedClient([
            { textChunks: ['Looking'], toolCalls: [call('c1', { query: 'x' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        const second = client.streamTurn.mock.calls[1][0].messages;
        expect(second.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
        expect(second[2]).toMatchObject({ content: 'Looking', toolCalls: [expect.objectContaining({ id: 'c1' })] });
        expect(second[3]).toEqual({ role: 'tool', content: 'TRANSCRIPT TEXT', toolCallId: 'c1' });
    });

    it('never executes a call whose arguments failed to parse, and tells the model why', async () => {
        const catalog = stubCatalog();
        const client = scriptedClient([
            { toolCalls: [call('c1', {}, 'Tool arguments were not valid JSON: Unexpected end of JSON input')] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        expect(catalog.execute).not.toHaveBeenCalled();

        const callPart = partsOf(callbacks).find((p) => p.part.part_kind === 'tool-call');
        expect(callPart?.part.args).toBe('{"query": "x');

        expect(callbacks.onToolReturn).toHaveBeenCalledTimes(1);
        const part = callbacks.onToolReturn.mock.calls[0][0].part;
        expect(part.outcome).toBe('failed');
        expect(part.content).toContain('not valid JSON');

        const toolMessage = client.streamTurn.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
        expect(toolMessage.content).toBe(part.content);
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });

    it('returns a tool execution failure to the model as a failed tool return', async () => {
        const catalog = stubCatalog({
            execute: vi.fn(async () => ({ ok: false, error: 'boom', retryable: true })),
        });
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        const part = callbacks.onToolReturn.mock.calls[0][0].part;
        expect(part.outcome).toBe('failed');
        expect(part.content).toContain('boom');
        expect(part.metadata).toBeUndefined();
        const toolMessage = client.streamTurn.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
        expect(toolMessage.content).toContain('boom');
        expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('attaches the render summary the result card needs', async () => {
        const content = {
            type: 'item_search_by_metadata',
            request_id: 'r',
            items: [{ item: { library_id: 1, zotero_key: 'AAA', item_type: 'book' }, attachments: [] }],
        };
        const catalog = stubCatalog({ execute: vi.fn(async () => okResult(content)) });
        const client = scriptedClient([
            { toolCalls: [call('c1', { title: 'x' }, null, 'item_search_by_metadata')] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        const part = callbacks.onToolReturn.mock.calls[0][0].part;
        expect(part.metadata?.summary).toEqual({
            tool_name: 'item_search_by_metadata',
            result_count: 1,
            items: [{ library_id: 1, zotero_key: 'AAA' }],
        });
    });

    it('attaches the metadata a tool supplies itself, so a scholarly search renders as reference cards', async () => {
        const content = { references: [{ external_id: 'W1', title: 'Paper', rank: 1 }], notes: [], total_found: 1 };
        const metadata = { supplemental_data: [{ external_id: 'W1', source: 'openalex' }] };
        const catalog = stubCatalog({
            execute: vi.fn(async () => ({ ok: true, content, text: '1. Paper', metadata })),
        });
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' }, null, 'scholarly_search')] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog);
        const part = callbacks.onToolReturn.mock.calls[0][0].part;
        expect(part.metadata).toEqual(metadata);
        expect(isExternalSearchResult(part.tool_name, part.content, part.metadata)).toBe(true);
        const toolMessage = client.streamTurn.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
        expect(toolMessage.content).toBe('1. Paper');
    });

    it('elides older tool results before a call that would overflow the context window', async () => {
        const bigResult = { text: 'x'.repeat(8_000) }; // ~2000 tokens once serialised
        const catalog = stubCatalog({
            execute: vi.fn(async (): Promise<any> => ({ ok: true, content: bigResult, text: JSON.stringify(bigResult) })),
        });
        const client = scriptedClient([
            { toolCalls: [call('c0', { query: 'a' })] },
            { toolCalls: [call('c1', { query: 'b' })] },
            { toolCalls: [call('c2', { query: 'c' })] },
            { textChunks: ['Done.'] },
        ]);
        await run(client, callbacks, catalog, {
            config: { ...config, model: { ...config.model, context_window: 8_000 } },
        });

        const last = client.streamTurn.mock.calls[3][0].messages;
        const tools = last.filter((m: any) => m.role === 'tool');
        expect(tools.map((m: any) => m.toolCallId)).toEqual(['c0', 'c1', 'c2']);
        expect(tools[0].content).toBe(ELIDED_TOOL_RESULT);
        expect(tools[2].content).toBe(JSON.stringify(bigResult));
        expect(last[0].role).toBe('system');
        expect(last[1]).toEqual({ role: 'user', content: 'find papers on x' });
        // What the renderer shows is unaffected.
        expect(callbacks.onToolReturn.mock.calls.map(([e]: any) => e.part.content)).toEqual([bigResult, bigResult, bigResult]);
    });

    it('finishes with a warning rather than an error at the round cap', async () => {
        const turns = Array.from({ length: 10 }, (_, i) => ({ toolCalls: [call(`c${i}`, { query: 'x' })] }));
        const client = scriptedClient(turns);
        await run(client, callbacks, stubCatalog(), { config: { ...config, maxRounds: 3 } });
        expect(client.streamTurn).toHaveBeenCalledTimes(3);
        expect(callbacks.onWarning).toHaveBeenCalledTimes(1);
        expect(callbacks.onWarning.mock.calls[0][0]).toMatchObject({
            event: 'warning',
            run_id: 'run-1',
            type: 'local_round_cap',
        });
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        expect(callbacks.onWarning.mock.invocationCallOrder[0]).toBeLessThan(
            callbacks.onDone.mock.invocationCallOrder[0]
        );
    });

    it('forbids tool calls in the last allowed round so the model has to answer', async () => {
        const client = scriptedClient([
            { toolCalls: [call('c0', { query: 'a' })] },
            { toolCalls: [call('c1', { query: 'b' })] },
            { textChunks: ['Here is what I found.'] },
        ]);
        await run(client, callbacks, stubCatalog(), { config: { ...config, maxRounds: 3 } });
        const choices = client.streamTurn.mock.calls.map(([request]: any) => request.toolChoice ?? 'auto');
        expect(choices).toEqual(['auto', 'auto', 'none']);
        expect(callbacks.onWarning).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });

    it('does not run calls a provider makes in the last round anyway, and still answers each one', async () => {
        const catalog = stubCatalog();
        const client = scriptedClient([
            { toolCalls: [call('c0', { query: 'a' })] },
            { toolCalls: [call('c1', { query: 'b' })] },
        ]);
        await run(client, callbacks, catalog, { config: { ...config, maxRounds: 2 } });
        expect(catalog.execute).toHaveBeenCalledTimes(1);
        const returns = callbacks.onToolReturn.mock.calls.map(([e]: any) => e.part);
        expect(returns.map((p: any) => [p.tool_call_id, p.outcome])).toEqual([
            ['c0', 'success'],
            ['c1', 'failed'],
        ]);
        expect(callbacks.onWarning).toHaveBeenCalledTimes(1);
    });

    it('closes the run once: streaming_done, run_complete, run_citations, done', async () => {
        await run(scriptedClient([{ textChunks: ['Ready.'] }]), callbacks);
        const order = [
            callbacks.onStreamingDone.mock.invocationCallOrder[0],
            callbacks.onRunComplete.mock.invocationCallOrder[0],
            callbacks.onRunCitations.mock.invocationCallOrder[0],
            callbacks.onDone.mock.invocationCallOrder[0],
        ];
        expect(order.every((n) => typeof n === 'number')).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
    });

    it('sums usage across rounds into the run usage', async () => {
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' })], usage: { inputTokens: 100, outputTokens: 10 } },
            { textChunks: ['Ready.'], usage: { inputTokens: 150, outputTokens: 20 } },
        ]);
        await run(client, callbacks);
        const usage = callbacks.onRunComplete.mock.calls[0][0].usage;
        expect(usage).toMatchObject({
            requests: 2,
            tool_calls: 1,
            input_tokens: 250,
            output_tokens: 30,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            input_audio_tokens: 0,
            cache_audio_read_tokens: 0,
        });
        expect(usage.model_requests).toEqual([
            { input_tokens: 100, output_tokens: 10 },
            { input_tokens: 150, output_tokens: 20 },
        ]);
    });

    it('counts only successful tool calls in usage', async () => {
        const catalog = stubCatalog({
            execute: vi.fn(async () => ({ ok: false, error: 'boom', retryable: true })),
        });
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' })], usage: { inputTokens: 1, outputTokens: 1 } },
            { textChunks: ['Ready.'], usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
        await run(client, callbacks, catalog);
        expect(callbacks.onRunComplete.mock.calls[0][0].usage.tool_calls).toBe(0);
    });

    it('reports null usage when no round reported any', async () => {
        await run(scriptedClient([{ textChunks: ['Ready.'] }]), callbacks);
        expect(callbacks.onRunComplete.mock.calls[0][0].usage).toBeNull();
    });

    it('reports a provider failure through onError and does not complete the run', async () => {
        const client = {
            streamTurn: vi.fn(async () => {
                throw new LlmRequestError('auth', 'bad key');
            }),
        };
        await run(client, callbacks);
        expect(callbacks.onError).toHaveBeenCalledTimes(1);
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({
            event: 'error',
            run_id: 'run-1',
            type: 'local_provider_auth',
            details: 'auth',
            is_retryable: false,
        });
        expect(callbacks.onError.mock.calls[0][0].message).toContain('bad key');
        expect(callbacks.onError.mock.calls[0][0].try_auto_resume).toBeUndefined();
        expect(callbacks.onDone).not.toHaveBeenCalled();
        expect(callbacks.onRunComplete).not.toHaveBeenCalled();
        expect(callbacks.onStreamingDone).not.toHaveBeenCalled();
    });

    it.each([
        ['auth', 'local_provider_auth'],
        ['rate_limit', 'local_provider_rate_limit'],
        ['network', 'local_provider_network'],
        ['not_found', 'local_provider_not_found'],
        ['bad_request', 'local_provider_bad_request'],
        ['server', 'local_provider_server'],
    ] as const)('maps a %s provider failure to %s', async (kind, type) => {
        const client = {
            streamTurn: vi.fn(async () => {
                throw new LlmRequestError(kind, 'provider says no');
            }),
        };
        await run(client, callbacks);
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({
            type,
            details: kind,
            is_retryable: false,
        });
        expect(callbacks.onError.mock.calls[0][0].message).toBe('provider says no');
    });

    it('reports a failure in a later round after earlier frames were emitted', async () => {
        let i = 0;
        const client = {
            streamTurn: vi.fn(async (_r: any, handlers: any): Promise<LlmTurnResult> => {
                if (i++ === 0) {
                    handlers.onTextDelta('Looking');
                    return {
                        text: 'Looking',
                        thinking: '',
                        toolCalls: [call('c1', { query: 'x' })],
                        finishReason: 'tool_calls',
                        usage: null,
                    };
                }
                throw new LlmRequestError('server', 'upstream 502');
            }),
        };
        await run(client, callbacks);
        expect(callbacks.onToolReturn).toHaveBeenCalledTimes(1);
        expect(callbacks.onError).toHaveBeenCalledTimes(1);
        expect(callbacks.onDone).not.toHaveBeenCalled();
    });

    it('ends silently when the provider reports a cancellation', async () => {
        const controller = new AbortController();
        const client = {
            streamTurn: vi.fn(async (_r: any, handlers: any) => {
                handlers.onTextDelta('partial');
                controller.abort();
                throw new LlmRequestError('cancelled', 'The request was cancelled.');
            }),
        };
        await run(client, callbacks, stubCatalog(), { signal: controller.signal });
        expect(callbacks.onPart).toHaveBeenCalledTimes(1);
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).not.toHaveBeenCalled();
        expect(callbacks.onRunComplete).not.toHaveBeenCalled();
        expect(callbacks.onStreamingDone).not.toHaveBeenCalled();
        expect(callbacks.onClose).not.toHaveBeenCalled();
    });

    it('stops without further frames when cancelled during tool execution', async () => {
        const controller = new AbortController();
        const catalog = stubCatalog({
            execute: vi.fn(async () => {
                controller.abort();
                return okResult();
            }),
        });
        const client = scriptedClient([
            { toolCalls: [call('c1', { query: 'x' }), call('c2', { query: 'y' })] },
            { textChunks: ['Ready.'] },
        ]);
        await run(client, callbacks, catalog, { signal: controller.signal });
        expect(catalog.execute).toHaveBeenCalledTimes(1);
        expect(callbacks.onToolReturn).not.toHaveBeenCalled();
        expect(client.streamTurn).toHaveBeenCalledTimes(1);
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).not.toHaveBeenCalled();
    });

    it('reports an unexpected non-provider failure as an error', async () => {
        const catalog = stubCatalog({
            execute: vi.fn(async () => {
                throw new Error('handler exploded');
            }),
        });
        const client = scriptedClient([{ toolCalls: [call('c1', { query: 'x' })] }]);
        await run(client, callbacks, catalog);
        expect(callbacks.onError).toHaveBeenCalledTimes(1);
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({ is_retryable: false });
        expect(callbacks.onError.mock.calls[0][0].message).toContain('handler exploded');
        expect(callbacks.onDone).not.toHaveBeenCalled();
    });
    describe('frame delivery', () => {
        const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

        /**
         * Models the renderer: returns and parts update an active run that
         * `onDone` moves to history, so a frame that settles after `onDone`
         * is lost.
         */
        const rendererLike = (cbs: ReturnType<typeof recordingCallbacks>) => {
            const state = { active: [] as string[] | null, history: [] as string[] };
            cbs.onPart.mockImplementation(async (e: any) => {
                await tick();
                state.active?.push(`part:${e.message_index}:${e.part_index}:${e.part.part_kind}`);
            });
            cbs.onToolReturn.mockImplementation(async (e: any) => {
                await tick();
                state.active?.push(`return:${e.part.tool_call_id}`);
            });
            cbs.onDone.mockImplementation(() => {
                state.history = state.active ?? [];
                state.active = null;
            });
            return state;
        };

        it('delivers the last round’s tool return before done at the round cap', async () => {
            const state = rendererLike(callbacks);
            const turns = Array.from({ length: 3 }, (_, i) => ({ toolCalls: [call(`c${i}`, { query: 'x' })] }));
            await run(scriptedClient(turns), callbacks, stubCatalog(), { config: { ...config, maxRounds: 2 } });
            expect(state.history).toEqual([
                'part:0:0:tool-call',
                'return:c0',
                'part:2:0:tool-call',
                'return:c1',
            ]);
            expect(callbacks.onWarning.mock.invocationCallOrder[0]).toBeLessThan(
                callbacks.onDone.mock.invocationCallOrder[0]
            );
        });

        it('preserves frame order with async part callbacks across rounds', async () => {
            const state = rendererLike(callbacks);
            const client = scriptedClient([
                { thinkingChunks: ['h'], textChunks: ['Looking'], toolCalls: [call('c1', { query: 'x' }), call('c2', { query: 'y' })] },
                { textChunks: ['Rea', 'Ready.'] },
            ]);
            await run(client, callbacks);
            expect(state.history).toEqual([
                'part:0:0:thinking',
                'part:0:1:text',
                'part:0:2:tool-call',
                'part:0:3:tool-call',
                'return:c1',
                'return:c2',
                'part:2:0:text',
                'part:2:0:text',
            ]);
        });

        it('settles every frame before the loop resolves', async () => {
            const state = rendererLike(callbacks);
            const client = {
                streamTurn: vi.fn(async (_r: any, handlers: any) => {
                    handlers.onTextDelta('partial');
                    throw new LlmRequestError('server', 'upstream 502');
                }),
            };
            callbacks.onError.mockImplementation(() => state.active?.push('error'));
            await run(client, callbacks);
            expect(state.active).toEqual(['part:0:0:text', 'error']);
        });

        it('keeps delivering frames when a callback throws, as the hosted transport does', async () => {
            callbacks.onToolReturn.mockImplementation(async () => {
                throw new Error('render failed');
            });
            const client = scriptedClient([
                { toolCalls: [call('c1', { query: 'x' })] },
                { textChunks: ['Ready.'] },
            ]);
            await run(client, callbacks);
            expect(callbacks.onError).toHaveBeenCalledTimes(1);
            expect(callbacks.onError.mock.calls[0][0]).toMatchObject({ type: 'event_handling_error' });
            expect(client.streamTurn).toHaveBeenCalledTimes(2);
            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        });
    });
});

describe('runLocalAgentLoop hosted web search', () => {
    interface WebTurn {
        text?: string;
        finishReason?: LlmTurnResult['finishReason'];
        toolCalls?: AccumulatedToolCall[];
        citations?: { url: string; title: string }[];
        providerBlocks?: unknown[];
        warnings?: string[];
        usage?: LlmUsage | null;
    }

    /** Replays turns and records each request as it was at call time. */
    const webClient = (turns: WebTurn[]) => {
        let i = 0;
        const requests: any[] = [];
        const client = {
            streamTurn: vi.fn(async (request: any, handlers: any): Promise<LlmTurnResult> => {
                requests.push({ ...request, messages: request.messages.map((m: any) => ({ ...m })) });
                const turn = turns[Math.min(i++, turns.length - 1)];
                if (turn.text) handlers.onTextDelta(turn.text);
                for (const warning of turn.warnings ?? []) handlers.onWarning?.(warning);
                return {
                    text: turn.text ?? '',
                    thinking: '',
                    toolCalls: turn.toolCalls ?? [],
                    finishReason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop'),
                    usage: turn.usage ?? null,
                    ...(turn.citations ? { citations: turn.citations } : {}),
                    ...(turn.providerBlocks ? { providerBlocks: turn.providerBlocks } : {}),
                };
            }),
        };
        return { client, requests };
    };

    let callbacks: ReturnType<typeof recordingCallbacks>;
    beforeEach(() => {
        vi.clearAllMocks();
        callbacks = recordingCallbacks();
    });

    const textFrames = () => partsOf(callbacks).filter((e: any) => e.part.part_kind === 'text');

    it('passes the web search option to every provider request', async () => {
        const { client, requests } = webClient([
            { toolCalls: [call('c0', { query: 'a' })] },
            { text: 'Done.' },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true, maxUses: 3 } });
        expect(requests).toHaveLength(2);
        for (const request of requests) expect(request.webSearch).toEqual({ enabled: true, maxUses: 3 });
    });

    it('tells the model the user asked for web search when it is enabled for the run', async () => {
        const { client, requests } = webClient([{ text: 'Done.' }]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const user = requests[0].messages[1];
        expect(user.content).toContain('The user asked you to search the web for this request.');
    });

    it('does not mention web search when it is not enabled for the run', async () => {
        const { client, requests } = webClient([{ text: 'Done.' }]);
        await run(client, callbacks, stubCatalog());
        const user = requests[0].messages[1];
        expect(user.content).not.toContain('search the web');
    });

    it('continues a paused turn instead of finishing, within the same round', async () => {
        const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }];
        const { client, requests } = webClient([
            { text: 'Searching. ', finishReason: 'pause', providerBlocks: paused, usage: { inputTokens: 5, outputTokens: 1 } },
            { text: 'Answer.', usage: { inputTokens: 7, outputTokens: 2 } },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true }, config: { ...config, maxRounds: 1 } });

        expect(client.streamTurn).toHaveBeenCalledTimes(2);
        // The continuation resends the transcript with the paused turn appended.
        const continued = requests[1].messages;
        expect(continued[continued.length - 1]).toEqual({ role: 'assistant', content: 'Searching. ', providerBlocks: paused });
        expect(requests[1].messages.slice(0, -1)).toEqual(requests[0].messages);

        // One text coordinate, holding the whole turn.
        const texts = textFrames();
        expect(new Set(texts.map((e: any) => `${e.message_index}:${e.part_index}`)).size).toBe(1);
        expect(texts[texts.length - 1].part.content).toBe('Searching. Answer.');

        // A pause does not use up a round: no round-cap warning, a normal finish.
        expect(callbacks.onWarning).not.toHaveBeenCalled();
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        // Each request's usage is counted.
        expect(callbacks.onRunComplete.mock.calls[0][0].usage).toMatchObject({ requests: 2, input_tokens: 12, output_tokens: 3 });
    });

    it('replays paused turns before the tool calls of the same round', async () => {
        const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }];
        const final = [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }, { type: 'tool_use', id: 'c0', name: 'zotero_search', input: {} }];
        const { client, requests } = webClient([
            { text: 'A. ', finishReason: 'pause', providerBlocks: paused },
            { text: 'B.', toolCalls: [call('c0', {})], providerBlocks: final },
            { text: 'Done.' },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const messages = requests[2].messages;
        expect(messages.slice(-3)).toEqual([
            { role: 'assistant', content: 'A. ', providerBlocks: paused },
            { role: 'assistant', content: 'B.', toolCalls: [call('c0', {})], providerBlocks: final },
            { role: 'tool', content: JSON.stringify({ items: [], total_count: 0 }), toolCallId: 'c0' },
        ]);
    });

    it('separates a pause continuation from text that did not end in whitespace', async () => {
        const { client } = webClient([
            { text: 'Searching.', finishReason: 'pause', providerBlocks: [{ type: 'server_tool_use' }] },
            { text: 'Answer.' },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const texts = textFrames();
        expect(new Set(texts.map((e: any) => `${e.message_index}:${e.part_index}`)).size).toBe(1);
        expect(texts.map((e: any) => e.part.content)).toEqual(['Searching.', 'Searching.\n\nAnswer.']);
    });

    it('reports the same search problem once per round', async () => {
        const warning = 'Web search reached its search limit for this turn.';
        const { client } = webClient([
            { text: 'A. ', finishReason: 'pause', providerBlocks: [{ type: 'server_tool_use' }], warnings: [warning] },
            { text: 'B.', warnings: [warning, warning] },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        expect(callbacks.onWarning).toHaveBeenCalledTimes(1);
    });

    it('stops continuing after repeated pauses and keeps the answer so far', async () => {
        const { client } = webClient([{ text: 'Still searching.', finishReason: 'pause', providerBlocks: [{ type: 'server_tool_use' }] }]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        // The first request plus a bounded number of continuations.
        expect(client.streamTurn.mock.calls.length).toBeGreaterThan(1);
        expect(client.streamTurn.mock.calls.length).toBeLessThanOrEqual(6);
        expect(callbacks.onWarning).toHaveBeenCalledTimes(1);
        expect(callbacks.onWarning.mock.calls[0][0]).toMatchObject({ type: 'local_web_search' });
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });

    it('appends a deduplicated Sources list at the same text coordinate', async () => {
        const { client } = webClient([
            {
                text: 'Born in 1916.',
                citations: [
                    { url: 'https://a.example/1', title: 'Page [A]' },
                    { url: 'https://b.example/2', title: 'B' },
                ],
            },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const texts = textFrames();
        expect(new Set(texts.map((e: any) => `${e.message_index}:${e.part_index}`)).size).toBe(1);
        expect(texts[texts.length - 1].part.content).toBe(
            'Born in 1916.\n\nSources:\n- [Page \\[A\\]](https://a.example/1)\n- [B](https://b.example/2)'
        );
    });

    it('merges citations across a paused turn without repeating a source', async () => {
        const { client } = webClient([
            { text: 'One. ', finishReason: 'pause', citations: [{ url: 'https://a.example', title: 'A' }], providerBlocks: [{ type: 'server_tool_use' }] },
            { text: 'Two.', citations: [{ url: 'https://a.example', title: 'A' }, { url: 'https://c.example', title: 'C' }] },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const texts = textFrames();
        expect(texts[texts.length - 1].part.content).toBe(
            'One. Two.\n\nSources:\n- [A](https://a.example)\n- [C](https://c.example)'
        );
    });

    it('carries the Sources list into the transcript for the next round', async () => {
        const { client, requests } = webClient([
            { text: 'Found it.', toolCalls: [call('c0', {})], citations: [{ url: 'https://a.example', title: 'A' }] },
            { text: 'Done.' },
        ]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        const assistant = requests[1].messages.find((m: any) => m.role === 'assistant');
        expect(assistant.content).toBe('Found it.\n\nSources:\n- [A](https://a.example)');
    });

    it('surfaces a hosted search problem as a warning and finishes normally', async () => {
        const { client } = webClient([{ text: 'From memory.', warnings: ['Web search reached its search limit for this turn.'] }]);
        await run(client, callbacks, stubCatalog(), { webSearch: { enabled: true } });
        expect(callbacks.onWarning).toHaveBeenCalledTimes(1);
        expect(callbacks.onWarning.mock.calls[0][0]).toMatchObject({
            event: 'warning',
            type: 'local_web_search',
            message: 'Web search reached its search limit for this turn.',
        });
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    });
});
