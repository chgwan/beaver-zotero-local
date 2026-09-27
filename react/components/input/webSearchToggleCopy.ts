/**
 * Copy for the composer's web search toggle.
 *
 * In cloud mode the toggle requests Beaver's hosted search. In local mode it
 * requests the model provider's own hosted search, which the provider may
 * bill per search, and a disabled toggle says why.
 */

import type { LocalWebSearchStatus } from '../../atoms/localAgentConfig';

export interface WebSearchToggleCopyInput {
    localMode: boolean;
    allowed: boolean;
    enabled: boolean;
    /** Why local web search is unavailable; ignored in cloud mode. */
    localReason: LocalWebSearchStatus['reason'];
}

export interface WebSearchToggleCopy {
    /** Tooltip heading. */
    title: string;
    /** Tooltip detail line. */
    detail: string;
    /** Screen-reader description of the toggle's state. */
    description: string;
}

const LOCAL_HOSTED_DETAIL = "Search the web with your provider's hosted search. Your provider may bill per search.";

const localUnavailable = (reason: LocalWebSearchStatus['reason']): { title: string; detail: string } => {
    if (reason === 'off') {
        return {
            title: 'Web search is turned off',
            detail: 'Turn on web search for local mode in Settings. Your provider may bill per search.',
        };
    }
    if (reason === 'unsupported') {
        return {
            title: 'Web search is not available for this provider',
            detail: 'Hosted web search works with Anthropic and OpenRouter models.',
        };
    }
    return {
        title: 'Web search is unavailable',
        detail: 'Choose a model that is set up for local mode.',
    };
};

export function webSearchToggleCopy({ localMode, allowed, enabled, localReason }: WebSearchToggleCopyInput): WebSearchToggleCopy {
    if (!allowed) {
        if (localMode) {
            const { title, detail } = localUnavailable(localReason);
            return { title, detail, description: `Web search is unavailable. ${detail}` };
        }
        return {
            title: 'Web search requires Beaver credits',
            detail: 'Use a Beaver model, or enable Plus Tools in Settings → API Keys',
            description:
                'Web search is unavailable. It requires Beaver credits. Use a Beaver model, or enable Plus Tools in Settings, API Keys.',
        };
    }
    const description = enabled ? 'Web search is enabled.' : 'Web search is disabled.';
    if (enabled) {
        return {
            title: 'Stop requesting web search',
            detail: localMode ? LOCAL_HOSTED_DETAIL : 'May still search the web when helpful',
            description,
        };
    }
    return {
        title: 'Request web search',
        detail: localMode ? LOCAL_HOSTED_DETAIL : 'May search the web either way',
        description,
    };
}
