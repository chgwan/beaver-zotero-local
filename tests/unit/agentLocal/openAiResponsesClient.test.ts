import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenAiResponsesClient } from '@beaver/agent-local/llm/openAiResponsesClient';
import { LlmRequestError } from '@beaver/agent-local/llm/types';
import { ZOTERO_SEARCH_TOOL } from '@beaver/agent-local/tools/toolSchemas';

const model = {
    name: 'GPT',
    snapshot: 'gpt-5.5',
    api_key: 'sk-test',
    api_base: 'https://api.openai.com/v1',
    format: 'openai' as const,
};

/** One SSE event in the Responses stream shape: `event:` plus a JSON `data:` carrying `type`. */
const ev = (payload: Record<string, unknown>) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;

const sseResponse = (...frames: string[]) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
        getReader: () => {
            const encoder = new TextEncoder();
            let i = 0;
            return {
                read: async () =>
                    i < frames.length
                        ? { done: false, value: encoder.encode(frames[i++]) }
                        : { done: true, value: undefined },
                cancel: async () => {},
                releaseLock: () => {},
            };
        },
    },
    text: async () => '',
    json: async () => ({}),
});

const errorResponse = (status: number, statusText: string, body: string) => ({
    ok: false,
    status,
    statusText,
    body: null,
    text: async () => body,
    json: async () => ({}),
});

const completed = (usage = { input_tokens: 12, output_tokens: 5 }) =>
    ev({ type: 'response.completed', response: { status: 'completed', usage, output: [] } });

const handlers = () => ({ onTextDelta: vi.fn(), onThinkingDelta: vi.fn(), onWarning: vi.fn() });
const signal = () => new AbortController().signal;
const turn = (overrides = {}) => ({
    model,
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    webSearch: { enabled: true },
    ...overrides,
});
const bodyOf = (fetchMock: any, call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

afterEach(() => vi.unstubAllGlobals());

describe('createOpenAiResponsesClient request', () => {
    it('posts a stateless streamed request to /responses with a bearer token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/responses');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
        const sent = JSON.parse(init.body);
        expect(sent.model).toBe('gpt-5.5');
        expect(sent.stream).toBe(true);
        expect(sent.store).toBe(false);
        expect(sent.previous_response_id).toBeUndefined();
    });

    it('declares function tools and the hosted web_search tool side by side', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL], webSearch: { enabled: true, maxUses: 3 } }),
            handlers(),
            signal()
        );
        const sent = bodyOf(fetchMock);
        expect(sent.tools).toEqual([
            {
                type: 'function',
                name: ZOTERO_SEARCH_TOOL.name,
                description: ZOTERO_SEARCH_TOOL.description,
                parameters: ZOTERO_SEARCH_TOOL.parameters,
                strict: false,
            },
            { type: 'web_search' },
        ]);
        expect(sent.max_tool_calls).toBe(3);
        expect(sent.tool_choice).toBeUndefined();
    });

    it('omits the web_search tool and the search limit when web search is off', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL], webSearch: { enabled: false, maxUses: 3 } }),
            handlers(),
            signal()
        );
        const sent = bodyOf(fetchMock);
        expect(sent.tools.map((t: any) => t.type)).toEqual(['function']);
        expect(sent.max_tool_calls).toBeUndefined();
    });

    it('sends tool_choice none on a turn that forbids tool calls', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL], toolChoice: 'none' }),
            handlers(),
            signal()
        );
        expect(bodyOf(fetchMock).tool_choice).toBe('none');
    });

    it('sends the reasoning effort as a reasoning object', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(
            turn({ model: { ...model, reasoning_effort: 'high' } }),
            handlers(),
            signal()
        );
        expect(bodyOf(fetchMock).reasoning).toEqual({ effort: 'high' });
    });

    it('translates history turns without provider items into instructions and input items', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiResponsesClient().streamTurn(
            turn({
                messages: [
                    { role: 'system', content: 'Be helpful.' },
                    { role: 'user', content: 'Find papers.' },
                    {
                        role: 'assistant',
                        content: 'Searching.',
                        toolCalls: [
                            { id: 'call_1', name: 'zotero_search', args: { q: 'x' }, rawArgs: '{"q":"x"}', parseError: null },
                            { id: 'call_2', name: 'zotero_search', args: {}, rawArgs: '{bad', parseError: 'bad' },
                        ],
                    },
                    { role: 'tool', content: 'result 1', toolCallId: 'call_1' },
                    { role: 'tool', content: 'result 2', toolCallId: 'call_2' },
                    { role: 'assistant', content: 'Done.' },
                    { role: 'user', content: 'Thanks.' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = bodyOf(fetchMock);
        expect(sent.instructions).toBe('Be helpful.');
        expect(sent.input).toEqual([
            { role: 'user', content: 'Find papers.' },
            { role: 'assistant', content: 'Searching.' },
            { type: 'function_call', call_id: 'call_1', name: 'zotero_search', arguments: '{"q":"x"}' },
            { type: 'function_call', call_id: 'call_2', name: 'zotero_search', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
            { type: 'function_call_output', call_id: 'call_2', output: 'result 2' },
            { role: 'assistant', content: 'Done.' },
            { role: 'user', content: 'Thanks.' },
        ]);
    });

    it('replays a turn with provider items verbatim, in place of its text and calls', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(completed()));
        vi.stubGlobal('fetch', fetchMock);
        const items = [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'zotero_search', arguments: '{"q":"x"}', status: 'completed' },
        ];
        await createOpenAiResponsesClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'Find papers.' },
                    {
                        role: 'assistant',
                        content: 'ignored text',
                        providerBlocks: items,
                        toolCalls: [{ id: 'call_1', name: 'zotero_search', args: { q: 'x' }, rawArgs: '{"q":"x"}', parseError: null }],
                    },
                    { role: 'tool', content: 'result 1', toolCallId: 'call_1' },
                ],
            }),
            handlers(),
            signal()
        );
        expect(bodyOf(fetchMock).input).toEqual([
            { role: 'user', content: 'Find papers.' },
            ...items,
            { type: 'function_call_output', call_id: 'call_1', output: 'result 1' },
        ]);
    });

    it('rejects as cancelled without sending when the signal is already aborted', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        controller.abort();
        const failure = await createOpenAiResponsesClient()
            .streamTurn(turn(), handlers(), controller.signal)
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects as cancelled when fetch is aborted in flight', async () => {
        const controller = new AbortController();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => {
                controller.abort();
                const abortError = new Error('The operation was aborted.');
                abortError.name = 'AbortError';
                return Promise.reject(abortError);
            })
        );
        const failure = await createOpenAiResponsesClient()
            .streamTurn(turn(), handlers(), controller.signal)
            .catch((e) => e);
        expect(failure.kind).toBe('cancelled');
    });
});

describe('createOpenAiResponsesClient stream', () => {
    it('streams cumulative text and reads usage from response.completed', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.created', response: { status: 'in_progress' } }),
                    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Rea' }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'dy.' }),
                    completed({ input_tokens: 40, output_tokens: 7 })
                )
            )
        );
        const h = handlers();
        const result = await createOpenAiResponsesClient().streamTurn(turn(), h, signal());
        expect(h.onTextDelta.mock.calls.map(([t]) => t)).toEqual(['Rea', 'Ready.']);
        expect(result.text).toBe('Ready.');
        expect(result.finishReason).toBe('stop');
        expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 7 });
        expect(result.toolCalls).toEqual([]);
    });

    it('reassembles function-call arguments split mid-token and parses them once at close', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '' } }),
                    ev({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_2', type: 'function_call', call_id: 'call_b', name: 'list_items', arguments: '' } }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"qu' }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 1, delta: '{"lim' }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: 'ery":"ne' }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 1, delta: 'it":2}' }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: 'ural"}' }),
                    ev({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"query":"neural"}' }),
                    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '{"query":"neural"}' } }),
                    completed()
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls.map(({ id, name, args, parseError }) => ({ id, name, args, parseError }))).toEqual([
            { id: 'call_a', name: 'zotero_search', args: { query: 'neural' }, parseError: null },
            { id: 'call_b', name: 'list_items', args: { limit: 2 }, parseError: null },
        ]);
    });

    it('takes the arguments from the finished item when no deltas arrived', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '{"query":"x"}' } }),
                    completed()
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({ id: 'call_a', name: 'zotero_search', args: { query: 'x' } });
    });

    it('never turns a web_search_call into a tool call, and separates text around it', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_0', type: 'message', role: 'assistant', content: [] } }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_0', output_index: 0, content_index: 0, delta: 'Let me check.' }),
                    ev({ type: 'response.output_item.added', output_index: 1, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
                    ev({ type: 'response.web_search_call.in_progress', item_id: 'ws_1', output_index: 1 }),
                    ev({ type: 'response.web_search_call.searching', item_id: 'ws_1', output_index: 1 }),
                    ev({ type: 'response.web_search_call.completed', item_id: 'ws_1', output_index: 1 }),
                    ev({ type: 'response.output_item.done', output_index: 1, item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'latest' } } }),
                    ev({ type: 'response.output_item.added', output_index: 2, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 2, content_index: 0, delta: 'Found it.' }),
                    completed()
                )
            )
        );
        const h = handlers();
        const result = await createOpenAiResponsesClient().streamTurn(turn(), h, signal());
        expect(result.toolCalls).toEqual([]);
        expect(result.finishReason).toBe('stop');
        expect(result.text).toBe('Let me check.\n\nFound it.');
        expect(h.onTextDelta.mock.calls.at(-1)?.[0]).toBe('Let me check.\n\nFound it.');
    });

    it('warns when a hosted search fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'failed' } }),
                    completed()
                )
            )
        );
        const h = handlers();
        await createOpenAiResponsesClient().streamTurn(turn(), h, signal());
        expect(h.onWarning).toHaveBeenCalledWith('Web search failed.');
    });

    it('collects url_citation annotations into citations, unique by URL', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Answer.' }),
                    ev({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://a.example', title: 'A', start_index: 0, end_index: 6 } }),
                    ev({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 1, annotation: { type: 'url_citation', url: 'https://a.example', title: 'A again', start_index: 0, end_index: 6 } }),
                    ev({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 2, annotation: { type: 'file_citation', file_id: 'f' } }),
                    ev({
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            id: 'msg_1',
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'Answer.', annotations: [{ type: 'url_citation', url: 'https://b.example', title: 'B', start_index: 0, end_index: 6 }] }],
                        },
                    }),
                    completed()
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.text).toBe('Answer.');
        expect(result.citations).toEqual([
            { url: 'https://a.example', title: 'A' },
            { url: 'https://b.example', title: 'B' },
        ]);
    });

    it('records every finished output item in order and replays them before the tool results', async () => {
        const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAA' };
        const search = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q' } };
        const message = {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
        };
        const call = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_a', name: 'zotero_search', arguments: '{"query":"x"}' };
        const fetchMock = vi.fn().mockResolvedValue(
            sseResponse(
                ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
                ev({ type: 'response.output_item.done', output_index: 0, item: reasoning }),
                ev({ type: 'response.output_item.added', output_index: 1, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } }),
                ev({ type: 'response.output_item.done', output_index: 1, item: search }),
                ev({ type: 'response.output_item.added', output_index: 2, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
                ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 2, content_index: 0, delta: 'Checking.' }),
                ev({ type: 'response.output_item.done', output_index: 2, item: message }),
                ev({ type: 'response.output_item.added', output_index: 3, item: { ...call, status: 'in_progress', arguments: '' } }),
                ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 3, delta: '{"query":' }),
                ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 3, delta: '"x"}' }),
                ev({ type: 'response.output_item.done', output_index: 3, item: call }),
                completed()
            )
        );
        vi.stubGlobal('fetch', fetchMock);
        const client = createOpenAiResponsesClient();
        const result = await client.streamTurn(turn(), handlers(), signal());
        expect(result.providerBlocks).toEqual([reasoning, search, message, call]);

        await client.streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: `${result.text}\n\nSources:\n- [A](https://a.example)`,
                        toolCalls: result.toolCalls,
                        providerBlocks: result.providerBlocks,
                    },
                    { role: 'tool', content: 'found', toolCallId: 'call_a' },
                ],
            }),
            handlers(),
            signal()
        );
        expect(bodyOf(fetchMock, 1).input).toEqual([
            { role: 'user', content: 'hi' },
            reasoning,
            search,
            message,
            call,
            { type: 'function_call_output', call_id: 'call_a', output: 'found' },
        ]);
    });

    it('records a turn without reasoning, and drops reasoning items that have no encrypted content', async () => {
        const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] };
        const call = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_a', name: 'list_items', arguments: '{}' };
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_2', type: 'reasoning', summary: [] } }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hi' }),
                    ev({ type: 'response.output_item.done', output_index: 1, item: message }),
                    ev({ type: 'response.output_item.done', output_index: 2, item: call }),
                    completed()
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.providerBlocks).toEqual([message, call]);
    });

    it('replays a recorded call whose arguments did not parse as an empty JSON object', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '' } }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"query":' }),
                    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '{"query":' } }),
                    completed()
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.toolCalls[0].parseError).toBeTruthy();
        expect(result.providerBlocks).toEqual([
            { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'zotero_search', arguments: '{}' },
        ]);
    });

    it('records a call whose item never finished, so its tool result still has a call to answer', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'list_items', arguments: '' } }),
                    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"limit":2}' }),
                    ev({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.providerBlocks).toEqual([
            { type: 'function_call', call_id: 'call_a', name: 'list_items', arguments: '{"limit":2}' },
        ]);
    });

    it('streams reasoning summary text as thinking', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Plan' }),
                    ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'ning' }),
                    completed()
                )
            )
        );
        const h = handlers();
        const result = await createOpenAiResponsesClient().streamTurn(turn(), h, signal());
        expect(h.onThinkingDelta.mock.calls.map(([t]) => t)).toEqual(['Plan', 'Planning']);
        expect(result.thinking).toBe('Planning');
    });

    it('maps an incomplete response cut off by the token limit to length', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Part' }),
                    ev({
                        type: 'response.incomplete',
                        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 3, output_tokens: 9 } },
                    })
                )
            )
        );
        const result = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal());
        expect(result.finishReason).toBe('length');
        expect(result.text).toBe('Part');
        expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 9 });
    });

    it('rejects when the stream reports response.failed', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Slow down.' } } })
                )
            )
        );
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('rate_limit');
        expect(failure.message).toBe('Slow down.');
    });

    it('rejects when the stream reports an error event', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(sseResponse(ev({ type: 'error', code: 'server_error', message: 'Boom.', param: null })))
        );
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure.kind).toBe('server');
        expect(failure.message).toBe('Boom.');
    });

    it('rejects as cancelled when the caller aborts mid-stream', async () => {
        const controller = new AbortController();
        const onTextDelta = vi.fn(() => controller.abort());
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' }),
                    ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' }),
                    completed()
                )
            )
        );
        const failure = await createOpenAiResponsesClient()
            .streamTurn(turn(), { onTextDelta, onThinkingDelta: vi.fn() }, controller.signal)
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('cancelled');
    });
});

describe('createOpenAiResponsesClient HTTP errors', () => {
    it('classifies a 401 as an auth error with the provider message', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'Unauthorized', '{"error":{"message":"Incorrect API key provided."}}')));
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure.kind).toBe('auth');
        expect(failure.message).toBe('Incorrect API key provided.');
        expect(failure.message).not.toContain('sk-test');
    });

    it('classifies a 429 as a rate limit and a 500 as a server error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429, 'Too Many Requests', '')));
        const limited = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(limited.kind).toBe('rate_limit');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500, 'Internal Server Error', '')));
        const server = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(server.kind).toBe('server');
    });

    it('classifies a thrown fetch as a network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure.kind).toBe('network');
    });

    it('reports a web-search-specific error when a 400 names the web tool', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request', '{"error":{"message":"Tool \'web_search\' is not supported with gpt-4.1-nano."}}'))
        );
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure.kind).toBe('bad_request');
        expect(failure.message).toMatch(/web search is not available for this provider or model/i);
    });

    it('leaves an unrelated 400 unchanged', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400, 'Bad Request', '{"error":{"message":"context too long"}}')));
        const failure = await createOpenAiResponsesClient().streamTurn(turn(), handlers(), signal()).catch((e) => e);
        expect(failure.message).toBe('context too long');
    });
});
