/**
 * "Test Endpoint" for a custom provider in local mode: a single, tool-free
 * turn sent straight to the provider from the plugin, through the same
 * `LlmClient` the local agent loop uses. Unlike the hosted rock-paper-scissors
 * check (`chatService.testCustomProviderRockPaperScissors`), this never goes
 * through Beaver's backend — the api key and endpoint stay on this machine.
 */
import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import type { LlmClient } from '@beaver/agent-local/llm/types';
import { LlmRequestError } from '@beaver/agent-local/llm/types';

export interface LocalProviderTestResult {
    ok: boolean;
    message: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const TEST_PROMPT = 'Reply with one short sentence to confirm you received this message.';

/** Run one connectivity check against a local/custom provider endpoint. */
export async function testLocalProvider(
    model: CustomChatModel,
    client: LlmClient,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LocalProviderTestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    }
}
