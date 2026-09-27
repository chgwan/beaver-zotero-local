import { describe, expect, it } from 'vitest';
import { runErrorActionVisibility } from '../../../react/components/agentRuns/RunErrorDisplay';

function baseArgs(overrides: Partial<Parameters<typeof runErrorActionVisibility>[0]> = {}) {
    return {
        hasBeaverFallback: true,
        errorType: 'model_error',
        hasCredits: true,
        isLastRun: true,
        hasDefaultBeaverModel: true,
        localMode: false,
        ...overrides,
    };
}

describe('runErrorActionVisibility', () => {
    it('hides both hosted-fallback actions in local mode regardless of the error', () => {
        expect(runErrorActionVisibility(baseArgs({ localMode: true }))).toEqual({
            canTryWithBeaver: false,
            canGetBeaverCredits: false,
        });
        expect(runErrorActionVisibility(baseArgs({ localMode: true, hasCredits: false }))).toEqual({
            canTryWithBeaver: false,
            canGetBeaverCredits: false,
        });
    });

    it('offers "Try with Beaver" in cloud mode when the fallback is available and credits remain', () => {
        expect(runErrorActionVisibility(baseArgs())).toEqual({
            canTryWithBeaver: true,
            canGetBeaverCredits: false,
        });
    });

    it('offers "Get Beaver Credits" instead once credits run out', () => {
        expect(runErrorActionVisibility(baseArgs({ hasCredits: false }))).toEqual({
            canTryWithBeaver: false,
            canGetBeaverCredits: true,
        });
    });

    it('offers credits for a usage-limit error even without has_beaver_fallback', () => {
        expect(runErrorActionVisibility(baseArgs({
            hasBeaverFallback: false,
            errorType: 'usage_limit_exceeded',
            hasCredits: false,
        }))).toEqual({ canTryWithBeaver: false, canGetBeaverCredits: true });
    });

    it('never offers "Try with Beaver" for a usage-limit error even with credits', () => {
        expect(runErrorActionVisibility(baseArgs({ errorType: 'usage_limit_exceeded' }))).toEqual({
            canTryWithBeaver: false,
            canGetBeaverCredits: false,
        });
    });

    it('hides "Try with Beaver" without a default Beaver model or on an older run', () => {
        expect(runErrorActionVisibility(baseArgs({ hasDefaultBeaverModel: false })).canTryWithBeaver).toBe(false);
        expect(runErrorActionVisibility(baseArgs({ isLastRun: false })).canTryWithBeaver).toBe(false);
    });
});
