/**
 * Validation of the user's local-agent settings into something the loop can
 * run, or a specific reason it cannot.
 *
 * Pure: callers pass the preference values they already read, so this module
 * needs no host access and the failure copy is testable directly.
 */

import { OPENROUTER_API_BASE, type CustomChatModel } from '@beaver/agent-core/types/customChatModel';

/** Wire formats the in-plugin loop can speak. */
export const SUPPORTED_FORMATS = ['openai', 'anthropic'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/** Tool-calling rounds allowed in one run before the loop stops. */
export const DEFAULT_MAX_ROUNDS = 20;

export type LocalConfigError =
    | 'no_model'
    | 'no_api_key'
    | 'unsupported_format'
    | 'invalid_endpoint';

export interface LocalAgentConfig {
    /** The selected model, with `format` normalised to a supported value. */
    model: CustomChatModel;
    maxRounds: number;
}

export interface LocalAgentConfigInput {
    model: CustomChatModel | null;
    /** User override for the round cap; null or nonsensical falls back. */
    maxRounds: number | null;
}

export type LocalConfigResult =
    | { ok: true; config: LocalAgentConfig }
    | { ok: false; reason: LocalConfigError; message: string };

const fail = (reason: LocalConfigError, message: string): LocalConfigResult => ({
    ok: false,
    reason,
    message,
});

/**
 * Whether an endpoint is callable from this plugin.
 *
 * Deliberately more permissive than the hosted path's
 * `validateCustomProviderApiBase`, which rejects loopback and private hosts
 * because the Beaver backend makes the request and must not be steered at its
 * own network. Here the request leaves the user's own machine, so a local
 * server is a first-class endpoint and plain HTTP to it is not a downgrade.
 */
const isCallableEndpoint = (apiBase: string): boolean => {
    let url: URL;
    try {
        url = new URL(apiBase);
    } catch {
        return false;
    }
    return url.protocol === 'https:' || url.protocol === 'http:';
};

export function resolveLocalAgentConfig(input: LocalAgentConfigInput): LocalConfigResult {
    const { model } = input;

    if (!model) {
        return fail(
            'no_model',
            'Choose a model in Beaver Preferences → API Keys before starting a chat.'
        );
    }
    if (!model.api_key || model.api_key.trim().length === 0) {
        return fail(
            'no_api_key',
            `Add an API key for “${model.name}” in Beaver Preferences → API Keys.`
        );
    }

    const format = (model.format ?? 'openai') as SupportedFormat;
    if (!SUPPORTED_FORMATS.includes(format)) {
        return fail(
            'unsupported_format',
            `Beaver cannot talk to “${format}” endpoints. Choose the OpenAI or Anthropic format for “${model.name}”.`
        );
    }

    // A native OpenRouter entry (`provider: "openrouter"`) is valid with no
    // `api_base` — `isCustomChatModel` allows it and the hosted path treats
    // OpenRouter's endpoint as the default. Backfill it here so the resolver
    // does not reject an otherwise-complete OpenRouter model.
    const isOpenRouter = model.provider?.toLowerCase() === 'openrouter';
    const rawApiBase = (model.api_base ?? '').trim();
    const apiBase = rawApiBase || (isOpenRouter ? OPENROUTER_API_BASE : '');
    if (!apiBase || !isCallableEndpoint(apiBase)) {
        return fail(
            'invalid_endpoint',
            `“${model.name}” needs an endpoint URL, for example https://api.openai.com/v1.`
        );
    }

    const maxRounds =
        input.maxRounds !== null && Number.isInteger(input.maxRounds) && input.maxRounds > 0
            ? input.maxRounds
            : DEFAULT_MAX_ROUNDS;

    return { ok: true, config: { model: { ...model, format, api_base: apiBase }, maxRounds } };
}
