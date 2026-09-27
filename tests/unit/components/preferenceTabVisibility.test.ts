/**
 * Pure helpers behind the preferences sidebar's tab list. Local mode has no
 * account or backend, so the billing tab must not appear there, and a stale
 * "billing" request (a persisted tab, or `openPreferencesWindow('billing')`)
 * must resolve to a tab that actually renders.
 */
import { describe, expect, it } from 'vitest';
import { isPreferenceTabVisible, resolvePreferenceTab } from '../../../react/components/preferences/preferenceTabs';

describe('isPreferenceTabVisible', () => {
    it('hides billing in local mode', () => {
        expect(isPreferenceTabVisible('billing', true)).toBe(false);
    });

    it('shows billing outside local mode', () => {
        expect(isPreferenceTabVisible('billing', false)).toBe(true);
    });

    it('shows every other tab in both modes', () => {
        const otherTabs = ['general', 'sync', 'permissions', 'models', 'actions', 'advanced'] as const;
        for (const tab of otherTabs) {
            expect(isPreferenceTabVisible(tab, true)).toBe(true);
            expect(isPreferenceTabVisible(tab, false)).toBe(true);
        }
    });
});

describe('resolvePreferenceTab', () => {
    it('falls back a billing request to General in local mode', () => {
        expect(resolvePreferenceTab('billing', true)).toBe('general');
    });

    it('keeps a billing request outside local mode', () => {
        expect(resolvePreferenceTab('billing', false)).toBe('billing');
    });

    it('redirects the legacy "account" alias to General in either mode', () => {
        expect(resolvePreferenceTab('account', true)).toBe('general');
        expect(resolvePreferenceTab('account', false)).toBe('general');
    });

    it('passes through any other tab unchanged in either mode', () => {
        expect(resolvePreferenceTab('sync', true)).toBe('sync');
        expect(resolvePreferenceTab('advanced', false)).toBe('advanced');
    });
});
