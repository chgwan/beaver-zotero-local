/** Pick the client that speaks a resolved model's wire format. */

import { createAnthropicClient } from './anthropicClient';
import { createOpenAiClient } from './openAiClient';
import { createOpenAiResponsesClient } from './openAiResponsesClient';
import { supportsHostedWebSearch } from './webSearchCapability';
import type { CustomChatModel } from '@beaver/agent-core/types/customChatModel';
import type { SupportedFormat } from '../config/localAgentConfig';
import type { LlmClient, LlmWebSearchOptions } from './types';

export function clientForFormat(format: SupportedFormat): LlmClient {
    return format === 'anthropic' ? createAnthropicClient() : createOpenAiClient();
}

/**
 * Pick the client for one run.
 *
 * OpenAI's hosted web search exists only in its Responses API, so a run on
 * api.openai.com that asks for web search uses the Responses client. Every
 * other run uses the client for the model's format.
 */
export function clientForRun(model: CustomChatModel, webSearch?: LlmWebSearchOptions | null): LlmClient {
    if (webSearch?.enabled && supportsHostedWebSearch(model) === 'openai-responses') {
        return createOpenAiResponsesClient();
    }
    return clientForFormat(model.format === 'anthropic' ? 'anthropic' : 'openai');
}
