import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, unknown>() }));

// Every preference reads as true unless a test sets it.
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => (prefs.has(key) ? prefs.get(key) : true),
    setPref: (key: string, value: unknown) => prefs.set(key, value),
}));

import { isWebSearchAllowedAtom, requestPlusToolsAtom } from '../../../react/atoms/ui';
import { selectedModelAtom } from '../../../react/atoms/models';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';

const customModel = (custom_model: Record<string, unknown>) =>
    ({ id: 'c', name: 'c', is_custom: true, access_mode: 'byok', allow_app_key: false, custom_model } as any);
const anthropic = customModel({ name: 'Claude', snapshot: 'claude', api_key: 'k', api_base: 'https://api.anthropic.com', format: 'anthropic' });
const openRouter = customModel({ name: 'OR', snapshot: 'x/y', api_key: 'k', api_base: 'https://openrouter.ai/api/v1', format: 'openai' });
const openAi = customModel({ name: 'GPT', snapshot: 'gpt', api_key: 'k', api_base: 'https://api.openai.com/v1', format: 'openai' });
const compatible = customModel({ name: 'L', snapshot: 'l', api_key: 'k', api_base: 'https://api.example.com/v1', format: 'openai' });

beforeEach(() => prefs.clear());
afterEach(() => {
    Zotero.Beaver = { ...(Zotero.Beaver as any), localMode: false } as any;
});

describe('isWebSearchAllowedAtom', () => {
    describe('in local mode', () => {
        beforeEach(() => {
            Zotero.Beaver = { ...(Zotero.Beaver as any), localMode: true } as any;
        });

        it('ignores a stale requestPlusTools pref left over from cloud mode', () => {
            prefs.set('localWebSearch', false);
            const store = createStore();
            store.set(selectedModelAtom, anthropic);
            expect(store.get(requestPlusToolsAtom)).toBe(true);
            expect(store.get(isWebSearchAllowedAtom)).toBe(false);
        });

        it('allows hosted search for Anthropic and OpenRouter models when the preference is on', () => {
            prefs.set('localWebSearch', true);
            const store = createStore();
            store.set(selectedModelAtom, anthropic);
            expect(store.get(isWebSearchAllowedAtom)).toBe(true);
            store.set(selectedModelAtom, openRouter);
            expect(store.get(isWebSearchAllowedAtom)).toBe(true);
        });

        it('refuses providers without an available hosted search', () => {
            prefs.set('localWebSearch', true);
            const store = createStore();
            store.set(selectedModelAtom, openAi);
            expect(store.get(isWebSearchAllowedAtom)).toBe(false);
            store.set(selectedModelAtom, compatible);
            expect(store.get(isWebSearchAllowedAtom)).toBe(false);
        });

        it('follows the preference when it changes', () => {
            prefs.set('localWebSearch', false);
            const store = createStore();
            store.set(selectedModelAtom, anthropic);
            expect(store.get(isWebSearchAllowedAtom)).toBe(false);

            prefs.set('localWebSearch', true);
            store.set(preferencesRevisionAtom, 1);
            expect(store.get(isWebSearchAllowedAtom)).toBe(true);
        });
    });

    it('follows Plus Tools / Beaver-credits state in cloud mode', () => {
        const store = createStore();
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);

        store.set(requestPlusToolsAtom, false);
        // No model selected yet defaults to "using Beaver credits".
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);

        store.set(selectedModelAtom, { access_mode: 'byok', allow_app_key: false } as any);
        expect(store.get(isWebSearchAllowedAtom)).toBe(false);

        store.set(requestPlusToolsAtom, true);
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);
    });

    it('ignores the local web search preference in cloud mode', () => {
        prefs.set('localWebSearch', false);
        const store = createStore();
        store.set(selectedModelAtom, compatible);
        store.set(requestPlusToolsAtom, true);
        expect(store.get(isWebSearchAllowedAtom)).toBe(true);
    });
});
