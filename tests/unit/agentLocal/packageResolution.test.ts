import { describe, it, expect } from 'vitest';
import { LOCAL_AGENT_PACKAGE_VERSION } from '@beaver/agent-local/version';

describe('agent-local package resolution', () => {
    it('resolves by package specifier from the test runner', () => {
        expect(LOCAL_AGENT_PACKAGE_VERSION).toBe('0.1.0');
    });
});
