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
