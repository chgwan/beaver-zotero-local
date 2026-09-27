import { describe, it, expect, vi } from 'vitest';
import { FrameEmitter } from '@beaver/agent-local/run/frameEmitter';

/** Every member `WSCallbacks` requires, plus the two optional members the
 * closing sequence uses (`onStreamingDone`, `onRunCitations`). */
const callbacksSpy = () => ({
    onReady: vi.fn(),
    onPart: vi.fn(),
    onToolReturn: vi.fn(),
    onToolCallProgress: vi.fn(),
    onToolCallArgsStream: vi.fn(),
    onRunComplete: vi.fn(),
    onRunCitations: vi.fn(),
    onStreamingDone: vi.fn(),
    onDone: vi.fn(),
    onThread: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
});

describe('FrameEmitter', () => {
    it('emits streaming text at a stable coordinate with the full accumulated content', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.text(0, 'Read');
        round.text(0, 'Ready.');

        await emitter.flush();
        expect(callbacks.onPart).toHaveBeenCalledTimes(2);
        expect(callbacks.onPart).toHaveBeenLastCalledWith({
            event: 'part',
            run_id: 'r1',
            message_index: 0,
            part_index: 0,
            part: { part_kind: 'text', content: 'Ready.' },
        });
    });

    it('never emits the same text on a second coordinate after sealing', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.text(0, 'Ready.');
        round.sealParts();
        // A provider that also returns a final aggregated message must not
        // produce a second part; that is what renders as "Ready.Ready."
        round.text(1, 'Ready.');

        const texts = callbacks.onPart.mock.calls
            .map(([event]: any[]) => event.part.content)
            .filter(Boolean);
        await emitter.flush();
        expect(texts).toEqual(['Ready.']);
    });

    it('drops a re-emit of an already sealed coordinate', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.text(0, 'done');
        round.sealParts();
        round.text(0, 'done again');
        await emitter.flush();
        expect(callbacks.onPart).toHaveBeenCalledTimes(1);
    });

    it('puts tool returns on the index after the assistant message', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.text(0, 'calling');
        round.sealParts();
        round.toolReturn({
            part_kind: 'tool-return',
            tool_name: 'zotero_search',
            tool_call_id: 'c1',
            content: '{}',
            outcome: 'success',
        } as any);

        await emitter.flush();
        expect(callbacks.onToolReturn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'tool_return', run_id: 'r1', message_index: 1 })
        );
    });

    it('advances both indices per round so a response never lands on a request index', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

        const first = emitter.beginRound();
        first.text(0, 'one');
        first.sealParts();
        first.toolReturn({
            part_kind: 'tool-return',
            tool_name: 'zotero_search',
            tool_call_id: 'c1',
            content: '{}',
            outcome: 'success',
        } as any);

        const second = emitter.beginRound();
        second.text(0, 'two');
        await emitter.flush();

        const partIndices = callbacks.onPart.mock.calls.map(([e]: any[]) => e.message_index);
        const returnIndices = callbacks.onToolReturn.mock.calls.map(([e]: any[]) => e.message_index);
        expect(partIndices).toEqual([0, 2]);
        expect(returnIndices).toEqual([1]);
        // No index is used for both kinds; that would destroy the assistant text.
        expect(partIndices.filter((i: number) => returnIndices.includes(i))).toEqual([]);
    });

    it('emits a tool call part with its arguments', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.toolCall(0, { id: 'c1', name: 'zotero_search', args: { query: 'x' } });

        await emitter.flush();
        expect(callbacks.onPart).toHaveBeenCalledWith({
            event: 'part',
            run_id: 'r1',
            message_index: 0,
            part_index: 0,
            part: {
                part_kind: 'tool-call',
                tool_name: 'zotero_search',
                tool_call_id: 'c1',
                args: { query: 'x' },
            },
        });
    });

    it('emits thinking parts on their own part index', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const round = emitter.beginRound();
        round.thinking(0, 'considering');
        round.text(1, 'answer');
        await emitter.flush();
        expect(callbacks.onPart.mock.calls.map(([e]: any[]) => e.part_index)).toEqual([0, 1]);
    });

    it('reports which coordinates are sealed', async () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const first = emitter.beginRound();
        first.text(0, 'a');
        first.sealParts();
        await emitter.flush();
        expect(emitter.sealedCoordinates()).toEqual(['0:0']);
    });

    describe('finish()', () => {
        it('emits streaming_done, run_complete, run_citations, then done, in that order', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const order: string[] = [];
            callbacks.onStreamingDone.mockImplementation(() => order.push('streaming_done'));
            callbacks.onRunComplete.mockImplementation(() => order.push('run_complete'));
            callbacks.onRunCitations.mockImplementation(() => order.push('run_citations'));
            callbacks.onDone.mockImplementation(() => order.push('done'));

            emitter.finish();

            await emitter.flush();
            expect(order).toEqual(['streaming_done', 'run_complete', 'run_citations', 'done']);
        });

        it('emits each frame with the run id, usage, and an empty citations list', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const usage = { requests: 1, tool_calls: 0 } as any;

            emitter.finish(usage);

            await emitter.flush();
            expect(callbacks.onStreamingDone).toHaveBeenCalledWith({
                event: 'streaming_done',
                run_id: 'r1',
            });
            expect(callbacks.onRunComplete).toHaveBeenCalledWith({
                event: 'run_complete',
                run_id: 'r1',
                usage,
                cost: null,
                citations: null,
                agent_actions: null,
            });
            expect(callbacks.onRunCitations).toHaveBeenCalledWith({
                event: 'run_citations',
                run_id: 'r1',
                citations: [],
            });
            expect(callbacks.onDone).toHaveBeenCalledWith();
        });

        it('is a no-op on a second call', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.finish();
            await emitter.finish();

            await emitter.flush();
            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
            expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('fail()', () => {
        it('emits onError with the run id', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'boom', is_retryable: true });

            await emitter.flush();
            expect(callbacks.onError).toHaveBeenCalledWith({
                event: 'error',
                run_id: 'r1',
                type: 'llm_error',
                message: 'boom',
                details: undefined,
                is_retryable: true,
            });
        });

        it('never lets a later finish() emit done', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'boom' });
            emitter.finish();

            await emitter.flush();
            expect(callbacks.onDone).not.toHaveBeenCalled();
            expect(callbacks.onRunComplete).not.toHaveBeenCalled();
            expect(callbacks.onStreamingDone).not.toHaveBeenCalled();
            expect(callbacks.onRunCitations).not.toHaveBeenCalled();
        });

        it('is a no-op on a second call', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'first' });
            emitter.fail({ type: 'llm_error', message: 'second' });

            await emitter.flush();
            expect(callbacks.onError).toHaveBeenCalledTimes(1);
        });
    });
    describe('serial delivery', () => {
        const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
        const toolReturnPart = (id: string) =>
            ({ part_kind: 'tool-return', tool_name: 'zotero_search', tool_call_id: id, content: {}, outcome: 'success' }) as any;

        it('delivers the next frame only after an async callback settles', async () => {
            const callbacks = callbacksSpy();
            const order: string[] = [];
            callbacks.onPart.mockImplementation(async (e: any) => {
                await tick();
                order.push(`part:${e.message_index}:${e.part_index}:${e.part.content ?? e.part.tool_call_id}`);
            });
            callbacks.onToolReturn.mockImplementation(async (e: any) => {
                await tick();
                order.push(`return:${e.part.tool_call_id}`);
            });
            callbacks.onDone.mockImplementation(() => order.push('done'));
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const round = emitter.beginRound();
            round.text(0, 'a');
            round.toolCall(1, { id: 'c1', name: 'zotero_search', args: {} });
            round.sealParts();
            round.toolReturn(toolReturnPart('c1'));
            await emitter.finish();

            expect(order).toEqual(['part:0:0:a', 'part:0:1:c1', 'return:c1', 'done']);
        });

        it('delivers a tool return before done even when its callback is slow', async () => {
            const callbacks = callbacksSpy();
            const order: string[] = [];
            callbacks.onToolReturn.mockImplementation(async () => {
                await tick();
                await tick();
                order.push('return');
            });
            callbacks.onDone.mockImplementation(() => order.push('done'));
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const round = emitter.beginRound();
            round.sealParts();
            round.toolReturn(toolReturnPart('c1'));
            emitter.warning({ type: 'local_round_cap', message: 'cap' });
            await emitter.finish();

            expect(order).toEqual(['return', 'done']);
            expect(callbacks.onWarning.mock.invocationCallOrder[0]).toBeLessThan(
                callbacks.onDone.mock.invocationCallOrder[0]
            );
        });

        it('replaces a queued part with newer content for the same coordinate', async () => {
            const callbacks = callbacksSpy();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            callbacks.onPart.mockImplementationOnce(() => gate);
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const round = emitter.beginRound();
            round.text(0, 'R');
            for (let i = 2; i <= 1000; i++) round.text(0, 'R'.repeat(i));
            round.thinking(1, 't');
            release();
            await emitter.flush();

            const delivered = callbacks.onPart.mock.calls.map(([e]: any[]) => [e.part_index, e.part.content.length]);
            expect(delivered).toEqual([
                [0, 1],
                [0, 1000],
                [1, 1],
            ]);
        });

        it('reports a throwing callback as an event-handling error and keeps delivering', async () => {
            const callbacks = callbacksSpy();
            callbacks.onToolReturn.mockImplementation(async () => {
                throw new Error('render failed');
            });
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const round = emitter.beginRound();
            round.sealParts();
            round.toolReturn(toolReturnPart('c1'));
            round.toolReturn(toolReturnPart('c2'));
            await emitter.finish();

            expect(callbacks.onToolReturn).toHaveBeenCalledTimes(2);
            expect(callbacks.onError).toHaveBeenCalledTimes(2);
            expect(callbacks.onError).toHaveBeenCalledWith({
                event: 'error',
                type: 'event_handling_error',
                message: 'Failed to handle server event',
                details: 'Error: render failed',
            });
            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        });

        it('keeps delivering after a callback throws synchronously', async () => {
            const callbacks = callbacksSpy();
            callbacks.onRunComplete.mockImplementation(() => {
                throw new Error('sync');
            });
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            await emitter.finish();
            expect(callbacks.onError).toHaveBeenCalledTimes(1);
            expect(callbacks.onRunCitations).toHaveBeenCalledTimes(1);
            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
        });

        it('queues an error behind earlier frames', async () => {
            const callbacks = callbacksSpy();
            const order: string[] = [];
            callbacks.onPart.mockImplementation(async () => {
                await tick();
                order.push('part');
            });
            callbacks.onError.mockImplementation(() => order.push('error'));
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            emitter.beginRound().text(0, 'partial');
            await emitter.fail({ type: 'local_provider_error', message: 'boom' });
            expect(order).toEqual(['part', 'error']);
        });

        it('ignores a warning after the run ended', async () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            await emitter.finish();
            emitter.warning({ type: 'x', message: 'late' });
            await emitter.flush();
            expect(callbacks.onWarning).not.toHaveBeenCalled();
        });
    });
});
