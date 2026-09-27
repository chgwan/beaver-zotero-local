/**
 * JSON fetch with the manners a free-tier API expects.
 *
 * Returns a result rather than throwing: a caller merging two sources needs to
 * report one failure alongside the other's results, and an exception would
 * discard both.
 *
 * Retries only what retrying can fix — 429 and 5xx. A 400 means the query was
 * wrong and will be wrong again.
 *
 * `sleep` and `now` are injected so tests are deterministic and fast.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export interface HttpJsonOptions {
    url: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    timeoutMs?: number;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
}

export type HttpJsonResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: string; status: number | null };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

/** Prefer the server's own advice over our backoff schedule. */
const retryAfterMs = (value: string | null): number | null => {
    if (!value) return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : null;
};

export async function fetchJson<T>(options: HttpJsonOptions): Promise<HttpJsonResult<T>> {
    const {
        url,
        headers,
        signal,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        sleep = defaultSleep,
    } = options;

    let lastStatus: number | null = null;
    let lastError = 'The request failed.';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal.aborted) return { ok: false, error: 'Cancelled.', status: null };

        // A per-attempt timeout that also respects the caller's cancellation.
        const timer = new AbortController();
        const onAbort = () => timer.abort();
        signal.addEventListener('abort', onAbort);
        const timeout = setTimeout(() => timer.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json', ...headers },
                signal: timer.signal,
            });

            if (response.ok) {
                return { ok: true, data: (await response.json()) as T };
            }

            lastStatus = response.status;
            lastError = `${response.status} ${response.statusText}`;

            if (!isRetryable(response.status) || attempt === maxAttempts - 1) {
                return { ok: false, error: lastError, status: lastStatus };
            }

            const advised = retryAfterMs(response.headers.get('Retry-After'));
            await sleep(advised ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
        } catch (error) {
            if (signal.aborted) return { ok: false, error: 'Cancelled.', status: null };
            lastStatus = null;
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt === maxAttempts - 1) {
                return { ok: false, error: lastError, status: null };
            }
            await sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
        }
    }

    return { ok: false, error: lastError, status: lastStatus };
}

export interface HostGateDeps {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/**
 * Spaces requests to one host, so a burst of tool calls does not earn a ban.
 *
 * Deliberately simple: serialised waiters, no token bucket. Local mode makes a
 * handful of requests per run, not a stream. Callers keep one instance per
 * host at module scope, so pacing holds across repeated catalog rebuilds
 * within the same process rather than resetting on every call site.
 */
export class HostGate {
    private nextAllowedAt = 0;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;

    constructor(
        private readonly minIntervalMs: number,
        deps: HostGateDeps = {}
    ) {
        this.sleep = deps.sleep ?? defaultSleep;
        this.now = deps.now ?? (() => performance.now());
    }

    async wait(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return;
        const delay = this.nextAllowedAt - this.now();
        if (delay > 0) await this.sleep(delay);
        this.nextAllowedAt = this.now() + this.minIntervalMs;
    }
}
