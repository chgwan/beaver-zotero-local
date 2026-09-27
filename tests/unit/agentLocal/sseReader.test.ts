import { describe, it, expect } from 'vitest';
import { readSseEvents } from '@beaver/agent-local/llm/sseReader';

const bodyOf = (...chunks: string[]) => {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        getReader: () => ({
            read: async () =>
                i < chunks.length
                    ? { done: false, value: encoder.encode(chunks[i++]) }
                    : { done: true, value: undefined },
            cancel: async () => {},
            releaseLock: () => {},
        }),
    };
};

const collect = async (body: any, signal = new AbortController().signal) => {
    const out = [];
    for await (const event of readSseEvents(body, signal)) out.push(event);
    return out;
};

describe('readSseEvents', () => {
    it('yields one event per data line', async () => {
        expect(await collect(bodyOf('data: {"a":1}\n\ndata: {"a":2}\n\n'))).toEqual([
            { event: null, data: '{"a":1}' },
            { event: null, data: '{"a":2}' },
        ]);
    });

    it('reassembles an event split across chunk boundaries', async () => {
        expect(await collect(bodyOf('data: {"a', '":1}\n', '\n'))).toEqual([
            { event: null, data: '{"a":1}' },
        ]);
    });

    it('reads the named event type when the provider sends one', async () => {
        expect(await collect(bodyOf('event: content_block_delta\ndata: {}\n\n'))).toEqual([
            { event: 'content_block_delta', data: '{}' },
        ]);
    });

    it('joins multi-line data payloads with newlines', async () => {
        expect(await collect(bodyOf('data: line1\ndata: line2\n\n'))).toEqual([
            { event: null, data: 'line1\nline2' },
        ]);
    });

    it('ignores comments and blank padding', async () => {
        expect(await collect(bodyOf(': keep-alive\n\ndata: {"a":1}\n\n'))).toEqual([
            { event: null, data: '{"a":1}' },
        ]);
    });

    it('handles CRLF line endings', async () => {
        expect(await collect(bodyOf('data: {"a":1}\r\n\r\n'))).toEqual([
            { event: null, data: '{"a":1}' },
        ]);
    });

    it('flushes a trailing event with no terminating blank line', async () => {
        expect(await collect(bodyOf('data: {"a":1}\n'))).toEqual([
            { event: null, data: '{"a":1}' },
        ]);
    });

    it('stops when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await collect(bodyOf('data: {"a":1}\n\n'), controller.signal)).toEqual([]);
    });
});
