/**
 * `LocalProviderTestRunner` backs `CustomProviderCard`'s local "Test Endpoint"
 * button: it must abort a stale in-flight request when a new test starts or
 * the card unmounts, and tell the caller whether a completed result is still
 * the one to render.
 */
import { describe, expect, it } from 'vitest';
import { LocalProviderTestRunner } from '../../../react/components/preferences/localProviderTestRunner';

describe('LocalProviderTestRunner', () => {
    it('reports a fresh signal as current and not aborted', () => {
        const runner = new LocalProviderTestRunner();
        const signal = runner.start();

        expect(signal.aborted).toBe(false);
        expect(runner.isCurrent(signal)).toBe(true);
    });

    it('aborts the previous attempt when a new one starts', () => {
        const runner = new LocalProviderTestRunner();
        const first = runner.start();
        const second = runner.start();

        expect(first.aborted).toBe(true);
        expect(second.aborted).toBe(false);
        expect(runner.isCurrent(first)).toBe(false);
        expect(runner.isCurrent(second)).toBe(true);
    });

    it('aborts the in-flight attempt on dispose and stops treating it as current', () => {
        const runner = new LocalProviderTestRunner();
        const signal = runner.start();

        runner.dispose();

        expect(signal.aborted).toBe(true);
        expect(runner.isCurrent(signal)).toBe(false);
    });

    it('dispose is safe to call before any test has started', () => {
        const runner = new LocalProviderTestRunner();
        expect(() => runner.dispose()).not.toThrow();
    });

    it('never reports a signal as current once disposed, even a freshly started one', () => {
        const runner = new LocalProviderTestRunner();
        runner.dispose();
        const signal = runner.start();

        expect(runner.isCurrent(signal)).toBe(false);
    });
});
