// @vitest-environment jsdom
//
// The preferences window is a separate chrome realm and may not expose a full
// `crypto` global (see ApiKeysSection.tsx's `createProviderId`). These tests
// stub the global so `crypto.randomUUID` is absent, then drive Add/Duplicate
// through the real component to confirm provider ids are still generated
// (via the `uuid` package) instead of throwing.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    initialModels: [] as any[],
}));

vi.mock('jotai', () => ({
    useAtom: () => [false, vi.fn()],
    useAtomValue: () => false,
    useSetAtom: () => vi.fn(),
}));
vi.mock('@beaver/agent-ui/primitives/Button', () => ({
    default: ({ children, onClick }: any) => React.createElement('button', { onClick }, children),
}));
vi.mock('@beaver/agent-ui/icons/PlusSignIcon', () => ({ default: () => null }));
vi.mock('@beaver/agent-local/config/localAgentConfig', () => ({ DEFAULT_MAX_ROUNDS: 10 }));
vi.mock('../../../react/components/preferences/components/SettingsElements', () => ({
    SettingsGroup: ({ children }: any) => React.createElement('div', null, children),
    SettingsRow: ({ control, description }: any) => React.createElement('div', null, description, control),
    SectionLabel: ({ children }: any) => React.createElement('div', null, children),
    DocLink: ({ children }: any) => React.createElement('span', null, children),
    ExternalLink: ({ children }: any) => React.createElement('span', null, children),
    SectionDescription: ({ children }: any) => React.createElement('div', null, children),
    INTELLIGENCE_INDEX_URL: 'https://example.com/index',
}));
vi.mock('../../../react/components/preferences/ApiKeyInput', () => ({ default: () => null }));
vi.mock('../../../react/components/icons/icons', () => ({ Icon: () => null, AlertIcon: () => null }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => {
        if (key === 'localMaxRounds' || key === 'localWebSearchMaxUses') return 0;
        if (['openAlexApiKey', 'semanticScholarApiKey', 'googleGenerativeAiApiKey', 'openAiApiKey', 'anthropicApiKey'].includes(key)) return '';
        return false;
    },
    setPref: vi.fn(),
}));
vi.mock('../../../react/components/preferences/utils', () => ({ handlePrefSave: vi.fn() }));
vi.mock('../../../react/atoms/ui', () => ({ activePreferencePageTabAtom: {}, requestPlusToolsAtom: {} }));
vi.mock('../../../react/atoms/profile', () => ({ remainingBeaverCreditsAtom: {} }));
vi.mock('../../../react/atoms/models', () => ({ refreshCustomModelsAtom: {} }));
vi.mock('../../../react/atoms/localMode', () => ({ localModeEnabledAtom: {} }));
vi.mock('../../../react/atoms/localAgentConfig', () => ({ localModeStatusAtom: {}, localWebSearchStatusAtom: {} }));
vi.mock('../../../react/hooks/usePreference', () => ({
    usePreference: (read: () => any) => [read(), vi.fn()],
}));
vi.mock('../../../react/components/preferences/localModeSettings', () => ({
    needsLocalModeRestart: () => false,
    showLocalRoundCap: () => false,
    LOCAL_ROUND_CAP_DESCRIPTION: '',
    parseLocalMaxRoundsInput: () => null,
    DEFAULT_LOCAL_WEB_SEARCH_MAX_USES: 3,
    LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION: '',
    localWebSearchDescription: () => '',
    parseLocalWebSearchMaxUsesInput: () => null,
}));
vi.mock('../../../react/types/settings', () => ({
    getCustomChatModelsForEditing: () => mocks.initialModels,
    saveCustomChatModelsToPreferences: vi.fn(),
    OPENROUTER_API_BASE: 'https://openrouter.ai/api/v1',
}));
vi.mock('../../../react/components/preferences/CustomProviderCard', () => ({
    default: ({ model, onDuplicate, isExpanded }: any) =>
        React.createElement(
            'div',
            { className: 'mock-provider-card', 'data-name': model.name, 'data-expanded': String(isExpanded) },
            React.createElement('button', { onClick: onDuplicate, 'aria-label': `duplicate-${model.name}` }, 'Duplicate'),
        ),
}));

import ApiKeysSection from '../../../react/components/preferences/ApiKeysSection';

let root: Root;
let container: HTMLDivElement;

const render = () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(ApiKeysSection)));
};

const cards = () => Array.from(container.querySelectorAll<HTMLElement>('.mock-provider-card'));
const addProviderButton = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Add Provider')!;
const duplicateButton = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="duplicate-${name}"]`)!;

/** Removes `crypto.randomUUID` from the global, matching a realm that lacks it. */
const stubCryptoWithoutRandomUUID = () => {
    const real = (globalThis as any).crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues?.bind(real) });
};

beforeEach(() => {
    mocks.initialModels = [];
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('ApiKeysSection provider ids without crypto.randomUUID', () => {
    it('adds providers without throwing and tracks each independently', () => {
        stubCryptoWithoutRandomUUID();
        render();

        expect(() => act(() => { addProviderButton().click(); })).not.toThrow();
        expect(cards()).toHaveLength(1);
        expect(cards()[0].dataset.expanded).toBe('true');

        expect(() => act(() => { addProviderButton().click(); })).not.toThrow();
        const afterSecondAdd = cards();
        expect(afterSecondAdd).toHaveLength(2);
        // The newly added provider (prepended) is the only one auto-expanded;
        // if both entries had shared the same generated id, the first would
        // incorrectly show as expanded too.
        expect(afterSecondAdd[0].dataset.expanded).toBe('true');
        expect(afterSecondAdd[1].dataset.expanded).toBe('false');
    });

    it('duplicates a provider without throwing and expands only the copy', () => {
        mocks.initialModels = [
            { name: 'My Provider', snapshot: '', api_base: '', format: 'openai', api_key: '', supports_vision: false },
        ];
        stubCryptoWithoutRandomUUID();
        render();

        expect(cards()).toHaveLength(1);

        expect(() => act(() => { duplicateButton('My Provider').click(); })).not.toThrow();

        const afterDuplicate = cards();
        expect(afterDuplicate).toHaveLength(2);
        expect(afterDuplicate[0].dataset.name).toBe('My Provider');
        expect(afterDuplicate[0].dataset.expanded).toBe('false');
        expect(afterDuplicate[1].dataset.name).toBe('My Provider (copy)');
        expect(afterDuplicate[1].dataset.expanded).toBe('true');
    });
});
