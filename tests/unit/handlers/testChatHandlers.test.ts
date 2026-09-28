import { describe, it, expect, beforeEach, vi } from 'vitest';
import { atom } from 'jotai';

// -----------------------------------------------------------------------
// testChatHandlers.ts pulls in the full chat/run/undo dependency graph.
// This suite only exercises the local-mode gating this task adds, so every
// heavy dependency is stubbed with a minimal jotai atom; only `atoms/auth`
// and `atoms/localMode` (the atoms the gate itself reads) are real.
//
// `localModeEnabledAtom`'s read function takes no `get` argument (it mirrors
// production: local mode is read once at startup and fixed for the instance
// lifetime), so once a store has read it, it never re-evaluates. Each
// scenario below therefore gets a fresh module graph via `vi.resetModules()`
// + dynamic import, exactly like a fresh plugin instance would.
// -----------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    sendComposedMessage: vi.fn(async () => true),
    newThread: vi.fn(async () => {}),
    loadThread: vi.fn(async () => true),
    undoAgentAction: vi.fn(),
    sendApprovalResponse: vi.fn(),
    sendCreditConfirmationResponse: vi.fn(),
}));

vi.mock('../../../react/atoms/actions', () => ({
    sendComposedMessageAtom: atom(null, mocks.sendComposedMessage),
}));
vi.mock('../../../react/atoms/threads', () => ({
    newThreadAtom: atom(null, mocks.newThread),
    loadThreadAtom: atom(null, mocks.loadThread),
    currentThreadIdAtom: atom<string | null>(null),
    currentThreadNameAtom: atom<string | null>(null),
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: atom<any>(null),
    threadRunsAtom: atom<any[]>([]),
}));
vi.mock('../../../react/utils/streamingPartQueue', () => ({
    flushPendingPartEvents: vi.fn(),
}));
vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    isWSChatPendingAtom: atom(false),
    sendApprovalResponseAtom: atom(null, mocks.sendApprovalResponse),
    sendCreditConfirmationResponseAtom: atom(null, mocks.sendCreditConfirmationResponse),
}));
vi.mock('@beaver/agent-core/run-state/pendingCreditConfirmations', () => ({
    pendingCreditConfirmationsAtom: atom(new Map()),
}));
vi.mock('../../../react/agents/agentActions', () => ({
    pendingApprovalsAtom: atom(new Map()),
    threadAgentActionsAtom: atom<any[]>([]),
    undoAgentActionAtom: atom(null, mocks.undoAgentAction),
}));
vi.mock('@beaver/agent-core/run-state/pendingQuestions', () => ({
    pendingQuestionsAtom: atom(new Map()),
}));
vi.mock('../../../react/atoms/messageComposition', () => ({
    currentMessageItemsAtom: atom<any[]>([]),
    currentMessageCollectionsAtom: atom<any[]>([]),
}));
vi.mock('../../../react/utils/zoteroReferences', () => ({
    collectionToReference: vi.fn(),
}));
vi.mock('../../../react/utils/editMetadataActions', () => ({ undoEditMetadataAction: vi.fn() }));
vi.mock('../../../react/utils/createCollectionActions', () => ({ undoCreateCollectionAction: vi.fn() }));
vi.mock('../../../react/utils/organizeItemsActions', () => ({ undoOrganizeItemsAction: vi.fn() }));
vi.mock('../../../react/utils/manageTagsActions', () => ({ undoManageTagsAction: vi.fn() }));
vi.mock('../../../react/utils/manageCollectionsActions', () => ({ undoManageCollectionsAction: vi.fn() }));
vi.mock('../../../react/utils/createNoteActions', () => ({ undoCreateNoteAction: vi.fn() }));
vi.mock('../../../react/utils/editNoteActions', () => ({
    undoEditNoteAction: vi.fn(),
    undoEditNoteBatchAction: vi.fn(),
}));
vi.mock('../../../react/utils/createAnnotationsActions', () => ({ undoCreateAnnotationsAction: vi.fn() }));
vi.mock('../../../react/utils/createItemActions', () => ({ undoCreateItemActions: vi.fn() }));
vi.mock('../../../react/utils/editAnnotationsActions', () => ({ undoEditAnnotationsAction: vi.fn() }));

/**
 * Load a fresh copy of the store + handlers, with `Zotero.Beaver.localMode`
 * and the session set BEFORE the module graph (and therefore
 * `localModeEnabledAtom`'s one-shot read) is created.
 */
async function freshHandlers(opts: { localMode: boolean; authenticated: boolean }) {
    vi.resetModules();
    (Zotero as any).Beaver = { ...(Zotero as any).Beaver, localMode: opts.localMode };
    const { store } = await import('../../../react/store');
    const { sessionAtom } = await import('../../../react/atoms/auth');
    const handlers = await import('../../../react/hooks/httpHandlers/testChatHandlers');
    store.set(
        sessionAtom,
        opts.authenticated ? ({ access_token: 'tok', user: { id: 'hosted-user' } } as any) : null,
    );
    return { store, sessionAtom, ...handlers };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('handleTestChatSendHttpRequest — auth/local-mode gate', () => {
    it('rejects when neither authenticated nor in local mode', async () => {
        const h = await freshHandlers({ localMode: false, authenticated: false });
        const res = await h.handleTestChatSendHttpRequest({ text: 'hi' });
        expect(res).toEqual({
            ok: false,
            error: 'Not authenticated; chat endpoints require a logged-in plugin or a local-mode instance',
        });
    });

    it('proceeds past the gate when local mode is on, even with no session', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        const res = await h.handleTestChatSendHttpRequest({});
        // Past the gate, the next validation is the required `text` field —
        // proves the auth branch did not short-circuit the request.
        expect(res).toEqual({ ok: false, error: 'text (non-empty string) is required' });
    });

    it('proceeds past the gate when authenticated, regardless of local mode', async () => {
        const h = await freshHandlers({ localMode: false, authenticated: true });
        const res = await h.handleTestChatSendHttpRequest({});
        expect(res).toEqual({ ok: false, error: 'text (non-empty string) is required' });
    });

    it('loads a requested existing thread using the run user id (local user in local mode)', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        await h.handleTestChatSendHttpRequest({ text: 'hello', threadId: 'thread-1' });
        expect(mocks.loadThread).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ user_id: 'local', threadId: 'thread-1' }),
        );
    });
});

describe('handleTestLoadThreadHttpRequest — run user id', () => {
    it('fails with no session and local mode off (unchanged hosted behaviour)', async () => {
        const h = await freshHandlers({ localMode: false, authenticated: false });
        const res = await h.handleTestLoadThreadHttpRequest({ threadId: 't1' });
        expect(res).toEqual({ ok: false, error: 'No user_id (not logged in?)' });
    });

    it('uses the local user id when in local mode with no session', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        await h.handleTestLoadThreadHttpRequest({ threadId: 't1' });
        expect(mocks.loadThread).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ user_id: 'local', threadId: 't1' }),
        );
    });
});

describe('hosted-only handlers stay gated in local mode', () => {
    it('handleTestApproveActionHttpRequest: not available in local mode', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        const res: any = await h.handleTestApproveActionHttpRequest({});
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/not available in local mode/i);
        expect(mocks.sendApprovalResponse).not.toHaveBeenCalled();
    });

    it('handleTestApproveActionHttpRequest: unaffected when not in local mode', async () => {
        const h = await freshHandlers({ localMode: false, authenticated: true });
        const res: any = await h.handleTestApproveActionHttpRequest({});
        expect(res.ok).toBe(false);
        expect(res.error).toBe('No pending approvals');
    });

    it('handleTestConfirmCreditsHttpRequest: not available in local mode', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        const res: any = await h.handleTestConfirmCreditsHttpRequest({});
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/not available in local mode/i);
        expect(mocks.sendCreditConfirmationResponse).not.toHaveBeenCalled();
    });

    it('handleTestUndoActionHttpRequest: not available in local mode', async () => {
        const h = await freshHandlers({ localMode: true, authenticated: false });
        const res: any = await h.handleTestUndoActionHttpRequest({ actionId: 'a1' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/not available in local mode/i);
        expect(mocks.undoAgentAction).not.toHaveBeenCalled();
    });
});
