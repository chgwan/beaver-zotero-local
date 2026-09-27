/** Pick the client that speaks a resolved model's wire format. */

import { createAnthropicClient } from './anthropicClient';
import { createOpenAiClient } from './openAiClient';
import type { SupportedFormat } from '../config/localAgentConfig';
import type { LlmClient } from './types';

export function clientForFormat(format: SupportedFormat): LlmClient {
    return format === 'anthropic' ? createAnthropicClient() : createOpenAiClient();
}
