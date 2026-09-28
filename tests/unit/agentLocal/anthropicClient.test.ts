import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createAnthropicClient,
    ANTHROPIC_VERSION,
} from '@beaver/agent-local/llm/anthropicClient';
import { LlmRequestError } from '@beaver/agent-local/llm/types';
import { ZOTERO_SEARCH_TOOL } from '@beaver/agent-local/tools/toolSchemas';

const model = {
    name: 'Claude',
    snapshot: 'claude-sonnet-4-5',
    api_key: 'sk-ant-test',
    api_base: 'https://api.anthropic.com',
    format: 'anthropic' as const,
};

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

const handlers = () => ({ onTextDelta: vi.fn(), onThinkingDelta: vi.fn() });
const signal = () => new AbortController().signal;
const turn = (overrides = {}) => ({
    model,
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    ...overrides,
});
const STOP = 'event: message_stop\ndata: {}\n\n';

afterEach(() => vi.unstubAllGlobals());

describe('createAnthropicClient', () => {
    it('streams cumulative text from content block deltas', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Rea"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"dy."}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
                    STOP
                )
            )
        );
        const h = handlers();
        const result = await createAnthropicClient().streamTurn(turn(), h, signal());
        expect(h.onTextDelta.mock.calls.map(([t]) => t)).toEqual(['Rea', 'Ready.']);
        expect(result.text).toBe('Ready.');
        expect(result.finishReason).toBe('stop');
    });

    it('reassembles tool input from input_json_delta fragments', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"zotero_search"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"que"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"ry\\":\\"x\\"}"}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n'
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL] }),
            handlers(),
            signal()
        );
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls[0]).toMatchObject({
            id: 'toolu_1',
            name: 'zotero_search',
            args: { query: 'x' },
            parseError: null,
        });
    });

    it('ignores input_json_delta from a server_tool_use block and its result block, keeping surrounding text intact', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
                    'event: content_block_start\ndata: {"index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]}}\n\n',
                    'event: content_block_start\ndata: {"index":2,"content_block":{"type":"text","text":""}}\n\n',
                    'event: content_block_delta\ndata: {"index":2,"delta":{"type":"text_delta","text":"Done."}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn(), handlers(), signal());
        expect(result.toolCalls).toEqual([]);
        expect(result.text).toBe('Done.');
        expect(result.finishReason).toBe('stop');
    });

    it('keeps a real tool_use call and drops a sibling server_tool_use block from the same stream', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"ignored\\"}"}}\n\n',
                    'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"zotero_search"}}\n\n',
                    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"que"}}\n\n',
                    'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"ry\\":\\"y\\"}"}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}\n\n'
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL] }),
            handlers(),
            signal()
        );
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
            id: 'toolu_2',
            name: 'zotero_search',
            args: { query: 'y' },
            parseError: null,
        });
        expect(result.finishReason).toBe('tool_calls');
        // The unfinished server call must be replayed with the local call.
        expect(result.providerBlocks).toEqual([
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ignored' } },
            { type: 'tool_use', id: 'toolu_2', name: 'zotero_search', input: { query: 'y' } },
        ]);
    });

    it('does not report tool_calls as the finish reason when only server-tool blocks streamed', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn(), handlers(), signal());
        expect(result.toolCalls).toHaveLength(0);
        expect(result.finishReason).toBe('unknown');
    });

    it('streams thinking blocks separately from text', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
                    STOP
                )
            )
        );
        const h = handlers();
        const result = await createAnthropicClient().streamTurn(turn(), h, signal());
        expect(h.onThinkingDelta).toHaveBeenCalledWith('hmm');
        expect(result.thinking).toBe('hmm');
        expect(result.text).toBe('');
    });

    it('hoists system messages to the top-level system parameter', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'system', content: 'be brief' },
                    { role: 'user', content: 'hi' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.system).toBe('be brief');
        expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('uses the Anthropic auth headers and endpoint', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(turn(), handlers(), signal());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(init.headers['x-api-key']).toBe('sk-ant-test');
        expect(init.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
        expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
        expect(init.headers).not.toHaveProperty('Authorization');
        expect(JSON.parse(init.body).max_tokens).toBeGreaterThan(0);
    });

    it('strips one trailing /v1 from api_base before appending v1/messages', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({ model: { ...model, api_base: 'https://api.anthropic.com/v1' } }),
            handlers(),
            signal()
        );
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    });

    it('strips a trailing /v1/ (with slash) from api_base before appending v1/messages', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({ model: { ...model, api_base: 'https://api.anthropic.com/v1/' } }),
            handlers(),
            signal()
        );
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    });

    it('sends no x-api-key header when the model has no API key', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({ model: { ...model, api_key: '', api_base: 'http://localhost:8080' } }),
            handlers(),
            signal()
        );
        expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('x-api-key');
    });

    it('sends tools in the Anthropic input_schema envelope', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL] }),
            handlers(),
            signal()
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools[0]).toEqual({
            name: ZOTERO_SEARCH_TOOL.name,
            description: ZOTERO_SEARCH_TOOL.description,
            input_schema: ZOTERO_SEARCH_TOOL.parameters,
        });
    });

    it('sends tool_choice none when the turn forbids tool calls', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(turn({ tools: [ZOTERO_SEARCH_TOOL], toolChoice: 'none' }), handlers(), signal());
        await createAnthropicClient().streamTurn(turn({ tools: [ZOTERO_SEARCH_TOOL] }), handlers(), signal());
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_choice).toEqual({ type: 'none' });
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).tool_choice).toBeUndefined();
    });

    it('rebuilds a tool round as tool_use and tool_result content blocks', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            {
                                id: 'toolu_1',
                                name: 'zotero_search',
                                args: { query: 'x' },
                                rawArgs: '{"query":"x"}',
                                parseError: null,
                            },
                        ],
                    },
                    { role: 'tool', content: '{"results":[]}', toolCallId: 'toolu_1' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'tool_use', id: 'toolu_1', name: 'zotero_search', input: { query: 'x' } },
            ],
        });
        expect(sent.messages[2]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"results":[]}' },
            ],
        });
    });

    it('replays a call whose arguments did not parse as an empty input object', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            {
                                id: 'toolu_1',
                                name: 'zotero_search',
                                args: {},
                                rawArgs: '{"query": "unterminated',
                                parseError: 'Tool arguments were not valid JSON',
                            },
                        ],
                    },
                    { role: 'tool', content: 'not run', toolCallId: 'toolu_1' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages[1].content[0]).toEqual({
            type: 'tool_use',
            id: 'toolu_1',
            name: 'zotero_search',
            input: {},
        });
    });

    it('merges consecutive tool results into one user message', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'tool', content: 'a', toolCallId: 't1' },
                    { role: 'tool', content: 'b', toolCallId: 't2' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        // The leading user turn and the two tool results are all `user`-role
        // wire entries with nothing from the other role between them, so a
        // role-alternating transcript merges all three into one message.
        expect(sent.messages).toHaveLength(1);
        expect(sent.messages[0].content).toHaveLength(3);
    });

    it('merges two consecutive plain user messages into one', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'first' },
                    { role: 'user', content: 'second' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'first' },
                    { type: 'text', text: 'second' },
                ],
            },
        ]);
    });

    it('merges a tool-result message with a following plain user message', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'tool', content: '{"results":[]}', toolCallId: 't1' },
                    { role: 'user', content: 'and also this' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 't1', content: '{"results":[]}' },
                    { type: 'text', text: 'and also this' },
                ],
            },
        ]);
    });

    it('merges two consecutive assistant messages into one', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: 'partial' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            {
                                id: 'toolu_1',
                                name: 'zotero_search',
                                args: { query: 'x' },
                                rawArgs: '{"query":"x"}',
                                parseError: null,
                            },
                        ],
                    },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'text', text: 'partial' },
                { type: 'tool_use', id: 'toolu_1', name: 'zotero_search', input: { query: 'x' } },
            ],
        });
    });

    it('drops a leading assistant message so the transcript never opens with one', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'assistant', content: 'stray reply' },
                    { role: 'user', content: 'hi' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('surfaces an error event mid-stream as a provider error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: error\ndata: {"error":{"type":"overloaded_error","message":"overloaded"}}\n\n'
                )
            )
        );
        await expect(
            createAnthropicClient().streamTurn(turn(), handlers(), signal())
        ).rejects.toMatchObject({ kind: 'server', message: expect.stringContaining('overloaded') });
    });

    it('classifies a 401 as an auth error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                body: null,
                text: async () => '{"error":{"message":"invalid x-api-key"}}',
                json: async () => ({}),
            })
        );
        await expect(
            createAnthropicClient().streamTurn(turn(), handlers(), signal())
        ).rejects.toMatchObject({ kind: 'auth' });
    });

    it('classifies a 404 as a not_found error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                body: null,
                text: async () => '{"error":{"message":"model not found"}}',
                json: async () => ({}),
            })
        );
        await expect(
            createAnthropicClient().streamTurn(turn(), handlers(), signal())
        ).rejects.toMatchObject({ kind: 'not_found' });
    });

    it('captures usage from message_start input tokens and message_delta output tokens', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: message_start\ndata: {"message":{"usage":{"input_tokens":42,"output_tokens":1}}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn(), handlers(), signal());
        expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    });

    it('reports null usage when the provider never sends it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(STOP)));
        const result = await createAnthropicClient().streamTurn(turn(), handlers(), signal());
        expect(result.usage).toBeNull();
    });

    it('rejects as cancelled when the request is aborted before fetch resolves', async () => {
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
        const failure = await createAnthropicClient()
            .streamTurn(turn(), handlers(), controller.signal)
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('cancelled');
    });

    it('rejects as cancelled when the caller aborts mid-stream', async () => {
        const controller = new AbortController();
        const onTextDelta = vi.fn(() => controller.abort());
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
                    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
                    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
                    STOP
                )
            )
        );
        const failure = await createAnthropicClient()
            .streamTurn(turn(), { onTextDelta, onThinkingDelta: vi.fn() }, controller.signal)
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('cancelled');
    });
});

describe('createAnthropicClient hosted web search', () => {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const errorResponse = (status: number, message: string) => ({
        ok: false,
        status,
        statusText: 'Bad Request',
        body: null,
        text: async () => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
        json: async () => ({}),
    });
    const bodyOf = (fetchMock: any, call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

    /** A search turn: text, a server search with a result, cited text. */
    const searchFrames = (stopReason: string) => [
        frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }),
        frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me look. ' } }),
        frame('content_block_stop', { index: 0 }),
        frame('content_block_start', { index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }),
        frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } }),
        frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"shannon"}' } }),
        frame('content_block_stop', { index: 1 }),
        frame('content_block_start', {
            index: 2,
            content_block: {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [{ type: 'web_search_result', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon', encrypted_content: 'enc' }],
            },
        }),
        frame('content_block_stop', { index: 2 }),
        frame('content_block_start', { index: 3, content_block: { type: 'text', text: '' } }),
        frame('content_block_delta', {
            index: 3,
            delta: {
                type: 'citations_delta',
                citation: { type: 'web_search_result_location', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon', encrypted_index: 'ei', cited_text: 'born 1916' },
            },
        }),
        frame('content_block_delta', { index: 3, delta: { type: 'text_delta', text: 'He was born in 1916.' } }),
        frame('content_block_stop', { index: 3 }),
        frame('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }),
        STOP,
    ];

    it('adds the web_search server tool with max_uses when web search is enabled', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL], webSearch: { enabled: true, maxUses: 3 } }),
            handlers(),
            signal()
        );
        const tools = bodyOf(fetchMock).tools;
        expect(tools).toHaveLength(2);
        expect(tools[1]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
    });

    it('sends the server tool even when the turn has no local tools', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(bodyOf(fetchMock).tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    });

    it('adds no server tool when web search is disabled or unset', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: false, maxUses: 3 } }), handlers(), signal());
        await createAnthropicClient().streamTurn(turn({ tools: [ZOTERO_SEARCH_TOOL] }), handlers(), signal());
        expect(bodyOf(fetchMock, 0).tools).toBeUndefined();
        expect(bodyOf(fetchMock, 1).tools.map((t: any) => t.type ?? t.name)).toEqual([ZOTERO_SEARCH_TOOL.name]);
    });

    it('reports a web-search-specific error when the provider rejects the web tool', async () => {
        const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'web search is not enabled for this organization'));
        vi.stubGlobal('fetch', fetchMock);
        const failure = await createAnthropicClient()
            .streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal())
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('bad_request');
        expect(failure.message).toMatch(/web search is not available for this provider or model/i);
        expect(failure.message).toContain('not enabled for this organization');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends one request and reports the web-search error when the tool type is rejected', async () => {
        const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, "Unknown tool type 'web_search_20250305'"));
        vi.stubGlobal('fetch', fetchMock);
        const failure = await createAnthropicClient()
            .streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal())
            .catch((e) => e);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(failure.message).toMatch(/web search is not available/i);
        expect(failure.message).toContain('web_search_20250305');
    });

    it('separates text that a search interrupted', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: "I'll search for it." } }),
                    frame('content_block_start', { index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' } }),
                    frame('content_block_start', { index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] } }),
                    frame('content_block_start', { index: 3, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 3, delta: { type: 'text_delta', text: 'Based on the results, ' } }),
                    frame('content_block_start', { index: 4, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 4, delta: { type: 'citations_delta', citation: { url: 'u', title: 't' } } }),
                    frame('content_block_delta', { index: 4, delta: { type: 'text_delta', text: 'he was born in 1916.' } }),
                    STOP
                )
            )
        );
        const h = handlers();
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), h, signal());
        // A search between text blocks separates them; a citation split does not.
        expect(result.text).toBe("I'll search for it.\n\nBased on the results, he was born in 1916.");
        expect(h.onTextDelta.mock.calls.map(([t]) => t)).toEqual([
            "I'll search for it.",
            "I'll search for it.\n\nBased on the results, ",
            "I'll search for it.\n\nBased on the results, he was born in 1916.",
        ]);
    });

    it('adds no separator when the text before a search already ends in whitespace', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Looking. ' } }),
                    frame('content_block_start', { index: 1, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' } }),
                    frame('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Found.' } }),
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(result.text).toBe('Looking. Found.');
    });

    it('replays a server tool call with no streamed input as an empty input object', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    frame('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search' } }),
                    frame('message_delta', { delta: { stop_reason: 'pause_turn' } }),
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(result.providerBlocks).toEqual([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }]);
    });

    it('does not retry or rewrite a 400 unrelated to the web tool', async () => {
        const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'max_tokens: too large'));
        vi.stubGlobal('fetch', fetchMock);
        const failure = await createAnthropicClient()
            .streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal())
            .catch((e) => e);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(failure.message).toBe('max_tokens: too large');
    });

    it('keeps text around a hosted search cumulative and collects its citations', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(...searchFrames('end_turn'))));
        const h = handlers();
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), h, signal());
        expect(h.onTextDelta.mock.calls.map(([t]) => t)).toEqual(['Let me look. ', 'Let me look. He was born in 1916.']);
        expect(result.text).toBe('Let me look. He was born in 1916.');
        expect(result.toolCalls).toEqual([]);
        expect(result.finishReason).toBe('stop');
        expect(result.citations).toEqual([
            { url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon' },
        ]);
    });

    it('returns the turn as raw content blocks for replay', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(...searchFrames('end_turn'))));
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(result.providerBlocks).toEqual([
            { type: 'text', text: 'Let me look. ' },
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'shannon' } },
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [{ type: 'web_search_result', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon', encrypted_content: 'enc' }],
            },
            {
                type: 'text',
                text: 'He was born in 1916.',
                citations: [
                    { type: 'web_search_result_location', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon', encrypted_index: 'ei', cited_text: 'born 1916' },
                ],
            },
        ]);
    });

    it('does not return raw blocks for a turn with no server-side content', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Plain.' } }),
                    STOP
                )
            )
        );
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(result.providerBlocks).toBeUndefined();
        expect(result.citations ?? []).toEqual([]);
    });

    it('maps pause_turn to a pause finish reason', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(...searchFrames('pause_turn'))));
        const result = await createAnthropicClient().streamTurn(turn({ webSearch: { enabled: true } }), handlers(), signal());
        expect(result.finishReason).toBe('pause');
        expect(result.toolCalls).toEqual([]);
        expect(result.providerBlocks?.length).toBe(4);
    });

    it('replays an assistant turn from its raw blocks verbatim', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        const blocks = [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
            { type: 'text', text: 'Found.', citations: [{ type: 'web_search_result_location', url: 'u', title: 't', encrypted_index: 'e', cited_text: 'c' }] },
            { type: 'tool_use', id: 'toolu_1', name: 'zotero_search', input: { query: 'x' } },
        ];
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: 'Found.\n\nSources:\n- [t](u)',
                        toolCalls: [{ id: 'toolu_1', name: 'zotero_search', args: { query: 'x' }, rawArgs: '{"query":"x"}', parseError: null }],
                        providerBlocks: blocks,
                    },
                    { role: 'tool', content: 'result', toolCallId: 'toolu_1' },
                ],
                webSearch: { enabled: true },
            }),
            handlers(),
            signal()
        );
        const wire = bodyOf(fetchMock).messages;
        expect(wire[1]).toEqual({ role: 'assistant', content: blocks });
        expect(wire[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }] });
    });

    it('merges a paused turn and its continuation into one assistant message', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse(STOP));
        vi.stubGlobal('fetch', fetchMock);
        const first = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }];
        const second = [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }, { type: 'text', text: 'Done.' }];
        await createAnthropicClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: '', providerBlocks: first },
                    { role: 'assistant', content: 'Done.', providerBlocks: second },
                ],
            }),
            handlers(),
            signal()
        );
        expect(bodyOf(fetchMock).messages[1]).toEqual({ role: 'assistant', content: [...first, ...second] });
    });

    it('reports a server-tool error result as a warning, not a failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    frame('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } }),
                    frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' } }),
                    frame('content_block_start', {
                        index: 1,
                        content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
                    }),
                    frame('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
                    frame('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'From memory: 1916.' } }),
                    frame('message_delta', { delta: { stop_reason: 'end_turn' } }),
                    STOP
                )
            )
        );
        const onWarning = vi.fn();
        const result = await createAnthropicClient().streamTurn(
            turn({ webSearch: { enabled: true } }),
            { ...handlers(), onWarning },
            signal()
        );
        expect(result.text).toBe('From memory: 1916.');
        expect(result.finishReason).toBe('stop');
        expect(onWarning).toHaveBeenCalledTimes(1);
        expect(onWarning.mock.calls[0][0]).toMatch(/search limit/i);
    });
});
