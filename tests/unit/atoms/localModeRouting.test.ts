/**
 * In local mode, every connection-level call the run atoms make goes to the
 * local service, and a run can start without a Beaver account.
 *
 * Local mode is fixed for the plugin's lifetime, so this whole file runs with
 * it on; the cloud path is covered by the other run-atom suites, which run
 * with it off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { localService, cloudService } = vi.hoisted(() => {
    (globalThis as any).Zotero.Beaver = { localMode: true, searchableLibraryIds: [1], libraryScopeInitialized: true };
    const service = () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        cancel: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn(() => false),
        sendApprovalResponse: vi.fn(() => false),
    });
    return { localService: service(), cloudService: service() };
});

vi.mock('../../../react/runtime/localAgentService', () => ({
    localAgentService: localService,
    activeAgentService: () => ((globalThis as any).Zotero.Beaver?.localMode ? localService : cloudService),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: cloudService,
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({ frontendVersion: '0.0.0-test', clientType: 'zotero-plugin', clientFeatures: [] })),
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/interruptedThreadPrefs', () => ({ saveInterruptedThread: vi.fn() }));

import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { store } from '../../../react/store';
import { sessionAtom, runUserIdAtom } from '../../../react/atoms/auth';
import { chatAccessGateAtom } from '../../../react/atoms/chatAccess';
import {
    clearClientShutDownLatch,
    closeWSConnectionAtom,
    closeWSConnectionForShutdownAtom,
    isWSChatPendingAtom,
    sendWSMessageAtom,
} from '../../../react/atoms/agentRunAtoms';

const run = (overrides: Partial<AgentRun> = {}) =>
    ({ id: 'run-1', thread_id: 'thread-1', status: 'in_progress', ...overrides }) as AgentRun;

beforeEach(() => {
    vi.clearAllMocks();
    clearClientShutDownLatch();
    store.set(sessionAtom, null);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(isWSChatPendingAtom, false);
});

describe('local mode without an account', () => {
    it('opens chat with no session', () => {
        expect(store.get(chatAccessGateAtom)).toBeNull();
    });

    it('stamps runs with the local user id', () => {
        expect(store.get(runUserIdAtom)).toBe('local');
    });

    it('sends through the local service', async () => {
        await store.set(sendWSMessageAtom, 'hello');

        expect(localService.connect).toHaveBeenCalledTimes(1);
        expect(cloudService.connect).not.toHaveBeenCalled();
        const [request] = localService.connect.mock.calls[0];
        expect(request.user_prompt.content).toBe('hello');
        expect(store.get(activeRunAtom)?.user_id).toBe('local');
    });

    it('closes the local service when the run is done', async () => {
        localService.connect.mockImplementationOnce(async (_request: unknown, callbacks: any) => {
            callbacks.onReady({});
            await callbacks.onDone();
        });

        await store.set(sendWSMessageAtom, 'hello');

        expect(localService.close).toHaveBeenCalled();
        expect(cloudService.close).not.toHaveBeenCalled();
    });
});

describe('stopping and shutting down in local mode', () => {
    it('routes Stop to the local service', async () => {
        store.set(activeRunAtom, run());
        store.set(isWSChatPendingAtom, true);

        await store.set(closeWSConnectionAtom);

        expect(localService.cancel).toHaveBeenCalledOnce();
        expect(cloudService.cancel).not.toHaveBeenCalled();
        expect(store.get(activeRunAtom)).toBeNull();
    });

    it('closes the local run on shutdown', () => {
        localService.isConnected.mockReturnValue(true);
        store.set(activeRunAtom, run());

        store.set(closeWSConnectionForShutdownAtom, 'Main window closed');

        expect(localService.close).toHaveBeenCalledExactlyOnceWith(1000, 'Main window closed');
        expect(cloudService.close).not.toHaveBeenCalled();
        expect(cloudService.isConnected).not.toHaveBeenCalled();
    });
});
