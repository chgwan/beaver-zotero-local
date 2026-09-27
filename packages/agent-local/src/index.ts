/**
 * Public surface of the in-plugin agent. A host imports from this barrel; the
 * package's own modules import each other by relative path.
 */
export { LOCAL_AGENT_PACKAGE_VERSION } from './version';
export {
    resolveLocalAgentConfig,
    isLoopbackEndpoint,
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
    NativeTool,
    ToolArgs,
    ToolCatalogOptions,
    ToolExecutionResult,
    ToolRequest,
    ToolRequestLimits,
    ToolSpec,
} from './tools/toolCatalog';
export { readSseEvents } from './llm/sseReader';
export type { SseEvent } from './llm/sseReader';
export { ToolCallAccumulator, wireArguments } from './llm/toolCallAccumulator';
export type { AccumulatedToolCall } from './llm/toolCallAccumulator';
export { createOpenAiClient } from './llm/openAiClient';
export {
    createAnthropicClient,
    ANTHROPIC_VERSION,
    ANTHROPIC_DEFAULT_MAX_TOKENS,
    ANTHROPIC_WEB_SEARCH_TOOL,
} from './llm/anthropicClient';
export {
    createOpenAiResponsesClient,
    buildResponsesInput,
    OPENAI_WEB_SEARCH_TOOL,
} from './llm/openAiResponsesClient';
export { clientForFormat, clientForRun } from './llm/clientForFormat';
export { supportsHostedWebSearch, isHostedWebSearchAvailable } from './llm/webSearchCapability';
export type { HostedWebSearchKind } from './llm/webSearchCapability';
export {
    LlmRequestError,
    addCitation,
    classifyHttpStatus,
    joinEndpoint,
    namesWebSearchTool,
    providerErrorMessage,
    webSearchUnsupportedError,
} from './llm/types';
export type {
    LlmCitation,
    LlmClient,
    LlmMessage,
    LlmStreamHandlers,
    LlmFinishReason,
    LlmTurnResult,
    LlmTurnRequest,
    LlmErrorKind,
    LlmUsage,
    LlmWebSearchOptions,
} from './llm/types';
export { FrameEmitter } from './run/frameEmitter';
export type {
    FrameEmitterOptions,
    FrameEmitterFailure,
    RoundFrames,
    SealedToolReturn,
} from './run/frameEmitter';
export { runLocalAgentLoop, formatSources, MAX_PAUSE_CONTINUATIONS } from './run/localAgentLoop';
export type { LocalAgentLoopOptions } from './run/localAgentLoop';
export { buildRunHistory, estimateTokens, HISTORY_CONTEXT_SHARE } from './run/runHistory';
export {
    CHARS_PER_TOKEN,
    DEFAULT_CONTEXT_WINDOW,
    ELIDED_TOOL_RESULT,
    MIN_TRANSCRIPT_BUDGET,
    TRANSCRIPT_CONTEXT_SHARE,
    elideToolResults,
    fitTranscript,
    tokensForChars,
    transcriptBudget,
} from './run/contextBudget';
export type { RunHistoryOptions } from './run/runHistory';
export { buildSystemPrompt } from './run/systemPrompt';
export type { SystemPromptOptions } from './run/systemPrompt';
export { buildToolReturnMetadata } from './run/toolReturnMetadata';
export {
    renderUserPrompt,
    scopePromptToLibraries,
    PROMPT_EXCERPT_MAX_CHARS,
    PROMPT_SELECTION_MAX_ITEMS,
} from './run/userPrompt';
export type {
    ToolReturnMetadata,
    ItemSearchSummary,
    AnnotationListSummary,
} from './run/toolReturnMetadata';
export { fetchJson, HostGate, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS } from './search/httpJson';
export type { HttpJsonOptions, HttpJsonResult, HostGateDeps } from './search/httpJson';
export { normalizeDoi } from './search/types';
export type { ScholarlyResult, ScholarlySearchQuery, ScholarlySource, SourceOutcome } from './search/types';
export { createOpenAlexSource, OPENALEX_MIN_INTERVAL_MS, openAlexGate } from './search/openAlex';
export {
    createSemanticScholarSource,
    SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
    semanticScholarGate,
} from './search/semanticScholar';
export { runScholarlySearch, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from './search/scholarlySearch';
export type { ScholarlySearchOptions, ScholarlySearchOutcome } from './search/scholarlySearch';
export { createScholarlySearchTool, SCHOLARLY_SEARCH_SPEC } from './search/scholarlySearchTool';
