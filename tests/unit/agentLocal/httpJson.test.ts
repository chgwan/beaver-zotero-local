import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, HostGate, defaultSleep } from '@beaver/agent-local/search/httpJson';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

const signal = () => new AbortController().signal;
const noSleep = async () => {};

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
    it('returns parsed data on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { results: [1] })));
        const result = await fetchJson<{ results: number[] }>({ url: 'https://x/y', signal: signal() });
        expect(result).toEqual({ ok: true, data: { results: [1] } });
    });

    it('retries a 429 and succeeds on the second attempt', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(429, { message: 'slow down' }))
            .mockResolvedValueOnce(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('honours Retry-After when deciding how long to wait', async () => {
        const sleep = vi.fn(noSleep);
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(json(429, {}, { 'retry-after': '2' }))
                .mockResolvedValueOnce(json(200, {}))
        );
        await fetchJson({ url: 'https://x/y', signal: signal(), sleep });
        expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    });

    it('does not retry a 429 that reports an exhausted daily budget via X-RateLimit-Remaining: 0', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(429, {}, { 'x-ratelimit-remaining': '0' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result).toMatchObject({ ok: false, status: 429 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still retries a 429 when X-RateLimit-Remaining is above zero', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(429, {}, { 'x-ratelimit-remaining': '5' }))
            .mockResolvedValueOnce(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 whose Retry-After is far longer than this client\'s own backoff', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(429, {}, { 'retry-after': '120' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result).toMatchObject({ ok: false, status: 429 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still retries a 429 whose Retry-After is a short, ordinary backoff', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(json(429, {}, { 'retry-after': '2' }))
            .mockResolvedValueOnce(json(200, { results: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after the attempt limit and reports the status', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(429, {}));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({
            url: 'https://x/y',
            signal: signal(),
            sleep: noSleep,
            maxAttempts: 2,
        });
        expect(result).toMatchObject({ ok: false, status: 429 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 400', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(400, { message: 'bad query' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a network failure without throwing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const result = await fetchJson({ url: 'https://x/y', signal: signal(), sleep: noSleep });
        expect(result).toMatchObject({ ok: false, status: null });
        expect((result as any).error).toContain('offline');
    });

    it('stops retrying once the caller aborts', async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn().mockImplementation(async () => {
            controller.abort();
            return json(429, {});
        });
        vi.stubGlobal('fetch', fetchMock);
        const result = await fetchJson({
            url: 'https://x/y',
            signal: controller.signal,
            sleep: noSleep,
        });
        expect(result.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends the headers it was given', async () => {
        const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
        vi.stubGlobal('fetch', fetchMock);
        await fetchJson({
            url: 'https://x/y',
            headers: { 'User-Agent': 'Beaver' },
            signal: signal(),
        });
        expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe('Beaver');
    });

    it('returns its cancelled result promptly when the caller aborts during backoff', async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const fetchMock = vi.fn().mockResolvedValue(json(429, {}));
            vi.stubGlobal('fetch', fetchMock);

            // No `sleep` override: this exercises the real default backoff
            // wait (up to 8s) and proves it does not block Stop.
            const pending = fetchJson({ url: 'https://x/y', signal: controller.signal });
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);

            const result = await pending;
            expect(result).toEqual({ ok: false, error: 'Cancelled.', status: null });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('defaultSleep', () => {
    it('resolves immediately when the signal is already aborted', async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            controller.abort();
            let resolved = false;
            defaultSleep(10_000, controller.signal).then(() => {
                resolved = true;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(resolved).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves once the full duration elapses when never aborted', async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            let resolved = false;
            defaultSleep(1000, controller.signal).then(() => {
                resolved = true;
            });
            await vi.advanceTimersByTimeAsync(999);
            expect(resolved).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(resolved).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves promptly on a mid-wait abort and leaves no pending timer', async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            let resolved = false;
            defaultSleep(10_000, controller.signal).then(() => {
                resolved = true;
            });
            await vi.advanceTimersByTimeAsync(1);
            expect(vi.getTimerCount()).toBe(1);

            controller.abort();
            await vi.advanceTimersByTimeAsync(0);

            expect(resolved).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('HostGate', () => {
    it('does not delay the first request', async () => {
        const sleep = vi.fn(async () => {});
        const gate = new HostGate(1000, { sleep, now: fakeClock().now });
        await gate.wait(signal());
        expect(sleep).not.toHaveBeenCalled();
    });

    it('spaces a second request by the minimum interval', async () => {
        const clock = fakeClock();
        const sleep = vi.fn(async (ms: number) => clock.advance(ms));
        const gate = new HostGate(1000, { sleep, now: clock.now });
        await gate.wait(signal());
        await gate.wait(signal());
        expect(sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    });

    it('does not advance the pacing window when a wait is aborted before completing', async () => {
        const clock = fakeClock();
        const waited: number[] = [];
        // Not abort-aware itself — proves HostGate's own post-wait guard
        // (not the sleep implementation) is what protects the pacing state.
        const sleep = vi.fn(async (ms: number) => {
            waited.push(ms);
        });
        const gate = new HostGate(1000, { sleep, now: clock.now });

        // First wait opens the pacing window (no delay yet, so no sleep call).
        await gate.wait(signal());

        // Second wait needs to sleep — abort while the mock sleep is in
        // flight, before HostGate's post-wait check runs.
        const controller = new AbortController();
        const aborted = gate.wait(controller.signal);
        controller.abort();
        await aborted;

        // A real, non-aborted wait afterwards sees the same window as if
        // the aborted wait had never touched it.
        await gate.wait(signal());
        expect(waited).toEqual([1000, 1000]);
    });

    it('releases a real wait promptly on abort without leaking a pending timer', async () => {
        vi.useFakeTimers();
        try {
            const clock = fakeClock();
            const gate = new HostGate(1000, { now: clock.now });
            await gate.wait(signal());

            const controller = new AbortController();
            let released = false;
            const pending = gate.wait(controller.signal).then(() => {
                released = true;
            });

            await vi.advanceTimersByTimeAsync(1);
            expect(released).toBe(false);

            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            await pending;

            expect(released).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

/** A controllable clock, so HostGate's timing tests run instantly instead of waiting on real time. */
function fakeClock() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}
