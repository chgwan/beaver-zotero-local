import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenAiClient } from '@beaver/agent-local/llm/openAiClient';
import { LlmRequestError } from '@beaver/agent-local/llm/types';
import { ZOTERO_SEARCH_TOOL } from '@beaver/agent-local/tools/toolSchemas';

const model = {
    name: 'GPT',
    snapshot: 'gpt-4.1',
    api_key: 'sk-test',
    api_base: 'https://api.openai.com/v1',
    format: 'openai' as const,
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

const errorResponse = (status: number, statusText: string, body: string) => ({
    ok: false,
    status,
    statusText,
    body: null,
    text: async () => body,
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

afterEach(() => vi.unstubAllGlobals());

describe('createOpenAiClient', () => {
    it('streams cumulative text rather than deltas', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'data: {"choices":[{"delta":{"content":"Rea"}}]}\n\n',
                    'data: {"choices":[{"delta":{"content":"dy."}}]}\n\n',
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                    'data: [DONE]\n\n'
                )
            )
        );
        const h = handlers();
        const result = await createOpenAiClient().streamTurn(turn(), h, signal());
        expect(h.onTextDelta.mock.calls.map(([t]) => t)).toEqual(['Rea', 'Ready.']);
        expect(result.text).toBe('Ready.');
        expect(result.finishReason).toBe('stop');
    });

    it('reassembles tool arguments streamed across frames', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"zotero_search","arguments":"{\\"que"}}]}}]}\n\n',
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"x\\"}"}}]}}]}\n\n',
                    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
                    'data: [DONE]\n\n'
                )
            )
        );
        const result = await createOpenAiClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL] }),
            handlers(),
            signal()
        );
        expect(result.finishReason).toBe('tool_calls');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
            id: 'c1',
            name: 'zotero_search',
            args: { query: 'x' },
            parseError: null,
        });
    });

    it('sends tools in the OpenAI function envelope', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiClient().streamTurn(
            turn({ tools: [ZOTERO_SEARCH_TOOL] }),
            handlers(),
            signal()
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
        const sent = JSON.parse(init.body);
        expect(sent.stream).toBe(true);
        expect(sent.model).toBe('gpt-4.1');
        expect(sent.tools[0]).toEqual({
            type: 'function',
            function: {
                name: ZOTERO_SEARCH_TOOL.name,
                description: ZOTERO_SEARCH_TOOL.description,
                parameters: ZOTERO_SEARCH_TOOL.parameters,
            },
        });
    });

    it('omits the tools field entirely when there are none', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiClient().streamTurn(turn(), handlers(), signal());
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('tools');
    });

    it('classifies a 401 as an auth error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                errorResponse(401, 'Unauthorized', '{"error":{"message":"bad key"}}')
            )
        );
        await expect(
            createOpenAiClient().streamTurn(turn(), handlers(), signal())
        ).rejects.toMatchObject({ kind: 'auth' });
    });

    it('classifies a 429 as a rate limit and surfaces the provider message', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                errorResponse(429, 'Too Many Requests', '{"error":{"message":"slow down"}}')
            )
        );
        const failure = await createOpenAiClient()
            .streamTurn(turn(), handlers(), signal())
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('rate_limit');
        expect(failure.message).toContain('slow down');
    });

    it('classifies a thrown fetch as a network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
        await expect(
            createOpenAiClient().streamTurn(turn(), handlers(), signal())
        ).rejects.toMatchObject({ kind: 'network' });
    });

    it('joins the endpoint path without doubling a trailing slash', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiClient().streamTurn(
            turn({ model: { ...model, api_base: 'https://api.openai.com/v1/' } }),
            handlers(),
            signal()
        );
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('serialises assistant tool calls and tool results back into the transcript', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiClient().streamTurn(
            turn({
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            {
                                id: 'c1',
                                name: 'zotero_search',
                                args: { query: 'x' },
                                rawArgs: '{"query":"x"}',
                                parseError: null,
                            },
                        ],
                    },
                    { role: 'tool', content: '{"results":[]}', toolCallId: 'c1' },
                ],
            }),
            handlers(),
            signal()
        );
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages[1]).toEqual({
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'zotero_search', arguments: '{"query":"x"}' },
                },
            ],
        });
        expect(sent.messages[2]).toEqual({
            role: 'tool',
            tool_call_id: 'c1',
            content: '{"results":[]}',
        });
    });

    it('captures usage from a final chunk with empty choices', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
                    'data: [DONE]\n\n'
                )
            )
        );
        const result = await createOpenAiClient().streamTurn(turn(), handlers(), signal());
        expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    });

    it('reports null usage when the provider never sends it', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                sseResponse(
                    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
                    'data: [DONE]\n\n'
                )
            )
        );
        const result = await createOpenAiClient().streamTurn(turn(), handlers(), signal());
        expect(result.usage).toBeNull();
    });

    it('never requests stream_options', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
        vi.stubGlobal('fetch', fetchMock);
        await createOpenAiClient().streamTurn(turn(), handlers(), signal());
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('stream_options');
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
        const failure = await createOpenAiClient()
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
                    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
                    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                    'data: [DONE]\n\n'
                )
            )
        );
        const failure = await createOpenAiClient()
            .streamTurn(turn(), { onTextDelta, onThinkingDelta: vi.fn() }, controller.signal)
            .catch((e) => e);
        expect(failure).toBeInstanceOf(LlmRequestError);
        expect(failure.kind).toBe('cancelled');
    });
});
