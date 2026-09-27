/**
 * Tracks the lifecycle of a card's in-flight local "Test Endpoint" request so
 * a stale response can't set state after the card unmounts or after a newer
 * test has started. Kept free of React so it can live in a ref and be
 * exercised without a component-rendering harness.
 */
export class LocalProviderTestRunner {
    private controller: AbortController | null = null;
    private mounted = true;

    /** Abort any in-flight attempt and start tracking a new one. Returns its signal. */
    start(): AbortSignal {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        return controller.signal;
    }

    /** Whether a result produced for `signal` is still the one to render. */
    isCurrent(signal: AbortSignal): boolean {
        return this.mounted && this.controller?.signal === signal;
    }

    /** Call on unmount: aborts the in-flight attempt and stops applying future results. */
    dispose(): void {
        this.mounted = false;
        this.controller?.abort();
        this.controller = null;
    }
}
