/**
 * One local-mode conversation turn through every real layer: the send atom,
 * the local agent service, the agent loop, the frame emitter, the OpenAI
 * streaming client and the renderer's run callbacks. Only the network (a
 * stubbed `fetch` replaying a provider's SSE stream) and the tool catalog are
 * stood in for.
 *
 * The provider streams an opening sentence, then a tool call whose arguments
 * arrive in fragments split mid-token, and after the tool result a final
 * answer. The settled run must hold each text exactly once and the tool call
 * with its full arguments, followed by its return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { catalog } = vi.hoisted(() => ({
    catalog: {
        definitions: () => [] as any[],
        execute: null as any,
    },
}));

vi.mock('@beaver/agent-local/tools/toolCatalog', () => ({ buildToolCatalog: () => catalog }));
vi.mock('@beaver/agent-core/transport/agentDataDispatch', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveDefaultAgentDataProvider: () => ({}),
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: () => ({ frontendVersion: 'test', clientType: 'zotero-plugin', clientFeatures: [] }),
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn().mockResolvedValue(undefined) },
}));

import { setBackendAccessPolicy } from '@beaver/agent-core/transport/backendAccessPolicy';
import { getCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { activeRunAtom, currentThreadIdAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { ZOTERO_SEARCH_TOOL } from '@beaver/agent-local/tools/toolSchemas';
import { store } from '../../../react/store';
import {
    clearClientShutDownLatch,
    isWSChatPendingAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { selectedModelAtom } from '../../../react/atoms/models';
import { sessionAtom } from '../../../react/atoms/auth';
import { threadAdmissionAtom, threadConflictAtom } from '../../../react/runtime/threadAdmission';
import { threadPresenceAtom, viewedHistoryRevisionAtom } from '../../../react/runtime/threadProjection';
import { initializeWindowRuntime } from '../../../react/runtime/windowRuntime';
import { releaseWriter } from '../../../react/runtime/threadWriter';
import { ThreadPresence } from '../../../src/services/threads/threadPresence';

initializeWindowRuntime({ id: 'a', status: 'ready', hostWindow: {} } as any);
setBackendAccessPolicy(() => false);

const sse = (frames: unknown[]) => {
    const encoder = new TextEncoder();
    const chunks = [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'];
    let i = 0;
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: {
            getReader: () => ({
                read: async () =>
                    i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
                cancel: async () => {},
                releaseLock: () => {},
            }),
        },
        text: async () => '',
        json: async () => ({}),
    };
};

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
const argsFragment = (args: string, head: Record<string, unknown> = {}) =>
    delta({ tool_calls: [{ index: 0, ...head, function: { ...(head.function as object), arguments: args } }] });

const FIRST_TURN = [
    delta({ content: 'Let me ' }),
    delta({ content: 'search.' }),
    argsFragment('{"que', { id: 'call_1', type: 'function', function: { name: 'zotero_search' } }),
    argsFragment('ry": "mito'),
    argsFragment('chondria", "li'),
    argsFragment('mit": 5}'),
    delta({}, 'tool_calls'),
];
const SECOND_TURN = [delta({ content: 'Found ' }), delta({ content: 'one paper.' }), delta({}, 'stop')];

const searchResult = { type: 'zotero_search', request_id: 'r', items: [{ item_id: 'u-ABCD1234', title: 'Mitochondria' }], total_count: 1 };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    releaseWriter();
    clearClientShutDownLatch();
    const presence = new ThreadPresence();
    presence.reset(getCredentialGeneration());
    (Zotero as any).Beaver = {
        localMode: true,
        libraryScopeInitialized: true,
        searchableLibraryIds: [1],
        presence,
        threads: { invalidateViews: vi.fn(), patchThread: vi.fn() },
    };
    presence.subscribe((snapshot) => store.set(threadPresenceAtom, snapshot));
    store.set(threadAdmissionAtom, null);
    store.set(threadConflictAtom, null);
    store.set(popupMessagesAtom, []);
    store.set(currentThreadIdAtom, null);
    store.set(viewedHistoryRevisionAtom, 0);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(isWSChatPendingAtom, false);
    store.set(wsErrorAtom, null);
    store.set(sessionAtom, null);
    store.set(selectedModelAtom, {
        id: 'custom-1',
        name: 'Mine',
        is_custom: true,
        access_mode: 'custom',
        custom_model: { name: 'Mine', snapshot: 'llama', api_key: 'k', api_base: 'http://localhost:11434/v1', format: 'openai' },
    } as any);

    catalog.definitions = () => [ZOTERO_SEARCH_TOOL];
    catalog.execute = vi.fn(async () => ({ ok: true, content: searchResult, text: JSON.stringify({ items: searchResult.items }) }));
    fetchMock = vi.fn().mockResolvedValueOnce(sse(FIRST_TURN)).mockResolvedValueOnce(sse(SECOND_TURN));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('a local run end to end', () => {
    it('settles with each text once, the full tool arguments, the tool return, and the run in history', async () => {
        await store.set(sendWSMessageAtom, 'find papers on mitochondria');
        for (let i = 0; i < 20 && store.get(activeRunAtom); i++) await flush();

        expect(store.get(wsErrorAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        const runs = store.get(threadRunsAtom);
        expect(runs).toHaveLength(1);
        const [run] = runs;
        expect(run.status).toBe('completed');
        expect(run.user_prompt.content).toBe('find papers on mitochondria');

        const parts = run.model_messages.flatMap((message) => message.parts.map((part) => ({ kind: message.kind, part })));
        const texts = parts.filter(({ part }) => part.part_kind === 'text').map(({ part }) => (part as any).content);
        // R2: every text exactly once, never a delta and never duplicated.
        expect(texts).toEqual(['Let me search.', 'Found one paper.']);

        // R1: the tool call carries the reassembled arguments, not `{}`.
        const calls = parts.filter(({ part }) => part.part_kind === 'tool-call').map(({ part }) => part as any);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ tool_name: 'zotero_search', tool_call_id: 'call_1' });
        const args = typeof calls[0].args === 'string' ? JSON.parse(calls[0].args) : calls[0].args;
        expect(args).toEqual({ query: 'mitochondria', limit: 5 });
        expect(catalog.execute).toHaveBeenCalledWith('zotero_search', { query: 'mitochondria', limit: 5 }, expect.anything());

        // The tool return is attached to its call.
        const returns = parts.filter(({ part }) => part.part_kind === 'tool-return').map(({ part }) => part as any);
        expect(returns).toHaveLength(1);
        expect(returns[0]).toMatchObject({ tool_call_id: 'call_1', tool_name: 'zotero_search', outcome: 'success' });
        expect(returns[0].content).toMatchObject({ total_count: 1 });

        // The second request replays the call and its result to the model.
        const secondRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(secondRequest.messages.at(-2).tool_calls[0].function).toEqual({
            name: 'zotero_search',
            arguments: '{"query": "mitochondria", "limit": 5}',
        });
        expect(secondRequest.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
        expect(store.get(popupMessagesAtom)).toEqual([]);
    });
});
