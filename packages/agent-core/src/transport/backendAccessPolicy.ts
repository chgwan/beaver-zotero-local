/**
 * Whether this client is permitted to talk to the Beaver backend at all.
 *
 * A host that runs the agent on the user's own machine registers a probe that
 * returns false, and every backend surface refuses rather than relying on each
 * call site to remember. Enforcing it here means a new backend client is
 * covered the moment it goes through the shared request path, instead of
 * leaking until someone notices.
 *
 * Unregistered means allowed, so the default hosted build behaves exactly as
 * before. The probe is read at the point of use, never captured, because a host
 * may register after this module loads.
 *
 * Each bundle that includes this package holds its own copy of this module, so
 * every realm that can reach the backend must register its own probe.
 */

let probe: (() => boolean) | null = null;

/** Register the access probe. Call once at host bundle init. */
export function setBackendAccessPolicy(next: () => boolean): void {
    probe = next;
}

/** Drop any registered probe, restoring the permissive default. Tests only. */
export function resetBackendAccessPolicyForTesting(): void {
    probe = null;
}

/** Whether backend access is currently permitted. */
export function isBackendAccessAllowed(): boolean {
    if (!probe) return true;
    return probe();
}

/** Raised when a backend surface is used while access is blocked. */
export class BackendAccessBlockedError extends Error {
    constructor(readonly surface: string) {
        super(
            `Beaver is in local mode, so it did not contact its backend (${surface}). ` +
                'Turn local mode off in Beaver Preferences to use Beaver-hosted features.'
        );
        this.name = 'BackendAccessBlockedError';
    }
}

/** Throw unless backend access is permitted. */
export function assertBackendAccessAllowed(surface: string): void {
    if (!isBackendAccessAllowed()) {
        throw new BackendAccessBlockedError(surface);
    }
}
