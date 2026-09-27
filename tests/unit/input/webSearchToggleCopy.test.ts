import { describe, expect, it } from 'vitest';
import { webSearchToggleCopy } from '../../../react/components/input/webSearchToggleCopy';

const HOSTED = "Search the web with your provider's hosted search. Your provider may bill per search.";

describe('webSearchToggleCopy', () => {
    it('keeps the cloud copy unchanged', () => {
        expect(webSearchToggleCopy({ localMode: false, allowed: false, enabled: false, localReason: null })).toEqual({
            title: 'Web search requires Beaver credits',
            detail: 'Use a Beaver model, or enable Plus Tools in Settings → API Keys',
            description: 'Web search is unavailable. It requires Beaver credits. Use a Beaver model, or enable Plus Tools in Settings, API Keys.',
        });
        expect(webSearchToggleCopy({ localMode: false, allowed: true, enabled: true, localReason: null })).toEqual({
            title: 'Stop requesting web search',
            detail: 'May still search the web when helpful',
            description: 'Web search is enabled.',
        });
        expect(webSearchToggleCopy({ localMode: false, allowed: true, enabled: false, localReason: null })).toEqual({
            title: 'Request web search',
            detail: 'May search the web either way',
            description: 'Web search is disabled.',
        });
    });

    it("names the provider's hosted search and its billing in local mode", () => {
        expect(webSearchToggleCopy({ localMode: true, allowed: true, enabled: false, localReason: null })).toEqual({
            title: 'Request web search',
            detail: HOSTED,
            description: 'Web search is disabled.',
        });
        expect(webSearchToggleCopy({ localMode: true, allowed: true, enabled: true, localReason: null }).detail).toBe(HOSTED);
    });

    it('gives the reason web search is disabled in local mode', () => {
        const unsupported = webSearchToggleCopy({ localMode: true, allowed: false, enabled: false, localReason: 'unsupported' });
        expect(unsupported.title).toBe('Web search is not available for this provider');
        expect(unsupported.detail).toMatch(/Anthropic, OpenAI and OpenRouter/);
        expect(unsupported.description).toMatch(/^Web search is unavailable\./);

        const off = webSearchToggleCopy({ localMode: true, allowed: false, enabled: false, localReason: 'off' });
        expect(off.title).toBe('Web search is turned off');
        expect(off.detail).toMatch(/Settings/);

        const noModel = webSearchToggleCopy({ localMode: true, allowed: false, enabled: false, localReason: 'no_model' });
        expect(noModel.title).toBe('Web search is unavailable');
    });
});
