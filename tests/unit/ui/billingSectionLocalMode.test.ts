// @vitest-environment jsdom
/**
 * Local mode has no account or backend, so `BillingSection` (mounted directly
 * here, independent of `PreferencePage`'s own tab gating) must not reach the
 * backend on mount there. `localModeEnabledAtom` is fixed at store creation
 * from `Zotero.Beaver.localMode`, so each test sets that flag before building
 * its own store.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BillingSection from '../../../react/components/preferences/BillingSection';

const { getPlans, getScheduledChange } = vi.hoisted(() => ({
    getPlans: vi.fn().mockResolvedValue({ plans: [] }),
    getScheduledChange: vi.fn().mockResolvedValue({ scheduled_change: null }),
}));
vi.mock('@beaver/agent-core/transport/clients/accountService', () => ({
    accountService: {
        getPlans,
        getScheduledChange,
        createCheckoutSession: vi.fn(),
        createPortalSession: vi.fn(),
        createUpgradeSession: vi.fn(),
    },
}));

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        creditPlanAtom: atom({
            plan: null,
            cancelAtPeriodEnd: false,
            pendingDowngrade: false,
            periodEnd: null,
            status: null,
            monthlyResetAt: null,
            monthlyCredits: 0,
        }),
        creditBreakdownAtom: atom({ rolledOverCredits: 0, purchasedCredits: 0, purchasedExpiresAt: null, total: 0 }),
        profileBalanceAtom: atom({ subscriptionCreditLimit: 0, monthlyCreditsUsed: 0 }),
        isCreditPlanPastDueAtom: atom(false),
        hasCreditPlanAtom: atom(false),
    };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const previousBeaver = (Zotero as any).Beaver;
afterEach(() => {
    vi.clearAllMocks();
    (Zotero as any).Beaver = previousBeaver;
});

async function render(store: ReturnType<typeof createStore>, run: (container: HTMLElement) => Promise<void>) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(BillingSection))));
        await act(async () => { await Promise.resolve(); });
        await run(container);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
}

describe('BillingSection mount effects', () => {
    it('does not call accountService on mount in local mode', async () => {
        (Zotero as any).Beaver = { ...(Zotero as any).Beaver, localMode: true };
        const store = createStore();
        await render(store, async () => {
            expect(getPlans).not.toHaveBeenCalled();
            expect(getScheduledChange).not.toHaveBeenCalled();
        });
    });

    it('fetches plans on mount outside local mode', async () => {
        (Zotero as any).Beaver = { ...(Zotero as any).Beaver, localMode: false };
        const store = createStore();
        await render(store, async () => {
            expect(getPlans).toHaveBeenCalledTimes(1);
        });
    });
});
