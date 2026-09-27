/**
 * "Test Endpoint" for a custom provider in local mode: a single, tool-free
 * turn sent straight to the provider from the plugin, through the same
 * `LlmClient` the local agent loop uses. Unlike the hosted rock-paper-scissors
 * check (`chatService.testCustomProviderRockPaperScissors`), this never goes
 * through Beaver's backend — the api key and endpoint stay on this machine.
 */
import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import { isLoopbackEndpoint, resolveLocalAgentConfig, type SupportedFormat } from '@beaver/agent-local/config/localAgentConfig';
import { clientForFormat } from '@beaver/agent-local/llm/clientForFormat';
import type { LlmClient } from '@beaver/agent-local/llm/types';
import { LlmRequestError } from '@beaver/agent-local/llm/types';

export interface LocalProviderTestResult {
    ok: boolean;
    message: string;
    /**
     * True when `ok: false` came from the caller's own `externalSignal`
     * (unmount, or a newer test superseding this one) rather than a real
     * provider failure or timeout. Callers should discard these silently
     * instead of showing them as an error.
     */
    cancelled?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const TEST_PROMPT = 'Reply with one short sentence to confirm you received this message.';

/**
 * Run one connectivity check against a local/custom provider endpoint.
 *
 * `externalSignal` lets the caller cancel the request (component unmount, or
 * a newer test starting) independently of the timeout; an abort from that
 * signal is reported as `cancelled`, not as a timeout or provider error.
 */
export async function testLocalProvider(
    model: CustomChatModel,
    client: LlmClient,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    externalSignal?: AbortSignal,
): Promise<LocalProviderTestResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', onExternalAbort);
        }
    }

    try {
        const result = await client.streamTurn(
            {
                model,
                messages: [{ role: 'user', content: TEST_PROMPT }],
                tools: [],
            },
            {
                onTextDelta: () => {},
                onThinkingDelta: () => {},
            },
            controller.signal,
        );
        const text = result.text.trim();
        return { ok: true, message: text || 'The endpoint responded.' };
    } catch (error) {
        if (error instanceof LlmRequestError && error.kind === 'cancelled') {
            if (!timedOut) {
                return { ok: false, cancelled: true, message: 'The test was cancelled.' };
            }
            return {
                ok: false,
                message: 'The request timed out. Check the endpoint URL and that the server is running.',
            };
        }
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'The provider test failed.',
        };
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
}

/**
 * Test a provider exactly as a chat would use it: the model goes through
 * `resolveLocalAgentConfig` first, so the test sees the same endpoint
 * defaults, key rule and format as a run, and a configuration a run would
 * refuse is reported without contacting the provider.
 */
export async function testLocalEndpoint(
    model: CustomChatModel,
    externalSignal?: AbortSignal,
    options: { clientFor?: (format: SupportedFormat) => LlmClient; timeoutMs?: number } = {},
): Promise<LocalProviderTestResult> {
    const resolved = resolveLocalAgentConfig({ model, maxRounds: null });
    if (!resolved.ok) return { ok: false, message: resolved.message };
    const format = (resolved.config.model.format ?? 'openai') as SupportedFormat;
    const client = (options.clientFor ?? clientForFormat)(format);
    return testLocalProvider(resolved.config.model, client, options.timeoutMs, externalSignal);
}

/**
 * A warning for an endpoint that sends the API key and library text
 * unencrypted across a network, or null. Plain HTTP to this machine is fine.
 */
export function plainHttpWarning(apiBase: string | undefined): string | null {
    const value = (apiBase ?? '').trim();
    let protocol: string;
    try {
        protocol = new URL(value).protocol;
    } catch {
        return null;
    }
    if (protocol !== 'http:' || isLoopbackEndpoint(value)) return null;
    return 'This endpoint uses plain http, so your API key and library text travel unencrypted. Use https unless the server is on a network you trust.';
}
