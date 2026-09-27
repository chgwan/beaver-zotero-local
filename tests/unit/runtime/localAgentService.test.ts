/**
 * The local agent service: the in-process stand-in for the cloud socket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    runLoopMock,
    getSearchableLibraryIdsMock,
    resolveProviderMock,
    buildToolCatalogMock,
    cloudService,
} = vi.hoisted(() => ({
    runLoopMock: vi.fn(),
    getSearchableLibraryIdsMock: vi.fn(() => [1, 2]),
    resolveProviderMock: vi.fn(() => ({ provider: true })),
    buildToolCatalogMock: vi.fn((options: unknown) => ({ catalog: options })),
    cloudService: { connect: vi.fn(), close: vi.fn(), cancel: vi.fn(), isConnected: vi.fn() },
}));

vi.mock('@beaver/agent-local/run/localAgentLoop', () => ({ runLocalAgentLoop: runLoopMock }));
vi.mock('@beaver/agent-local/tools/toolCatalog', () => ({ buildToolCatalog: buildToolCatalogMock }));
vi.mock('@beaver/agent-core/transport/agentDataDispatch', () => ({
    resolveDefaultAgentDataProvider: resolveProviderMock,
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: getSearchableLibraryIdsMock,
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({ agentService: cloudService }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/atoms/localAgentConfig', async () => {
    const { atom } = await vi.importActual<typeof import('jotai')>('jotai');
    return { localAgentConfigInputAtom: atom<any>({ model: null, maxRounds: null }) };
});

import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { AgentRunRequest, WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import { localAgentConfigInputAtom } from '../../../react/atoms/localAgentConfig';
import { store } from '../../../react/store';
import {
    activeAgentService,
    LocalAgentService,
    localAgentService,
} from '../../../react/runtime/localAgentService';

const MODEL = {
    name: 'Local GPT',
    snapshot: 'gpt-4.1',
    api_key: 'sk-test',
    api_base: 'https://api.example.com/v1',
    format: 'openai' as const,
    context_window: 1000,
};

function callbacks(): WSCallbacks & Record<string, ReturnType<typeof vi.fn>> {
    return {
        onReady: vi.fn(),
        onOpen: vi.fn(),
        onThread: vi.fn(),
        onPart: vi.fn(),
        onToolReturn: vi.fn(),
        onToolCallProgress: vi.fn(),
        onToolCallArgsStream: vi.fn(),
        onRunComplete: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        onWarning: vi.fn(),
        onClose: vi.fn(),
    } as any;
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
    return {
        type: 'chat',
        run_id: 'run-1',
        thread_id: 'thread-1',
        user_prompt: { content: 'What is in my library?' },
        ...overrides,
    } as AgentRunRequest;
}

/** A loop that emits ready and then waits until released or aborted. */
function pendingLoop() {
    let release!: () => void;
    const finished = new Promise<void>((resolve) => { release = resolve; });
    runLoopMock.mockImplementation(async (options: any) => {
        options.callbacks.onReady({});
        await Promise.race([
            finished,
            new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
        ]);
    });
    return { release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero.Beaver = { localMode: true };
    store.set(localAgentConfigInputAtom, { model: MODEL, maxRounds: null });
    store.set(threadRunsAtom, []);
    getSearchableLibraryIdsMock.mockReturnValue([1, 2]);
});

describe('LocalAgentService.connect', () => {
    it('builds a catalog over the plugin-realm scope and starts the loop once', async () => {
        pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();

        await service.connect(request(), cb);

        expect(resolveProviderMock).toHaveBeenCalledTimes(1);
        expect(buildToolCatalogMock).toHaveBeenCalledWith({
            provider: { provider: true },
            searchableLibraryIds: [1, 2],
        });
        expect(runLoopMock).toHaveBeenCalledTimes(1);
        const options = runLoopMock.mock.calls[0][0];
        expect(options.runId).toBe('run-1');
        expect(options.threadId).toBe('thread-1');
        expect(options.userPrompt).toEqual({ content: 'What is in my library?' });
        expect(options.config.model.snapshot).toBe('gpt-4.1');
        expect(typeof options.newThreadId()).toBe('string');
        expect(cb.onOpen).toHaveBeenCalledTimes(1);
        expect(cb.onReady).toHaveBeenCalledTimes(1);
        service.close(1000, 'test', { notifyClose: false });
    });

    it('resolves once ready is emitted, before the loop finishes', async () => {
        const { release } = pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();

        await service.connect(request(), cb);

        expect(service.isConnected()).toBe(true);
        release();
        await flush();
        expect(service.isConnected()).toBe(false);
    });

    it('reports an unusable config through onError without starting the loop', async () => {
        store.set(localAgentConfigInputAtom, { model: { ...MODEL, api_key: '' }, maxRounds: null });
        const service = new LocalAgentService();
        const cb = callbacks();

        await expect(service.connect(request(), cb)).resolves.toBeUndefined();

        expect(runLoopMock).not.toHaveBeenCalled();
        expect(cb.onError).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'error',
                type: 'local_config_error',
                run_id: 'run-1',
                is_retryable: false,
                message: expect.stringContaining('Local GPT'),
            }),
        );
        expect(cb.onDone).not.toHaveBeenCalled();
        expect(service.isConnected()).toBe(false);
    });

    it('never rejects when the loop throws before it starts streaming', async () => {
        runLoopMock.mockRejectedValue(new Error('boom'));
        const service = new LocalAgentService();
        const cb = callbacks();

        await expect(service.connect(request(), cb)).resolves.toBeUndefined();
        await flush();

        expect(cb.onError).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'local_agent_error', message: 'boom', is_retryable: false }),
        );
        expect(cb.onClose).toHaveBeenCalledWith(1000, '', true);
        expect(cb.onError.mock.invocationCallOrder[0]).toBeLessThan(cb.onClose.mock.invocationCallOrder[0]);
        expect(service.isConnected()).toBe(false);
    });

    it('reports a clean close when a run ends without the caller closing it', async () => {
        const { release } = pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();
        await service.connect(request(), cb);

        release();
        await flush();

        expect(cb.onClose).toHaveBeenCalledExactlyOnceWith(1000, '', true);
    });

    it('does not report a second close after the caller closed the finished run', async () => {
        runLoopMock.mockImplementation(async (options: any) => {
            options.callbacks.onReady({});
            await options.callbacks.onDone();
        });
        const service = new LocalAgentService();
        const cb = callbacks();
        cb.onDone.mockImplementation(() => service.close());

        await service.connect(request(), cb);
        await flush();

        expect(cb.onClose).toHaveBeenCalledOnce();
    });

    it('never rejects when the provider map cannot be built', async () => {
        resolveProviderMock.mockImplementationOnce(() => { throw new Error('no provider'); });
        const service = new LocalAgentService();
        const cb = callbacks();

        await expect(service.connect(request(), cb)).resolves.toBeUndefined();

        expect(runLoopMock).not.toHaveBeenCalled();
        expect(cb.onError).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'local_agent_error', is_retryable: false }),
        );
    });

    it('passes the thread history from earlier runs of the same thread', async () => {
        pendingLoop();
        store.set(threadRunsAtom, [
            {
                id: 'old',
                thread_id: 'thread-1',
                user_prompt: { content: 'earlier question' },
                model_messages: [{ kind: 'response', run_id: 'old', parts: [{ part_kind: 'text', content: 'earlier answer' }] }],
            } as unknown as AgentRun,
            {
                id: 'elsewhere',
                thread_id: 'thread-2',
                user_prompt: { content: 'other thread' },
                model_messages: [],
            } as unknown as AgentRun,
        ]);
        const service = new LocalAgentService();

        await service.connect(request(), callbacks());

        expect(runLoopMock.mock.calls[0][0].history).toEqual([
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
        ]);
        service.close(1000, 'test', { notifyClose: false });
    });

    it('starts a new thread with no history', async () => {
        pendingLoop();
        store.set(threadRunsAtom, [
            { id: 'old', thread_id: 'thread-1', user_prompt: { content: 'q' }, model_messages: [] } as unknown as AgentRun,
        ]);
        const service = new LocalAgentService();

        await service.connect(request({ thread_id: null }), callbacks());

        expect(runLoopMock.mock.calls[0][0].threadId).toBeNull();
        expect(runLoopMock.mock.calls[0][0].history).toEqual([]);
        service.close(1000, 'test', { notifyClose: false });
    });

    it('supersedes a running run without notifying its callbacks', async () => {
        pendingLoop();
        const service = new LocalAgentService();
        const first = callbacks();
        const second = callbacks();

        await service.connect(request(), first);
        const firstSignal: AbortSignal = runLoopMock.mock.calls[0][0].signal;
        await service.connect(request({ run_id: 'run-2' }), second);

        expect(firstSignal.aborted).toBe(true);
        expect(first.onClose).not.toHaveBeenCalled();
        expect(service.isConnected()).toBe(true);
        service.close(1000, 'test', { notifyClose: false });
    });
});

describe('LocalAgentService.cancel / close', () => {
    it('cancel aborts the run and reports a clean close', async () => {
        pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();
        await service.connect(request(), cb);
        const signal: AbortSignal = runLoopMock.mock.calls[0][0].signal;

        await service.cancel();

        expect(signal.aborted).toBe(true);
        expect(cb.onClose).toHaveBeenCalledWith(1000, 'Canceled', true);
        expect(cb.onClose.mock.calls[0]).toHaveLength(3);
        expect(service.isConnected()).toBe(false);
    });

    it('close aborts the run and notifies onClose by default', async () => {
        pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();
        await service.connect(request(), cb);
        const signal: AbortSignal = runLoopMock.mock.calls[0][0].signal;

        service.close(1000, 'Library access changed');

        expect(signal.aborted).toBe(true);
        expect(cb.onClose).toHaveBeenCalledWith(1000, 'Library access changed', true);
    });

    it('close with notifyClose false stays silent', async () => {
        pendingLoop();
        const service = new LocalAgentService();
        const cb = callbacks();
        await service.connect(request(), cb);

        service.close(1000, 'x', { notifyClose: false });

        expect(cb.onClose).not.toHaveBeenCalled();
        expect(service.isConnected()).toBe(false);
    });

    it('drops frames the loop delivers after the run was closed', async () => {
        let emitLate!: () => void;
        runLoopMock.mockImplementation(async (options: any) => {
            options.callbacks.onReady({});
            await new Promise<void>((resolve) => { emitLate = () => { options.callbacks.onPart({}); resolve(); }; });
        });
        const service = new LocalAgentService();
        const cb = callbacks();
        await service.connect(request(), cb);

        await service.cancel();
        emitLate();
        await flush();

        expect(cb.onPart).not.toHaveBeenCalled();
    });

    it('cancel and close with no run in flight do nothing', async () => {
        const service = new LocalAgentService();
        await expect(service.cancel()).resolves.toBeUndefined();
        expect(() => service.close()).not.toThrow();
        expect(service.isConnected()).toBe(false);
    });
});

describe('activeAgentService', () => {
    it('is the local service in local mode', () => {
        (globalThis as any).Zotero.Beaver = { localMode: true };
        expect(activeAgentService()).toBe(localAgentService);
    });

    it('is the cloud service otherwise', () => {
        (globalThis as any).Zotero.Beaver = { localMode: false };
        expect(activeAgentService()).toBe(cloudService);
        (globalThis as any).Zotero.Beaver = undefined;
        expect(activeAgentService()).toBe(cloudService);
    });
});
