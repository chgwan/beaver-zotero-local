import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handler: undefined as any,
    current: true,
    context: null as any,
    items: [] as any[],
    send: vi.fn(),
    add: vi.fn(),
    begin: vi.fn(),
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
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
vi.mock('../../../react/hooks/useEventSubscription', () => ({
    useEventSubscription: (_name: string, handler: any) => { mocks.handler = handler; },
}));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => undefined }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { useReaderAnnotationActionHandler } from '../../../react/hooks/useReaderAnnotationActionHandler';

const attachment = { id: 42, libraryID: 1, key: 'SOURCE' };
const location = { contentKind: 'pdf', currentPage: 6 };
const annotation = { id: 43, libraryID: 1, key: 'ANNOTATION' };
beforeEach(() => {
    vi.useFakeTimers();
    mocks.current = true;
    mocks.user = { id: 'user' };
    mocks.localMode = false;
    mocks.context = null;
    mocks.items = [];
    mocks.send.mockReset();
    mocks.begin.mockResolvedValue(() => mocks.current);
    mocks.add.mockImplementation(async (items) => { mocks.items = items; });
    vi.stubGlobal('Zotero', { Items: {
        getAsync: vi.fn(async () => attachment),
        getByLibraryAndKeyAsync: vi.fn(async () => annotation),
    } });
    useReaderAnnotationActionHandler();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['ask', 'explain'])('retains the originating paper and annotations for %s in another renderer', async (action) => {
    mocks.send.mockImplementation(async () => {
        expect(mocks.items).toEqual([attachment, annotation]);
        expect(mocks.context).toEqual({ item: attachment, selection: null, location });
    });
    await mocks.handler({ action, annotationIds: ['ANNOTATION'], readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.items).toEqual([attachment, annotation]);
    expect(mocks.context).toEqual({ item: attachment, selection: null, location });
    expect(mocks.send).toHaveBeenCalledTimes(action === 'explain' ? 1 : 0);
});

it('does not set source context or send after navigation during item staging', async () => {
    mocks.add.mockImplementation(async () => { mocks.current = false; });
    await mocks.handler({ action: 'explain', annotationIds: ['ANNOTATION'], readerItemID: 42 });
    await vi.runAllTimersAsync();
    expect(mocks.context).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
});

it('runs annotation actions in local mode, where there is no signed-in user', async () => {
    mocks.user = null;
    mocks.localMode = true;
    await mocks.handler({ action: 'explain', annotationIds: ['ANNOTATION'], readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.begin).toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('ignores annotation actions when signed out outside local mode', async () => {
    mocks.user = null;
    mocks.begin.mockClear();
    await mocks.handler({ action: 'explain', annotationIds: ['ANNOTATION'], readerItemID: 42, readerLocation: location });
    await vi.runAllTimersAsync();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
});
