import { describe, expect, it } from 'vitest';
import { threadListEmptyMessage } from '../../../react/components/ThreadListView';

describe('threadListEmptyMessage', () => {
    it('says chats are not saved in local mode when nothing is filtered or searched', () => {
        expect(threadListEmptyMessage({ activeQuery: '', filterLabel: null, localMode: true }))
            .toBe("Chats aren't saved in local mode.");
    });

    it('falls back to the ordinary empty message in cloud mode', () => {
        expect(threadListEmptyMessage({ activeQuery: '', filterLabel: null, localMode: false }))
            .toBe('No chats yet');
    });

    it('prefers the search-miss message over the local-mode message', () => {
        expect(threadListEmptyMessage({ activeQuery: 'foo', filterLabel: null, localMode: true }))
            .toBe('No matching chats');
    });

    it('prefers the item-filter message over the local-mode message', () => {
        expect(threadListEmptyMessage({ activeQuery: '', filterLabel: 'Sources', localMode: true }))
            .toBe('No chats about Sources');
    });
});
