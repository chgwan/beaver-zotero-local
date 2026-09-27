import { describe, it, expect, vi, afterEach } from 'vitest';
import { clientForFormat } from '@beaver/agent-local/llm/clientForFormat';

const anthropicModel = {
    name: 'Claude',
    snapshot: 'claude-sonnet-4-5',
    api_key: 'sk-ant-test',
    api_base: 'https://api.anthropic.com',
    format: 'anthropic' as const,
};

const openAiModel = {
    name: 'GPT',
    snapshot: 'gpt-4.1',
    api_key: 'sk-test',
    api_base: 'https://api.openai.com/v1',
    format: 'openai' as const,
};

const sseResponse = () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
        getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {},
            releaseLock: () => {},
        }),
    },
    text: async () => '',
    json: async () => ({}),
});

const handlers = () => ({ onTextDelta: vi.fn(), onThinkingDelta: vi.fn() });
const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('clientForFormat', () => {
    it('picks the Anthropic client, which authenticates with x-api-key', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse());
        vi.stubGlobal('fetch', fetchMock);
        await clientForFormat('anthropic').streamTurn(
            { model: anthropicModel, messages: [{ role: 'user', content: 'hi' }], tools: [] },
            handlers(),
            signal()
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(init.headers['x-api-key']).toBe('sk-ant-test');
    });

    it('picks the OpenAI client, which authenticates with a bearer token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse());
        vi.stubGlobal('fetch', fetchMock);
        await clientForFormat('openai').streamTurn(
            { model: openAiModel, messages: [{ role: 'user', content: 'hi' }], tools: [] },
            handlers(),
            signal()
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-test');
    });
});
