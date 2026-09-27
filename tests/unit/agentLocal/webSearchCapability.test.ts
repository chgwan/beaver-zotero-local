import { describe, it, expect } from 'vitest';
import {
    supportsHostedWebSearch,
    isHostedWebSearchAvailable,
    isAnthropicOfficialHost,
} from '@beaver/agent-local/llm/webSearchCapability';

const model = (overrides: Record<string, unknown> = {}) => ({
    name: 'M',
    snapshot: 'm',
    api_key: 'k',
    ...overrides,
});

describe('supportsHostedWebSearch', () => {
    it('reports anthropic for any Anthropic-format model', () => {
        expect(supportsHostedWebSearch(model({ format: 'anthropic', api_base: 'https://api.anthropic.com' }))).toBe('anthropic');
    });

    it('reports openrouter for an OpenAI-format model on openrouter.ai', () => {
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'https://openrouter.ai/api/v1' }))).toBe('openrouter');
    });

    it('reports openrouter for a native OpenRouter entry with no api_base', () => {
        expect(supportsHostedWebSearch(model({ provider: 'openrouter' }))).toBe('openrouter');
    });

    it('reports openai-responses for api.openai.com', () => {
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'https://api.openai.com/v1' }))).toBe('openai-responses');
    });

    it('reports null for other OpenAI-compatible and local servers', () => {
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'https://api.deepseek.com/v1' }))).toBeNull();
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'http://localhost:11434/v1' }))).toBeNull();
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'not a url' }))).toBeNull();
    });

    it('does not match a host that only contains a provider name', () => {
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'https://openrouter.ai.example.com/v1' }))).toBeNull();
        expect(supportsHostedWebSearch(model({ format: 'openai', api_base: 'https://proxy.example.com/api.openai.com' }))).toBeNull();
    });

    it('reports null with no model', () => {
        expect(supportsHostedWebSearch(null)).toBeNull();
    });
});

describe('isAnthropicOfficialHost', () => {
    it('is true for an Anthropic-format model on api.anthropic.com', () => {
        expect(isAnthropicOfficialHost(model({ format: 'anthropic', api_base: 'https://api.anthropic.com' }))).toBe(true);
    });

    it('is false for an Anthropic-format model on any other host', () => {
        expect(isAnthropicOfficialHost(model({ format: 'anthropic', api_base: 'https://my-proxy.example.com' }))).toBe(false);
        expect(isAnthropicOfficialHost(model({ format: 'anthropic', api_base: '' }))).toBe(false);
        expect(isAnthropicOfficialHost(model({ format: 'anthropic' }))).toBe(false);
    });

    it('is false for a non-Anthropic-format model, even on api.anthropic.com', () => {
        expect(isAnthropicOfficialHost(model({ format: 'openai', api_base: 'https://api.anthropic.com' }))).toBe(false);
    });

    it('is false with no model', () => {
        expect(isAnthropicOfficialHost(null)).toBe(false);
        expect(isAnthropicOfficialHost(undefined)).toBe(false);
    });
});

describe('isHostedWebSearchAvailable', () => {
    it('is true for Anthropic, OpenRouter and api.openai.com', () => {
        expect(isHostedWebSearchAvailable(model({ format: 'anthropic', api_base: 'https://api.anthropic.com' }))).toBe(true);
        expect(isHostedWebSearchAvailable(model({ format: 'openai', api_base: 'https://openrouter.ai/api/v1' }))).toBe(true);
        expect(isHostedWebSearchAvailable(model({ format: 'openai', api_base: 'https://api.openai.com/v1' }))).toBe(true);
    });

    it('is false for providers without hosted search', () => {
        expect(isHostedWebSearchAvailable(model({ format: 'openai', api_base: 'http://127.0.0.1:8080/v1' }))).toBe(false);
        expect(isHostedWebSearchAvailable(null)).toBe(false);
    });
});
