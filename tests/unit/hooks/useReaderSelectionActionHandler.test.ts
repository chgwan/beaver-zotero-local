import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handler: undefined as any,
    current: true,
    context: null as any,
    items: [] as any[],
    send: vi.fn(),
    add: vi.fn(),
    begin: vi.fn(),
    dispatch: vi.fn(),
    user: { id: 'user' } as any,
    localMode: false,
}));
vi.mock('jotai', () => ({ useSetAtom: (setter: any) => setter }));
vi.mock('../../../react/atoms/auth', () => ({ userAtom: 'user' }));
vi.mock('../../../react/atoms/localMode', () => ({ localModeEnabledAtom: 'localMode' }));
vi.mock('../../../react/atoms/threads', () => ({ newThreadAtom: vi.fn() }));
vi.mock('../../../react/atoms/messageComposition', () => ({
    addItemsToCurrentMessageItemsAtom: mocks.add,
    readerActionContextAtom: (context: any) => { mocks.context = context; },
}));
vi.mock('../../../react/atoms/agentRunAtoms', () => ({ sendWSMessageAtom: mocks.send }));
vi.mock('../../../react/store', () => ({
    store: { get: (atom: string) => (atom === 'user' ? mocks.user : atom === 'localMode' ? mocks.localMode : undefined) },
}));
vi.mock('../../../react/utils/beginReaderActionThread', () => ({ beginReaderActionThread: mocks.begin }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: mocks.dispatch } }));
vi.mock('../../../react/hooks/useEventSubscription', () => ({
    useEventSubscription: (_name: string, handler: any) => { mocks.handler = handler; },
}));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => undefined }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { useReaderSelectionActionHandler } from '../../../react/hooks/useReaderSelectionActionHandler';

const attachment = { id: 42, libraryID: 1, key: 'SOURCE' };
const location = { contentKind: 'pdf', currentPage: 3 };
beforeEach(() => {
    vi.useFakeTimers();
    mocks.current = true;
    mocks.user = { id: 'user' };
    mocks.localMode = false;
    mocks.context = null;
    mocks.items = [];
    mocks.send.mockReset();
    mocks.dispatch.mockReset();
    mocks.begin.mockReset();
    mocks.begin.mockResolvedValue(() => mocks.current);
    mocks.add.mockImplementation(async (items) => { mocks.items = items; });
    vi.stubGlobal('Zotero', { Items: { getAsync: vi.fn(async () => attachment) } });
    useReaderSelectionActionHandler();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens the sidebar with the selection staged for "ask" in local mode, where there is no signed-in user', async () => {
    mocks.user = null;
    mocks.localMode = true;
    await mocks.handler({ action: 'ask', text: 'selected passage', page: 3, readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
    expect(mocks.items).toEqual([attachment]);
    expect(mocks.context).toEqual({ item: attachment, selection: { text: 'selected passage', page: 3 }, location });
    expect(mocks.dispatch).toHaveBeenCalledWith('focusInput', {});
    expect(mocks.send).not.toHaveBeenCalled();
});

it('sends the explain prompt in local mode', async () => {
    mocks.user = null;
    mocks.localMode = true;
    await mocks.handler({ action: 'explain', text: 'selected passage', page: 3, readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('ignores reader actions when signed out outside local mode', async () => {
    mocks.user = null;
    await mocks.handler({ action: 'ask', text: 'selected passage', page: 3, readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
});
