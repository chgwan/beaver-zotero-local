import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, HostGate } from '@beaver/agent-local/search/httpJson';

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
        expect(sleep).toHaveBeenCalledWith(2000);
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
        expect(sleep).toHaveBeenCalledWith(1000);
    });
});

/** A controllable clock, so HostGate's timing tests run instantly instead of waiting on real time. */
function fakeClock() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}
