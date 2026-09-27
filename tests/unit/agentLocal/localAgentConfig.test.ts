import { describe, it, expect } from 'vitest';
import {
    resolveLocalAgentConfig,
    DEFAULT_MAX_ROUNDS,
} from '@beaver/agent-local/config/localAgentConfig';

const openAiModel = {
    name: 'GPT',
    snapshot: 'gpt-4.1',
    api_key: 'sk-test',
    api_base: 'https://api.openai.com/v1',
    format: 'openai' as const,
};

describe('resolveLocalAgentConfig', () => {
    it('accepts a complete OpenAI-format model', () => {
        const result = resolveLocalAgentConfig({ model: openAiModel, maxRounds: null });
        expect(result).toEqual({
            ok: true,
            config: { model: openAiModel, maxRounds: DEFAULT_MAX_ROUNDS },
        });
    });

    it('accepts a complete Anthropic-format model', () => {
        const model = {
            ...openAiModel,
            api_base: 'https://api.anthropic.com',
            format: 'anthropic' as const,
        };
        expect(resolveLocalAgentConfig({ model, maxRounds: null }).ok).toBe(true);
    });

    it('reports no_model when no model is selected', () => {
        expect(resolveLocalAgentConfig({ model: null, maxRounds: null })).toMatchObject({
            ok: false,
            reason: 'no_model',
        });
    });

    it('reports no_api_key when the key is blank', () => {
        const model = { ...openAiModel, api_key: '   ' };
        expect(resolveLocalAgentConfig({ model, maxRounds: null })).toMatchObject({
            ok: false,
            reason: 'no_api_key',
        });
    });

    it('reports unsupported_format for a format it cannot speak', () => {
        const model = { ...openAiModel, format: 'cohere' as unknown as 'openai' };
        expect(resolveLocalAgentConfig({ model, maxRounds: null })).toMatchObject({
            ok: false,
            reason: 'unsupported_format',
        });
    });

    it('defaults a missing format to openai', () => {
        const { format, ...noFormat } = openAiModel;
        const result = resolveLocalAgentConfig({ model: noFormat, maxRounds: null });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.model.format).toBe('openai');
    });

    it('reports invalid_endpoint when there is no endpoint to call', () => {
        const { api_base, ...noBase } = openAiModel;
        expect(resolveLocalAgentConfig({ model: noBase, maxRounds: null })).toMatchObject({
            ok: false,
            reason: 'invalid_endpoint',
        });
    });

    it('allows a loopback endpoint, which the hosted path forbids', () => {
        const model = { ...openAiModel, api_base: 'http://127.0.0.1:11434/v1' };
        expect(resolveLocalAgentConfig({ model, maxRounds: null }).ok).toBe(true);
    });

    it('honours a configured round cap', () => {
        const result = resolveLocalAgentConfig({ model: openAiModel, maxRounds: 4 });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.maxRounds).toBe(4);
    });

    it('ignores a nonsensical round cap', () => {
        const result = resolveLocalAgentConfig({ model: openAiModel, maxRounds: 0 });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config.maxRounds).toBe(DEFAULT_MAX_ROUNDS);
    });

    it('defaults a native OpenRouter model with no api_base to the OpenRouter endpoint', () => {
        const { api_base, format, ...rest } = openAiModel;
        const model = { ...rest, provider: 'openrouter' };
        const result = resolveLocalAgentConfig({ model, maxRounds: null });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.model.api_base).toBe('https://openrouter.ai/api/v1');
        }
    });
});
