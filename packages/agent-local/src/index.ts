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
export { ToolCallAccumulator } from './llm/toolCallAccumulator';
export type { AccumulatedToolCall } from './llm/toolCallAccumulator';
