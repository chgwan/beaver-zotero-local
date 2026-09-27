/**
 * Public surface of the in-plugin agent. A host imports from this barrel; the
 * package's own modules import each other by relative path.
 */
export { LOCAL_AGENT_PACKAGE_VERSION } from './version';
export {
    resolveLocalAgentConfig,
    DEFAULT_MAX_ROUNDS,
    SUPPORTED_FORMATS,
} from './config/localAgentConfig';
export type {
    LocalAgentConfig,
    LocalAgentConfigInput,
    LocalConfigResult,
    LocalConfigError,
    SupportedFormat,
} from './config/localAgentConfig';
export { buildToolCatalog, READ_ONLY_TOOLS } from './tools/toolCatalog';
export type {
    AgentDataProviderLike,
    JsonSchema,
    LocalToolCatalog,
    LocalToolDefinition,
    ToolArgs,
    ToolCatalogOptions,
    ToolExecutionResult,
    ToolRequest,
} from './tools/toolCatalog';
export { readSseEvents } from './llm/sseReader';
export type { SseEvent } from './llm/sseReader';
export { ToolCallAccumulator, wireArguments } from './llm/toolCallAccumulator';
export type { AccumulatedToolCall } from './llm/toolCallAccumulator';
export { createOpenAiClient } from './llm/openAiClient';
export { createAnthropicClient, ANTHROPIC_VERSION, ANTHROPIC_DEFAULT_MAX_TOKENS } from './llm/anthropicClient';
export { clientForFormat } from './llm/clientForFormat';
export { LlmRequestError, classifyHttpStatus, providerErrorMessage, joinEndpoint } from './llm/types';
export type {
    LlmClient,
    LlmMessage,
    LlmStreamHandlers,
    LlmFinishReason,
    LlmTurnResult,
    LlmTurnRequest,
    LlmErrorKind,
    LlmUsage,
} from './llm/types';
export { FrameEmitter } from './run/frameEmitter';
export type {
    FrameEmitterOptions,
    FrameEmitterFailure,
    RoundFrames,
    SealedToolReturn,
} from './run/frameEmitter';
export { runLocalAgentLoop } from './run/localAgentLoop';
export type { LocalAgentLoopOptions } from './run/localAgentLoop';
export { buildRunHistory, estimateTokens, HISTORY_CONTEXT_SHARE } from './run/runHistory';
export type { RunHistoryOptions } from './run/runHistory';
export { buildSystemPrompt } from './run/systemPrompt';
export type { SystemPromptOptions } from './run/systemPrompt';
export { buildToolReturnMetadata } from './run/toolReturnMetadata';
export type {
    ToolReturnMetadata,
    ItemSearchSummary,
    AnnotationListSummary,
} from './run/toolReturnMetadata';
