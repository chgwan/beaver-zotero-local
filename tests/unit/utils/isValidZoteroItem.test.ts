import { beforeEach, expect, it, vi } from 'vitest';

const atoms = vi.hoisted(() => ({
    userId: Symbol('userIdAtom'),
    runUserId: Symbol('runUserIdAtom'),
    searchableLibraryIds: Symbol('searchableLibraryIdsAtom'),
}));
const state = vi.hoisted(() => ({ values: new Map<symbol, unknown>() }));

vi.mock('../../../react/store', () => ({ store: { get: (atom: symbol) => state.values.get(atom) } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: atoms.searchableLibraryIds }));
vi.mock('../../../react/atoms/auth', () => ({ userIdAtom: atoms.userId, runUserIdAtom: atoms.runUserId }));
vi.mock('../../../react/host/zotero/sourceActions', () => ({ notifyReferenceUnavailable: vi.fn() }));
vi.mock('../../../react/components/agentRuns/EditNotePreview', () => ({
    stripHtmlTags: vi.fn(), computeDiff: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({ isAttachmentOnServer: vi.fn(() => false) }));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeFileExists: vi.fn(async () => true) }));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
    agentItemFilterAsync: vi.fn(async () => true),
    isAgentSupportedItem: vi.fn(() => true),
}));

import { isValidZoteroItem } from '../../../react/utils/sourceUtils';

function pdfAttachment() {
    return {
        libraryID: 1,
        isRegularItem: () => false,
        isAttachment: () => true,
        isAnnotation: () => false,
        isNote: () => false,
        isInTrash: () => false,
    } as unknown as Zotero.Item;
}

beforeEach(() => {
    state.values.clear();
    state.values.set(atoms.searchableLibraryIds, [1]);
    Object.assign(Zotero, { Libraries: { get: vi.fn(() => ({ libraryID: 1, name: 'My Library' })) } });
});

it('accepts a PDF in local mode, where there is no signed-in user but runs have a user id', async () => {
    state.values.set(atoms.userId, null);
    state.values.set(atoms.runUserId, 'local');

    await expect(isValidZoteroItem(pdfAttachment())).resolves.toEqual({ valid: true });
});

it('rejects an item when there is no user to run as', async () => {
    state.values.set(atoms.userId, null);
    state.values.set(atoms.runUserId, null);

    const result = await isValidZoteroItem(pdfAttachment());

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/User ID not found/);
});
