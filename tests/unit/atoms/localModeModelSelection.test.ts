/**
 * In local mode, only custom-provider models are ever connectable — the menu
 * (`selectableModelsAtom`) already enforces this. `validateSelectedModelAtom`
 * and `beaverDefaultModelAtom` must enforce the same invariant at the data
 * layer: a stale hosted/BYOK `selectedModelAtom` (e.g. from `lastUsedModel`,
 * persisted before local mode was turned on) must not survive validation, and
 * the "default" model in local mode must be a custom one, not a hosted one.
 * Cloud mode must be unaffected.
 */
import { createStore } from 'jotai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => undefined,
    setPref: () => {},
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    beaverDefaultModelAtom,
    selectedModelAtom,
    supportedModelsAtom,
    validateSelectedModelAtom,
} from '../../../react/atoms/models';
import type { ModelConfig } from '../../../react/atoms/models';

const zotero = (globalThis as any).Zotero;

const hostedModel = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
    id: 'hosted-1',
    provider: 'anthropic',
    name: 'Beaver model',
    snapshot: 'claude',
    pricing: { input: 0, output: 0 },
    credit_cost: 0,
    is_default: true,
    allow_byok: false,
    allow_app_key: true,
    is_custom: false,
    ...overrides,
} as ModelConfig);

const customModel = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
    id: 'custom-1',
    provider: 'custom',
    name: 'My local model',
    snapshot: 'llama',
    pricing: { input: 0, output: 0 },
    credit_cost: 0,
    is_default: false,
    allow_byok: true,
    allow_app_key: false,
    is_custom: true,
    ...overrides,
} as ModelConfig);

afterAll(() => {
    zotero.Beaver = undefined;
});

describe('validateSelectedModelAtom in local mode', () => {
    beforeEach(() => {
        zotero.Beaver = undefined;
    });

    it('replaces a stale hosted selection with the first custom model', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);
        store.set(selectedModelAtom, hostedModel());

        store.set(validateSelectedModelAtom);

        expect(store.get(selectedModelAtom)?.id).toBe('custom-1');
        expect(store.get(selectedModelAtom)?.is_custom).toBe(true);
    });

    it('clears the selection to null when no custom model is configured', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel()]);
        store.set(selectedModelAtom, hostedModel());

        store.set(validateSelectedModelAtom);

        expect(store.get(selectedModelAtom)).toBeNull();
    });

    it('leaves an already-custom selection alone', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [customModel(), customModel({ id: 'custom-2', name: 'Other local model' })]);
        store.set(selectedModelAtom, customModel({ id: 'custom-2', name: 'Other local model' }));

        store.set(validateSelectedModelAtom);

        expect(store.get(selectedModelAtom)?.id).toBe('custom-2');
    });

    it('does not change cloud-mode behavior', () => {
        zotero.Beaver = { localMode: false };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);
        store.set(selectedModelAtom, hostedModel());

        store.set(validateSelectedModelAtom);

        expect(store.get(selectedModelAtom)?.id).toBe('hosted-1');
    });
});

describe('beaverDefaultModelAtom in local mode', () => {
    beforeEach(() => {
        zotero.Beaver = undefined;
    });

    it('returns the first custom model', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);

        expect(store.get(beaverDefaultModelAtom)?.id).toBe('custom-1');
    });

    it('returns null when there is no custom model', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel()]);

        expect(store.get(beaverDefaultModelAtom)).toBeNull();
    });

    it('does not change cloud-mode behavior', () => {
        zotero.Beaver = { localMode: false };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);

        expect(store.get(beaverDefaultModelAtom)?.id).toBe('hosted-1');
    });
});
