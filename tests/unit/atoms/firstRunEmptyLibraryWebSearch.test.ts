/**
 * The empty-library discovery run explicitly requires external search. Cloud
 * mode switches to an included Beaver model when the current selection cannot
 * search. Local mode has no Beaver-hosted fallback — `beaverDefaultModelAtom`
 * there is just the first custom model in the selector — so it must never
 * switch models; it only enables search when the provider actually supports
 * it, and blocks the run otherwise.
 */
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, unknown>() }));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => (prefs.has(key) ? prefs.get(key) : true),
    setPref: () => {},
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { enableWebSearchForEmptyLibraryDiscover } from '../../../react/atoms/firstRun';
import { isWebSearchEnabledAtom, requestPlusToolsAtom } from '../../../react/atoms/ui';
import { selectedModelAtom, supportedModelsAtom } from '../../../react/atoms/models';

const customModel = (custom_model: Record<string, unknown>) =>
    ({ id: 'c', name: 'c', is_custom: true, access_mode: 'byok', allow_app_key: false, custom_model } as any);
const anthropic = customModel({ name: 'Claude', snapshot: 'claude', api_key: 'k', api_base: 'https://api.anthropic.com', format: 'anthropic' });
const unsupported = customModel({ name: 'L', snapshot: 'l', api_key: 'k', api_base: 'https://api.example.com/v1', format: 'openai' });
const hostedModel = { id: 'hosted-1', name: 'Beaver default', is_custom: false, is_default: true, allow_app_key: true, allow_byok: false } as any;

beforeEach(() => prefs.clear());
afterEach(() => {
    (globalThis as any).Zotero.Beaver = undefined;
});

describe('enableWebSearchForEmptyLibraryDiscover', () => {
    describe('local mode', () => {
        beforeEach(() => {
            (globalThis as any).Zotero.Beaver = { localMode: true };
        });

        it('enables web search without switching the selected model when the provider supports it', () => {
            prefs.set('localWebSearch', true);
            const store = createStore();
            store.set(selectedModelAtom, anthropic);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(true);
            expect(store.get(isWebSearchEnabledAtom)).toBe(true);
            expect(store.get(selectedModelAtom)).toBe(anthropic);
        });

        it('blocks the run and never switches the model when the provider has no hosted search', () => {
            prefs.set('localWebSearch', true);
            const store = createStore();
            store.set(selectedModelAtom, unsupported);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(false);
            expect(store.get(isWebSearchEnabledAtom)).toBe(false);
            expect(store.get(selectedModelAtom)).toBe(unsupported);
            expect(store.get(selectedModelAtom)?.access_mode).toBe('byok');
        });

        it('blocks the run and never switches the model when the local web search pref is off', () => {
            prefs.set('localWebSearch', false);
            const store = createStore();
            store.set(selectedModelAtom, anthropic);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(false);
            expect(store.get(isWebSearchEnabledAtom)).toBe(false);
            expect(store.get(selectedModelAtom)).toBe(anthropic);
        });
    });

    describe('cloud mode (unchanged)', () => {
        beforeEach(() => {
            (globalThis as any).Zotero.Beaver = { localMode: false };
        });

        it('switches to the Beaver default model and stamps access_mode app_key when the selection cannot search', () => {
            const store = createStore();
            store.set(supportedModelsAtom, [hostedModel]);
            store.set(requestPlusToolsAtom, false);
            store.set(selectedModelAtom, { id: 'byok', access_mode: 'byok', allow_app_key: false, is_custom: false } as any);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(true);
            expect(store.get(selectedModelAtom)?.id).toBe('hosted-1');
            expect(store.get(selectedModelAtom)?.access_mode).toBe('app_key');
            expect(store.get(isWebSearchEnabledAtom)).toBe(true);
        });

        it('blocks the run when no fallback model is available', () => {
            const store = createStore();
            store.set(supportedModelsAtom, []);
            store.set(requestPlusToolsAtom, false);
            store.set(selectedModelAtom, { id: 'byok', access_mode: 'byok', allow_app_key: false, is_custom: false } as any);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(false);
            expect(store.get(isWebSearchEnabledAtom)).toBe(false);
        });

        it('enables search without switching models when the current selection already allows it', () => {
            const store = createStore();
            store.set(requestPlusToolsAtom, true);
            const model = { id: 'm', access_mode: 'byok', allow_app_key: false, is_custom: false } as any;
            store.set(selectedModelAtom, model);

            const proceeded = enableWebSearchForEmptyLibraryDiscover(store.get, store.set);

            expect(proceeded).toBe(true);
            expect(store.get(selectedModelAtom)).toBe(model);
            expect(store.get(isWebSearchEnabledAtom)).toBe(true);
        });
    });
});
