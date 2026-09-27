import { describe, it, expect, vi, afterEach } from 'vitest';
import { clientForFormat, clientForRun } from '@beaver/agent-local/llm/clientForFormat';

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

describe('clientForRun', () => {
    const urlOf = async (client: ReturnType<typeof clientForRun>, model: any, webSearch?: { enabled: boolean }) => {
        const fetchMock = vi.fn().mockResolvedValue(sseResponse());
        vi.stubGlobal('fetch', fetchMock);
        await client.streamTurn(
            { model, messages: [{ role: 'user', content: 'hi' }], tools: [], ...(webSearch ? { webSearch } : {}) },
            handlers(),
            signal()
        );
        return fetchMock.mock.calls[0][0];
    };

    it('uses the Responses API for an api.openai.com run with web search on', async () => {
        const webSearch = { enabled: true };
        expect(await urlOf(clientForRun(openAiModel, webSearch), openAiModel, webSearch)).toBe(
            'https://api.openai.com/v1/responses'
        );
    });

    it('keeps Chat Completions for an api.openai.com run without web search', async () => {
        expect(await urlOf(clientForRun(openAiModel), openAiModel)).toBe('https://api.openai.com/v1/chat/completions');
        const off = { enabled: false };
        expect(await urlOf(clientForRun(openAiModel, off), openAiModel, off)).toBe(
            'https://api.openai.com/v1/chat/completions'
        );
    });

    it('keeps Chat Completions for other OpenAI-format hosts even with web search on', async () => {
        const webSearch = { enabled: true };
        const openRouter = { ...openAiModel, api_base: 'https://openrouter.ai/api/v1' };
        expect(await urlOf(clientForRun(openRouter, webSearch), openRouter, webSearch)).toBe(
            'https://openrouter.ai/api/v1/chat/completions'
        );
        const localServer = { ...openAiModel, api_base: 'http://localhost:11434/v1' };
        expect(await urlOf(clientForRun(localServer, webSearch), localServer, webSearch)).toBe(
            'http://localhost:11434/v1/chat/completions'
        );
    });

    it('uses the Anthropic client for an Anthropic model', async () => {
        const webSearch = { enabled: true };
        expect(await urlOf(clientForRun(anthropicModel, webSearch), anthropicModel, webSearch)).toBe(
            'https://api.anthropic.com/v1/messages'
        );
    });
});
