import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, unknown>() }));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key),
    setPref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    localAgentConfigInputAtom,
    localModeStatusAtom,
    localSearchConfigAtom,
    localWebSearchStatusAtom,
} from '../../../react/atoms/localAgentConfig';
import { selectedModelAtom } from '../../../react/atoms/models';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';

const custom = {
    name: 'Mine',
    snapshot: 'llama',
    api_key: 'k',
    api_base: 'http://localhost:11434/v1',
    format: 'openai' as const,
};

describe('localAgentConfigInputAtom', () => {
    beforeEach(() => {
        prefs.clear();
    });

    it('uses the selected custom model', () => {
        const store = createStore();
        store.set(selectedModelAtom, { id: 'c1', name: 'Mine', is_custom: true, custom_model: custom } as any);

        expect(store.get(localAgentConfigInputAtom)).toEqual({ model: custom, maxRounds: null });
        expect(store.get(localModeStatusAtom)).toMatchObject({ ok: true });
    });

    it('never runs a Beaver-hosted model', () => {
        const store = createStore();
        store.set(selectedModelAtom, { id: 'hosted', name: 'Hosted', allow_app_key: true } as any);

        expect(store.get(localAgentConfigInputAtom).model).toBeNull();
        expect(store.get(localModeStatusAtom)).toMatchObject({ ok: false, reason: 'no_model' });
    });

    it('reads a positive round cap and follows preference changes', () => {
        const store = createStore();
        prefs.set('localMaxRounds', 0);
        expect(store.get(localAgentConfigInputAtom).maxRounds).toBeNull();

        prefs.set('localMaxRounds', 7);
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(localAgentConfigInputAtom).maxRounds).toBe(7);
    });
});

describe('localSearchConfigAtom', () => {
    beforeEach(() => {
        prefs.clear();
    });

    it('enables scholarly search unless the preference turns it off', () => {
        const store = createStore();
        expect(store.get(localSearchConfigAtom)).toEqual({
            scholarlySearch: true,
            openAlexApiKey: '',
            semanticScholarApiKey: '',
            webSearch: false,
            webSearchMaxUses: 3,
        });

        prefs.set('localScholarlySearch', false);
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(localSearchConfigAtom).scholarlySearch).toBe(false);
    });

    it('reads the search API keys and follows preference changes', () => {
        const store = createStore();
        prefs.set('openAlexApiKey', 'oa');
        prefs.set('semanticScholarApiKey', 's2');
        expect(store.get(localSearchConfigAtom)).toMatchObject({ openAlexApiKey: 'oa', semanticScholarApiKey: 's2' });

        prefs.set('openAlexApiKey', 'oa-2');
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(localSearchConfigAtom).openAlexApiKey).toBe('oa-2');
    });
});

describe('localSearchConfigAtom web search', () => {
    beforeEach(() => {
        prefs.clear();
    });

    it('reads the web search switch and a positive search limit', () => {
        const store = createStore();
        prefs.set('localWebSearch', true);
        prefs.set('localWebSearchMaxUses', 5);
        expect(store.get(localSearchConfigAtom)).toMatchObject({ webSearch: true, webSearchMaxUses: 5 });

        prefs.set('localWebSearchMaxUses', 0);
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(localSearchConfigAtom).webSearchMaxUses).toBe(3);
    });
});

describe('localWebSearchStatusAtom', () => {
    const anthropic = { name: 'Claude', snapshot: 'claude', api_key: 'k', api_base: 'https://api.anthropic.com', format: 'anthropic' as const };
    const select = (store: ReturnType<typeof createStore>, model: unknown) =>
        store.set(selectedModelAtom, { id: 'c', name: 'c', is_custom: true, custom_model: model } as any);

    beforeEach(() => {
        prefs.clear();
    });

    it('is off while the preference is off, whatever the provider', () => {
        const store = createStore();
        select(store, anthropic);
        expect(store.get(localWebSearchStatusAtom)).toEqual({ available: false, reason: 'off', kind: 'anthropic' });
    });

    it('is available for an Anthropic, OpenRouter or OpenAI model once enabled', () => {
        const store = createStore();
        prefs.set('localWebSearch', true);
        select(store, anthropic);
        expect(store.get(localWebSearchStatusAtom)).toEqual({ available: true, reason: null, kind: 'anthropic' });

        select(store, { ...custom, api_base: 'https://openrouter.ai/api/v1' });
        expect(store.get(localWebSearchStatusAtom)).toEqual({ available: true, reason: null, kind: 'openrouter' });

        select(store, { ...custom, api_base: 'https://api.openai.com/v1' });
        expect(store.get(localWebSearchStatusAtom)).toEqual({ available: true, reason: null, kind: 'openai-responses' });
    });

    it('is unsupported for providers without an available hosted search', () => {
        const store = createStore();
        prefs.set('localWebSearch', true);
        select(store, custom);
        expect(store.get(localWebSearchStatusAtom)).toEqual({ available: false, reason: 'unsupported', kind: null });
    });

    it('reports no model when the selection cannot run locally', () => {
        const store = createStore();
        prefs.set('localWebSearch', true);
        expect(store.get(localWebSearchStatusAtom)).toMatchObject({ available: false, reason: 'no_model' });
    });
});
