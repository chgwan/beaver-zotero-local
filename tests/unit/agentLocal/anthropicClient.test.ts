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
