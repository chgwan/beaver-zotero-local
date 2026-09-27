/**
 * The models the selector may offer. In local mode there is no account, so
 * the backend model list is meaningless — and a stale one left over from an
 * earlier signed-in session must not appear either. Only custom providers are
 * ever connectable in local mode.
 */
import { createStore } from 'jotai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: () => undefined,
    setPref: () => {},
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { selectableModelsAtom, availableModelsAtom, supportedModelsAtom } from '../../../react/atoms/models';
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

describe('selectableModelsAtom', () => {
    beforeEach(() => {
        zotero.Beaver = undefined;
    });

    it('returns every available model when local mode is off', () => {
        zotero.Beaver = { localMode: false };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);

        const selectable = store.get(selectableModelsAtom);
        expect(selectable).toEqual(store.get(availableModelsAtom));
        expect(selectable.map((m) => m.id)).toEqual(['hosted-1', 'custom-1']);
    });

    it('keeps only custom providers when local mode is on', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        store.set(supportedModelsAtom, [hostedModel(), customModel()]);

        const selectable = store.get(selectableModelsAtom);
        expect(selectable.map((m) => m.id)).toEqual(['custom-1']);
    });

    it('drops a stale hosted list from an earlier signed-in session in local mode', () => {
        zotero.Beaver = { localMode: true };
        const store = createStore();
        // Simulates a backend model_configs snapshot left over in memory.
        store.set(supportedModelsAtom, [
            hostedModel({ id: 'hosted-1' }),
            hostedModel({ id: 'hosted-2', allow_byok: true, allow_app_key: false }),
        ]);

        expect(store.get(selectableModelsAtom)).toEqual([]);
    });
});
