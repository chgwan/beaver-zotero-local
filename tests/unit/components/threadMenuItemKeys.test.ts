import { describe, expect, it } from 'vitest';
import { threadMenuItemKeys } from '../../../react/components/ui/buttons/ThreadMenuButton';

describe('threadMenuItemKeys', () => {
    it('includes every backend-backed entry in cloud mode', () => {
        const keys = threadMenuItemKeys({ localMode: false, inWindow: false });
        expect(keys).toEqual([
            'rename', 'pin', 'delete', 'housekeeping-divider',
            'find', 'open-in-window', 'find-divider',
            'copy', 'save-note', 'save-child-note', 'copy-link',
        ]);
    });

    it('hides rename, pin, delete, open-in-window and copy-link in local mode', () => {
        const keys = threadMenuItemKeys({ localMode: true, inWindow: false });
        expect(keys).toEqual(['find', 'find-divider', 'copy', 'save-note', 'save-child-note']);
    });

    it('never shows open-in-window from inside the separate Beaver window, cloud or local', () => {
        expect(threadMenuItemKeys({ localMode: false, inWindow: true })).not.toContain('open-in-window');
        expect(threadMenuItemKeys({ localMode: true, inWindow: true })).not.toContain('open-in-window');
    });

    it('never leaves a leading or dangling divider in local mode', () => {
        const keys = threadMenuItemKeys({ localMode: true, inWindow: false });
        expect(keys[0]).not.toBe('housekeeping-divider');
        expect(keys[keys.length - 1]).not.toMatch(/-divider$/);
    });
});
