/**
 * A keyless local server (Ollama, llama.cpp) is a usable custom model in
 * local mode when its endpoint is on this machine. Cloud mode keeps requiring
 * a key for every custom model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../src/utils/prefs', () => ({
    getPref: () => prefs.value,
    setPref: () => {},
}));
vi.mock('../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));

import { getCustomChatModelsFromPreferences } from '../../react/types/settings';
import { isCustomChatModel } from '@beaver/agent-core/types/customChatModel';

const zotero = (globalThis as any).Zotero;

const keyless = { name: 'Ollama', snapshot: 'llama3', api_key: '', api_base: 'http://localhost:11434/v1', format: 'openai' };
const keylessRemote = { ...keyless, name: 'Remote', api_base: 'http://192.168.1.5:11434/v1' };

afterEach(() => {
    zotero.Beaver = undefined;
    prefs.value = undefined;
});

describe('custom models without an API key', () => {
    it('keeps a keyless loopback model in local mode', () => {
        zotero.Beaver = { localMode: true };
        prefs.value = JSON.stringify([keyless, keylessRemote]);
        expect(getCustomChatModelsFromPreferences().map((m) => m.name)).toEqual(['Ollama']);
    });

    it('drops every keyless model in cloud mode', () => {
        zotero.Beaver = { localMode: false };
        prefs.value = JSON.stringify([keyless, keylessRemote]);
        expect(getCustomChatModelsFromPreferences()).toEqual([]);
    });

    it('requires a key by default', () => {
        expect(isCustomChatModel(keyless)).toBe(false);
        expect(isCustomChatModel(keyless, { allowBlankApiKey: () => true })).toBe(true);
    });
});
