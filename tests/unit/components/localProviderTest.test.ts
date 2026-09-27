/**
 * Local mode's "Test Endpoint" button talks to the provider directly from the
 * plugin (no backend hop), through the same `LlmClient` the local agent loop
 * uses. These tests stub that client to cover success, a provider error, and
 * a timeout, without making a network request.
 */
import { describe, expect, it, vi } from 'vitest';
import { LlmRequestError } from '@beaver/agent-local/llm/types';
import type { LlmClient } from '@beaver/agent-local/llm/types';
import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import { OPENROUTER_API_BASE } from '@beaver/agent-core/types/customChatModel';
import {
    plainHttpWarning,
    testLocalEndpoint,
    testLocalProvider,
} from '../../../react/components/preferences/localProviderTest';

const model: CustomChatModel = {
    name: 'My local model',
    snapshot: 'llama3',
    api_base: 'http://localhost:11434/v1',
    api_key: '',
    format: 'openai',
};

describe('testLocalProvider', () => {
    it('reports success with the model reply on a completed turn', async () => {
        const client: LlmClient = {
            streamTurn: vi.fn(async (_request, handlers) => {
                handlers.onTextDelta('Hello there!');
                return {
                    text: 'Hello there!',
                    thinking: '',
                    toolCalls: [],
                    finishReason: 'stop',
                    usage: null,
                };
            }),
        };

        const result = await testLocalProvider(model, client);

        expect(result.ok).toBe(true);
        expect(result.message).toContain('Hello there!');
        expect(client.streamTurn).toHaveBeenCalledTimes(1);
        // No tools offered for a connectivity check.
        const [request] = (client.streamTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(request.tools).toEqual([]);
        expect(request.model).toBe(model);
    });

    it('reports the provider error message on failure', async () => {
        const client: LlmClient = {
            streamTurn: vi.fn(async () => {
                throw new Error('401 Unauthorized');
            }),
        };

        const result = await testLocalProvider(model, client);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/401 Unauthorized/);
    });

    it('reports a timeout message when the request is cancelled', async () => {
        const client: LlmClient = {
            streamTurn: vi.fn(async (_request, _handlers, signal) => {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(new LlmRequestError('cancelled', 'aborted'));
                    });
                });
            }),
        };

        const result = await testLocalProvider(model, client, 5);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/timed out/i);
    });

    it('reports cancellation, not an error, when the caller aborts externally', async () => {
        const client: LlmClient = {
            streamTurn: vi.fn(async (_request, _handlers, signal) => {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(new LlmRequestError('cancelled', 'aborted'));
                    });
                });
            }),
        };
        const controller = new AbortController();

        const resultPromise = testLocalProvider(model, client, undefined, controller.signal);
        controller.abort();
        const result = await resultPromise;

        expect(result.ok).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.message).not.toMatch(/timed out/i);
    });

    it('never includes the api key in the request messages', async () => {
        const secretModel: CustomChatModel = { ...model, api_key: 'super-secret-key' };
        const client: LlmClient = {
            streamTurn: vi.fn(async () => ({
                text: 'ok',
                thinking: '',
                toolCalls: [],
                finishReason: 'stop' as const,
                usage: null,
            })),
        };

        await testLocalProvider(secretModel, client);

        const [request] = (client.streamTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        const serialized = JSON.stringify(request.messages);
        expect(serialized).not.toContain('super-secret-key');
    });
});

describe('testLocalEndpoint', () => {
    const okClient = (): LlmClient => ({
        streamTurn: vi.fn(async () => ({ text: 'ok', thinking: '', toolCalls: [], finishReason: 'stop' as const, usage: null })),
    });

    it('resolves the model the way a chat does, so an OpenRouter entry needs no endpoint', async () => {
        const client = okClient();
        const clientFor = vi.fn(() => client);
        const result = await testLocalEndpoint(
            { name: 'OR', snapshot: 'openai/gpt-4.1', api_key: 'sk-or', provider: 'openrouter' },
            undefined,
            { clientFor },
        );
        expect(result.ok).toBe(true);
        expect(clientFor).toHaveBeenCalledWith('openai');
        const [request] = (client.streamTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(request.model.api_base).toBe(OPENROUTER_API_BASE);
    });

    it('reports a configuration problem without contacting the provider', async () => {
        const clientFor = vi.fn(() => okClient());
        const result = await testLocalEndpoint(
            { name: 'Remote', snapshot: 'm', api_key: '', api_base: 'https://api.example.com/v1', format: 'openai' },
            undefined,
            { clientFor },
        );
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/API key/);
        expect(clientFor).not.toHaveBeenCalled();
    });

    it('tests a keyless loopback server', async () => {
        const result = await testLocalEndpoint(model, undefined, { clientFor: () => okClient() });
        expect(result.ok).toBe(true);
    });
});

describe('plainHttpWarning', () => {
    it('warns about plain http to a host off this machine', () => {
        expect(plainHttpWarning('http://192.168.1.5:11434/v1')).toMatch(/unencrypted/i);
        expect(plainHttpWarning('http://example.com/v1')).toMatch(/unencrypted/i);
    });

    it('stays quiet for https, loopback, and unparseable input', () => {
        expect(plainHttpWarning('https://api.openai.com/v1')).toBeNull();
        expect(plainHttpWarning('http://localhost:11434/v1')).toBeNull();
        expect(plainHttpWarning('http://127.0.0.1:8080')).toBeNull();
        expect(plainHttpWarning('not a url')).toBeNull();
        expect(plainHttpWarning(undefined)).toBeNull();
    });
});
