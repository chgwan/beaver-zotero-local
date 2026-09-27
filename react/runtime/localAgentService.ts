/**
 * Runs an agent turn in-process against the user's own model provider.
 *
 * Implements the part of `AgentService` the run atoms use (`connect`,
 * `cancel`, `close`, `isConnected`) with the same timing, so every
 * `WSCallbacks` consumer is unaware of which one it is talking to:
 *
 *  - `connect` resolves once `ready` has been emitted, not when the run ends.
 *    The run continues in the background and reports through the callbacks.
 *  - `connect` never rejects. A thrown error reads as a connection failure to
 *    the retry loop and is filed as a transport diagnostic; a missing API key
 *    is neither, so every failure is reported through `onError`.
 *  - `cancel` and `close` stop the run and report a clean close without
 *    connection evidence, as the client's own closes do on the socket. After
 *    that, nothing more from the stopped run reaches its callbacks.
 *
 * Each renderer bundle owns one instance, matching the cloud service's one
 * socket per window.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AgentRunRequest,
    ExtractSchemaVersionsWire,
    WSCallbacks,
    WSErrorEvent,
    ZoteroInstanceWire,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { BeaverAgentPrompt } from '@beaver/agent-core/agents/types';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { ConnectRecoveryAuthFields } from '@beaver/agent-core/transport/connectionFailure';
import { resolveDefaultAgentDataProvider } from '@beaver/agent-core/transport/agentDataDispatch';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { logger } from '@beaver/agent-core/platform/logger';
import { resolveLocalAgentConfig } from '@beaver/agent-local/config/localAgentConfig';
import { clientForFormat } from '@beaver/agent-local/llm/clientForFormat';
import { runLocalAgentLoop } from '@beaver/agent-local/run/localAgentLoop';
import { buildRunHistory } from '@beaver/agent-local/run/runHistory';
import { scopePromptToLibraries } from '@beaver/agent-local/run/userPrompt';
import { buildToolCatalog } from '@beaver/agent-local/tools/toolCatalog';
import { getSearchableLibraryIds } from '../../src/services/agentDataProvider/utils';
import { readAttachmentEntry } from '../../src/services/agentDataProvider/handleReadAttachmentRequest';
import { localAgentConfigInputAtom } from '../atoms/localAgentConfig';
import { isLocalMode } from '../atoms/localMode';
import { store } from '../store';

interface ActiveLocalRun {
    controller: AbortController;
    /** The caller's callbacks, unwrapped, for the close this service reports itself. */
    callbacks: WSCallbacks;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function localError(runId: string, type: string, message: string): WSErrorEvent {
    return { event: 'error', type, message, run_id: runId, is_retryable: false };
}

export class LocalAgentService {
    private active: ActiveLocalRun | null = null;

    /** Whether a run is in flight. */
    isConnected(): boolean {
        return this.active !== null;
    }

    async connect(
        request: AgentRunRequest,
        callbacks: WSCallbacks,
        _frontendVersion?: string,
        _clientType?: string,
        _clientFeatures?: string[],
        _zoteroInstance?: ZoteroInstanceWire,
        _connectRecovery?: ConnectRecoveryAuthFields,
        _extractSchemaVersions?: ExtractSchemaVersionsWire,
    ): Promise<void> {
        // One run at a time, like the single socket. The superseded run's
        // caller has moved on, so it is not told.
        this.close(1000, 'Client closing', { notifyClose: false });

        const resolved = resolveLocalAgentConfig(store.get(localAgentConfigInputAtom));
        if (!resolved.ok) {
            callbacks.onError(localError(request.run_id, 'local_config_error', resolved.message));
            return;
        }
        const config = resolved.config;

        let catalog: ReturnType<typeof buildToolCatalog>;
        let history: ReturnType<typeof buildRunHistory>;
        let userPrompt: BeaverAgentPrompt;
        try {
            // One scope snapshot for the whole run: the tools, this prompt and
            // the replayed history all see the same searchable libraries, and
            // nothing from an excluded library reaches the model.
            const searchableLibraryIds = getSearchableLibraryIds();
            const searchable = new Set(searchableLibraryIds);
            const isLibrarySearchable = (libraryId: number) => searchable.has(libraryId);
            userPrompt = scopePromptToLibraries(request.user_prompt, isLibrarySearchable);
            catalog = buildToolCatalog({
                // The shared map's document entry answers in the backend wire
                // format; the local reader returns a bounded page window instead.
                provider: {
                    ...resolveDefaultAgentDataProvider({}),
                    read_attachment_request: readAttachmentEntry,
                },
                searchableLibraryIds,
            });
            history = buildRunHistory(store.get(threadRunsAtom), request.thread_id ?? null, {
                contextWindow: config.model.context_window,
                isLibrarySearchable,
            });
        } catch (error) {
            callbacks.onError(localError(request.run_id, 'local_agent_error', describeError(error)));
            return;
        }

        const run: ActiveLocalRun = { controller: new AbortController(), callbacks };
        this.active = run;

        let markReady!: () => void;
        const ready = new Promise<void>((resolve) => { markReady = resolve; });
        const forwarded = this.forwardWhileActive(run, callbacks, markReady);

        callbacks.onOpen?.();
        const loop = runLocalAgentLoop({
            runId: request.run_id,
            threadId: request.thread_id ?? null,
            newThreadId: () => uuidv4(),
            userPrompt,
            history,
            config,
            client: clientForFormat(config.model.format ?? 'openai'),
            catalog,
            callbacks: forwarded,
            signal: run.controller.signal,
        });
        void loop
            .catch((error: unknown) => {
                // The loop reports its own failures; this is one it could not,
                // thrown before it started streaming.
                logger(`LocalAgentService: run ${request.run_id} failed: ${describeError(error)}`, 1);
                if (this.active !== run) return;
                callbacks.onError(localError(request.run_id, 'local_agent_error', describeError(error)));
            })
            .finally(() => {
                // A run the caller did not close itself (it ended in an error,
                // or its `done` was not acted on) closes here, as the server
                // closes the socket after a run's last frame.
                if (this.active === run) {
                    this.active = null;
                    callbacks.onClose?.(1000, '', true);
                }
                markReady();
            });

        await ready;
    }

    /** Stop the run the user is watching. */
    async cancel(): Promise<void> {
        const run = this.stop();
        run?.callbacks.onClose?.(1000, 'Canceled', true);
    }

    close(
        code?: number,
        reason?: string,
        options: { notifyClose?: boolean; onlyIfConnectionId?: number } = {},
    ): void {
        const run = this.stop();
        if (run && options.notifyClose !== false) {
            run.callbacks.onClose?.(code ?? 1000, reason ?? '', true);
        }
    }

    private stop(): ActiveLocalRun | null {
        const run = this.active;
        if (!run) return null;
        this.active = null;
        run.controller.abort();
        return run;
    }

    /**
     * The callbacks the loop writes to: forwarded while `run` is the active
     * run and dropped after it was stopped, the way a closed socket delivers
     * nothing more. `onReady` also releases the pending `connect`.
     */
    private forwardWhileActive(run: ActiveLocalRun, callbacks: WSCallbacks, markReady: () => void): WSCallbacks {
        const forwarded: Record<string, unknown> = {};
        for (const [name, callback] of Object.entries(callbacks)) {
            if (typeof callback !== 'function') continue;
            forwarded[name] = (...args: unknown[]) => {
                if (this.active !== run) return undefined;
                try {
                    return (callback as (...callbackArgs: unknown[]) => unknown)(...args);
                } finally {
                    if (name === 'onReady') markReady();
                }
            };
        }
        return forwarded as unknown as WSCallbacks;
    }
}

export const localAgentService = new LocalAgentService();

/** The run-connection surface shared by the cloud and local services. */
export type ActiveAgentService = Pick<LocalAgentService, 'connect' | 'cancel' | 'close' | 'isConnected'>;

/**
 * The service runs go through: the local one in local mode, the cloud socket
 * otherwise. Local mode is fixed for the plugin's lifetime, so every call site
 * resolves to the same service for the whole session.
 */
export function activeAgentService(): ActiveAgentService {
    return isLocalMode() ? localAgentService : agentService;
}
