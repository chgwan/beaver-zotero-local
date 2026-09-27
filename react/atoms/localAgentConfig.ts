/**
 * The settings a local-mode run is built from, gathered from the model
 * selection and the preferences.
 */

import { atom } from 'jotai';
import {
    resolveLocalAgentConfig,
    type LocalAgentConfigInput,
    type LocalConfigResult,
} from '@beaver/agent-local/config/localAgentConfig';
import {
    isHostedWebSearchAvailable,
    supportsHostedWebSearch,
    type HostedWebSearchKind,
} from '@beaver/agent-local/llm/webSearchCapability';
import { getPref } from '../../src/utils/prefs';
import { selectedModelAtom } from './models';
import { preferencesRevisionAtom } from './preferences';

/**
 * Everything `resolveLocalAgentConfig` needs: the selected model when it is a
 * custom one (local mode never runs a Beaver-hosted model), and the user's
 * round cap when it is a positive number.
 */
export const localAgentConfigInputAtom = atom<LocalAgentConfigInput>((get) => {
    get(preferencesRevisionAtom);
    const selected = get(selectedModelAtom);
    const maxRounds = Number(getPref('localMaxRounds'));
    return {
        model: selected?.is_custom ? selected.custom_model ?? null : null,
        maxRounds: maxRounds > 0 ? maxRounds : null,
    };
});

/** The resolved local-agent config, or the reason there isn't one. */
export const localModeStatusAtom = atom<LocalConfigResult>((get) =>
    resolveLocalAgentConfig(get(localAgentConfigInputAtom))
);

/** Search settings for a local run. */
export interface LocalSearchConfig {
    /** Offer `scholarly_search` (OpenAlex + Semantic Scholar). */
    scholarlySearch: boolean;
    openAlexApiKey: string;
    semanticScholarApiKey: string;
    /** Master switch for the provider's hosted web search. */
    webSearch: boolean;
    /** Most searches the provider may run in one request. */
    webSearchMaxUses: number;
}

/** Searches per provider request when the preference is unset or invalid. */
export const DEFAULT_LOCAL_WEB_SEARCH_MAX_USES = 3;

/**
 * The search preferences, re-read whenever preferences change. A run reads
 * them when it starts, so a change applies from the next run.
 */
export const localSearchConfigAtom = atom<LocalSearchConfig>((get) => {
    get(preferencesRevisionAtom);
    const maxUses = Number(getPref('localWebSearchMaxUses'));
    return {
        scholarlySearch: getPref('localScholarlySearch') !== false,
        openAlexApiKey: String(getPref('openAlexApiKey') ?? ''),
        semanticScholarApiKey: String(getPref('semanticScholarApiKey') ?? ''),
        webSearch: getPref('localWebSearch') === true,
        webSearchMaxUses: Number.isInteger(maxUses) && maxUses > 0 ? maxUses : DEFAULT_LOCAL_WEB_SEARCH_MAX_USES,
    };
});

/**
 * Whether the composer may request hosted web search for a local run, and if
 * not, why: the preference is off, no runnable model is selected, or the
 * selected provider has no hosted search this plugin can use.
 */
export interface LocalWebSearchStatus {
    available: boolean;
    reason: 'off' | 'no_model' | 'unsupported' | null;
    kind: HostedWebSearchKind | null;
}

export const localWebSearchStatusAtom = atom<LocalWebSearchStatus>((get) => {
    const status = get(localModeStatusAtom);
    const model = status.ok ? status.config.model : null;
    const kind = supportsHostedWebSearch(model);
    if (!get(localSearchConfigAtom).webSearch) return { available: false, reason: 'off', kind };
    if (!model) return { available: false, reason: 'no_model', kind };
    if (!isHostedWebSearchAvailable(model)) return { available: false, reason: 'unsupported', kind };
    return { available: true, reason: null, kind };
});
