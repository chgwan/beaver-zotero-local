import { describe, it, expect, beforeEach } from 'vitest';
import {
    setBackendAccessPolicy,
    resetBackendAccessPolicyForTesting,
    isBackendAccessAllowed,
    assertBackendAccessAllowed,
    BackendAccessBlockedError,
} from '@beaver/agent-core/transport/backendAccessPolicy';

describe('backend access policy', () => {
    beforeEach(() => {
        resetBackendAccessPolicyForTesting();
    });

    it('allows access when no host has registered a policy', () => {
        // Default state is permissive so the hosted build is unaffected.
        expect(isBackendAccessAllowed()).toBe(true);
    });

    it('blocks access when the registered probe says so', () => {
        setBackendAccessPolicy(() => false);
        expect(isBackendAccessAllowed()).toBe(false);
    });

    it('returns to the permissive default after a reset', () => {
        setBackendAccessPolicy(() => false);
        resetBackendAccessPolicyForTesting();
        expect(isBackendAccessAllowed()).toBe(true);
    });

    it('re-reads the probe on every call rather than caching it', () => {
        let allowed = true;
        setBackendAccessPolicy(() => allowed);
        expect(isBackendAccessAllowed()).toBe(true);
        allowed = false;
        expect(isBackendAccessAllowed()).toBe(false);
    });

    it('throws a named error identifying the blocked surface', () => {
        setBackendAccessPolicy(() => false);
        expect(() => assertBackendAccessAllowed('threadService.list')).toThrow(
            BackendAccessBlockedError
        );
        try {
            assertBackendAccessAllowed('threadService.list');
        } catch (error) {
            expect((error as BackendAccessBlockedError).surface).toBe('threadService.list');
            expect((error as Error).message).toContain('local mode');
        }
    });

    it('does not throw when access is allowed', () => {
        expect(() => assertBackendAccessAllowed('threadService.list')).not.toThrow();
    });
});
