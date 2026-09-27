/**
 * The tool surface offered to the model, and the bridge from a tool call to the
 * data-provider handler that implements it.
 *
 * Tools are declarations over the handlers the hosted path already uses, so a
 * tool behaves the same in both modes. The handlers enforce the library scope
 * themselves. This layer owns what they cannot: which tools exist at all, that
 * arguments match the advertised schema before a handler runs, that a run with
 * no searchable library never reaches a handler, and that a failing tool
 * becomes a result the model can react to instead of an exception that ends
 * the run.
 */

import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import { isPreparedJsonMessage } from '@beaver/agent-core/transport/preparedJsonMessage';
import { validateArgs } from './argValidation';
import { READ_ONLY_TOOLS, type LocalToolDefinition, type ToolArgs } from './toolSchemas';

export { READ_ONLY_TOOLS };
export type { LocalToolDefinition, JsonSchema, ToolArgs, ToolRequest, ToolRequestLimits } from './toolSchemas';

/**
 * The structural subset of the host's data-provider map this catalog uses.
 * Declared locally so this package does not depend on the Zotero handler
 * types; the host's `AgentDataProviderMap` satisfies it.
 */
export interface AgentDataProviderLike {
    [requestEvent: string]:
        | {
              handle: (event: any, context?: AgentDataRequestContext) => Promise<unknown>;
              errorResponse?: (event: any, err: unknown) => Record<string, any>;
          }
        | undefined;
}

/**
 * Outcome of one tool call. On success `content` is the handler's response
 * object, which the result views render, and `text` is the same response
 * serialised for the model's transcript. `retryable` tells the model whether
 * calling again with different arguments can succeed.
 */
export type ToolExecutionResult =
    | { ok: true; content: Record<string, unknown>; text: string }
    | { ok: false; error: string; retryable: boolean };

export interface ToolCatalogOptions {
    provider: AgentDataProviderLike;
    /**
     * Libraries the agent may see. The handlers enforce this scope on their
     * own; the catalog uses it only to refuse outright when it is empty.
     */
    searchableLibraryIds: readonly number[];
    /** The model's context window in tokens, when known; bounds what a read returns. */
    contextWindow?: number | null;
}

export interface LocalToolCatalog {
    definitions(): LocalToolDefinition[];
    execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult>;
}

/**
 * Error codes meaning the request touched a library the user keeps from
 * Beaver. Retrying with other arguments cannot lift an exclusion, so the model
 * is told not to.
 */
const ACCESS_DENIED_CODES = new Set(['library_excluded', 'library_not_searchable']);

/** Envelope and diagnostic fields that carry nothing for the model. */
const TRANSCRIPT_OMITTED_FIELDS = new Set(['type', 'request_id', 'timing']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** Drop entries whose value matches `isEmpty`, keeping the object's type. */
const without = <T extends object>(value: T, isEmpty: (v: unknown) => boolean): T =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => !isEmpty(v))) as T;

const isNullish = (v: unknown) => v === undefined || v === null;
const isUndefined = (v: unknown) => v === undefined;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The failure a response reports, or null for a successful response. */
const responseFailure = (response: Record<string, unknown>): ToolExecutionResult | null => {
    const hasError = response.error !== undefined && response.error !== null && response.error !== '';
    if (!hasError && response.success !== false) return null;
    return {
        ok: false,
        retryable: !ACCESS_DENIED_CODES.has(String(response.error_code ?? '')),
        error: hasError ? String(response.error) : 'The request failed without an error message.',
    };
};

export function buildToolCatalog(options: ToolCatalogOptions): LocalToolCatalog {
    const { provider, searchableLibraryIds } = options;
    const limits = { contextWindow: options.contextWindow ?? null };

    // Only offer a tool the host can actually serve; an offered-but-unhandled
    // tool is a guaranteed dead end mid-run.
    const available = READ_ONLY_TOOLS.filter((tool) => !!provider[tool.requestEvent]);
    const byName = new Map(available.map((tool) => [tool.name, tool]));

    return {
        definitions: () => [...available],

        async execute(name, rawArgs, signal): Promise<ToolExecutionResult> {
            const tool = byName.get(name);
            if (!tool) {
                return {
                    ok: false,
                    retryable: true,
                    error: `Unknown tool "${name}". Available tools: ${available.map((t) => t.name).join(', ')}.`,
                };
            }

            // Every library being excluded is a real configuration. Refuse
            // before any handler runs, rather than rely on each one to find
            // nothing.
            if (searchableLibraryIds.length === 0) {
                return {
                    ok: false,
                    retryable: false,
                    error:
                        'No Zotero libraries are available to Beaver. Allow at least one library in ' +
                        'Beaver Preferences to use library tools.',
                };
            }

            // Models commonly send null for an optional argument they mean to
            // omit; the handlers read an absent field the same way.
            const args: ToolArgs = isRecord(rawArgs) ? without(rawArgs, isNullish) : rawArgs;
            const invalid = validateArgs(args, tool.parameters) ?? tool.checkArgs?.(args) ?? null;
            if (invalid) {
                return { ok: false, retryable: true, error: `Invalid arguments for ${name}: ${invalid}` };
            }

            const entry = provider[tool.requestEvent];
            if (!entry) {
                return { ok: false, retryable: false, error: `Tool "${name}" is unavailable.` };
            }

            const request = without(tool.buildRequest(args, crypto.randomUUID(), limits), isUndefined);
            const context: AgentDataRequestContext = {
                signal,
                receivedAt: Date.now(),
                reportPhase: () => {},
            };

            let response: unknown;
            try {
                response = await entry.handle(request, context);
            } catch (error) {
                // Route a rejection through the entry's own fallback, so the
                // model sees the same message the hosted path would send.
                let fallback: Record<string, any> | null = null;
                try {
                    fallback = entry.errorResponse?.(request, error) ?? null;
                } catch {
                    fallback = null;
                }
                const failure = fallback && responseFailure(fallback);
                return failure || { ok: false, retryable: true, error: `Tool "${name}" failed: ${describeError(error)}` };
            }

            // A prepared message is the socket form of a response, spliced
            // for the backend; none of the offered tools produces one.
            if (!isRecord(response) || isPreparedJsonMessage(response)) {
                return { ok: false, retryable: false, error: `Tool "${name}" returned an unreadable response.` };
            }

            const failure = responseFailure(response);
            if (failure) return failure;

            const forModel = Object.fromEntries(
                Object.entries(response).filter(([key]) => !TRANSCRIPT_OMITTED_FIELDS.has(key))
            );
            return { ok: true, content: response, text: JSON.stringify(forModel) };
        },
    };
}
