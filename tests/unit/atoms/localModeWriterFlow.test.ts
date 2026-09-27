/**
 * Local-mode conversations through the real send, stop and retry entry points,
 * with thread presence on (as in the plugin) and the real local agent service.
 * Only the agent loop itself is scripted.
 *
 * The backend access probe is registered as "blocked" and counted: any path
 * that even tries to reach a Beaver server (thread admission, truncation, the
 * socket) consults it, so a zero count proves none did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loopCalls, script, backendProbe } = vi.hoisted(() => ({
    loopCalls: [] as any[],
    script: [] as Array<'answer' | 'fail' | 'hang'>,
    backendProbe: { calls: 0 },
}));

vi.mock('@beaver/agent-local/run/localAgentLoop', () => ({
    runLocalAgentLoop: async (options: any) => {
        loopCalls.push(options);
        const step = script.shift() ?? 'answer';
        const { callbacks, runId } = options;
        callbacks.onReady({});
        if (options.threadId === null) callbacks.onThread('local-thread');
        if (step === 'hang') {
            await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve()));
            return;
        }
        if (step === 'fail') {
            callbacks.onError({
                event: 'error', type: 'local_provider_error', message: 'Provider down',
                run_id: runId, is_retryable: false,
            });
            return;
        }
        await callbacks.onPart({
            event: 'part', run_id: runId, message_index: 0, part_index: 0,
            part: { part_kind: 'text', content: `answer to: ${options.userPrompt.content}` },
        });
        await callbacks.onRunComplete({ event: 'run_complete', run_id: runId, usage: null, cost: null });
        await callbacks.onDone();
    },
}));
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
import { store } from '../../../react/store';
import {
    clearClientShutDownLatch,
    closeWSConnectionAtom,
    isWSChatPendingAtom,
    regenerateFromRunAtom,
    resumeFromRunAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { selectedModelAtom } from '../../../react/atoms/models';
import { sessionAtom } from '../../../react/atoms/auth';
import { attachThreadAdmission, setAdmission, threadAdmissionAtom, threadConflictAtom } from '../../../react/runtime/threadAdmission';
import { threadPresenceAtom, viewedHistoryRevisionAtom } from '../../../react/runtime/threadProjection';
import { initializeWindowRuntime } from '../../../react/runtime/windowRuntime';
import { releaseWriter } from '../../../react/runtime/threadWriter';
import { ThreadPresence } from '../../../src/services/threads/threadPresence';

initializeWindowRuntime({ id: 'a', status: 'ready', hostWindow: {} } as any);
setBackendAccessPolicy(() => {
    backendProbe.calls++;
    return false;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    loopCalls.length = 0;
    script.length = 0;
    backendProbe.calls = 0;
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
        custom_model: {
            name: 'Mine', snapshot: 'llama', api_key: 'k',
            api_base: 'http://localhost:11434/v1', format: 'openai',
        },
    } as any);
});

function expectNoBackendAndNoPopups() {
    expect(backendProbe.calls).toBe(0);
    expect(store.get(popupMessagesAtom)).toEqual([]);
}

describe('a local thread', () => {
    it('sends a follow-up in the same thread with the first exchange as history', async () => {
        await store.set(sendWSMessageAtom, 'first');
        await flush();
        expect(store.get(currentThreadIdAtom)).toBe('local-thread');
        expect(store.get(activeRunAtom)).toBeNull();

        await store.set(sendWSMessageAtom, 'second');
        await flush();

        expect(loopCalls).toHaveLength(2);
        expect(loopCalls[1].threadId).toBe('local-thread');
        expect(loopCalls[1].userPrompt.content).toBe('second');
        expect(loopCalls[1].history).toEqual([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer to: first' },
        ]);
        expect(store.get(threadRunsAtom).map((run) => run.status)).toEqual(['completed', 'completed']);
        expectNoBackendAndNoPopups();
    });

    it('sends again after Stop', async () => {
        await store.set(sendWSMessageAtom, 'first');
        await flush();
        script.push('hang');
        await store.set(sendWSMessageAtom, 'long one');
        expect(store.get(activeRunAtom)?.status).toBe('in_progress');

        await store.set(closeWSConnectionAtom);
        await flush();
        expect(store.get(isWSChatPendingAtom)).toBe(false);

        await store.set(sendWSMessageAtom, 'third');
        await flush();

        expect(loopCalls).toHaveLength(3);
        expect(loopCalls[1].signal.aborted).toBe(true);
        expect(loopCalls[2].threadId).toBe('local-thread');
        expect(loopCalls[2].history.filter((m: any) => m.role === 'user').map((m: any) => m.content))
            .toEqual(['first', 'long one']);
        expectNoBackendAndNoPopups();
    });

    it('retries a failed run in memory, without the failed run in the history', async () => {
        await store.set(sendWSMessageAtom, 'first');
        await flush();
        script.push('fail');
        await store.set(sendWSMessageAtom, 'second');
        await flush();
        const failed = store.get(activeRunAtom) ?? store.get(threadRunsAtom).at(-1)!;
        expect(failed.status).toBe('error');

        await store.set(regenerateFromRunAtom, { runId: failed.id });
        await flush();

        expect(loopCalls).toHaveLength(3);
        expect(loopCalls[2].threadId).toBe('local-thread');
        expect(loopCalls[2].userPrompt.content).toBe('second');
        expect(loopCalls[2].history).toEqual([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer to: first' },
        ]);
        const runs = store.get(threadRunsAtom);
        expect(runs.map((run) => run.id)).not.toContain(failed.id);
        expect(runs.map((run) => run.status)).toEqual(['completed', 'completed']);
        expectNoBackendAndNoPopups();
    });

    it('regenerates a completed answer in memory', async () => {
        await store.set(sendWSMessageAtom, 'first');
        await flush();
        await store.set(sendWSMessageAtom, 'second');
        await flush();
        const [firstRun, secondRun] = store.get(threadRunsAtom);

        await store.set(regenerateFromRunAtom, { runId: secondRun.id });
        await flush();

        expect(loopCalls).toHaveLength(3);
        expect(loopCalls[2].history.map((m: any) => m.content)).toEqual(['first', 'answer to: first']);
        expect(store.get(threadRunsAtom).map((run) => run.id)).toEqual([firstRun.id, expect.any(String)]);
        expect(store.get(threadRunsAtom)[1].id).not.toBe(secondRun.id);
        expectNoBackendAndNoPopups();
    });

    it('does not resume, since there is no server run to continue', async () => {
        script.push('fail');
        await store.set(sendWSMessageAtom, 'first');
        await flush();
        const failed = store.get(activeRunAtom) ?? store.get(threadRunsAtom).at(-1)!;

        await store.set(resumeFromRunAtom, failed.id);
        await flush();

        expect(loopCalls).toHaveLength(1);
        expectNoBackendAndNoPopups();
    });
});

describe('the admission poller in local mode', () => {
    it('never schedules a server reconcile, even for a thread marked busy', () => {
        const setTimeoutSpy = vi.fn();
        (Zotero as any).Beaver.runtime = { addWindowCleanup: vi.fn() };
        attachThreadAdmission({ id: 'poller', status: 'ready', hostWindow: { setTimeout: setTimeoutSpy, clearTimeout: vi.fn() } } as any);
        store.set(currentThreadIdAtom, 'local-thread');

        setAdmission(store.set, 'local-thread', null, 'unknown');
        setAdmission(store.set, 'local-thread', null, 'active');

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(backendProbe.calls).toBe(0);
    });
});
