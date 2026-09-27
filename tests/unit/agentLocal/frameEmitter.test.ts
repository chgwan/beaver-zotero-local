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
    it('emits streaming text at a stable coordinate with the full accumulated content', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.text(0, 'Read');
        round.text(0, 'Ready.');

        expect(callbacks.onPart).toHaveBeenCalledTimes(2);
        expect(callbacks.onPart).toHaveBeenLastCalledWith({
            event: 'part',
            run_id: 'r1',
            message_index: 0,
            part_index: 0,
            part: { part_kind: 'text', content: 'Ready.' },
        });
    });

    it('never emits the same text on a second coordinate after sealing', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.text(0, 'Ready.');
        round.sealParts();
        // A provider that also returns a final aggregated message must not
        // produce a second part; that is what renders as "Ready.Ready."
        round.text(1, 'Ready.');

        const texts = callbacks.onPart.mock.calls
            .map(([event]: any[]) => event.part.content)
            .filter(Boolean);
        expect(texts).toEqual(['Ready.']);
    });

    it('drops a re-emit of an already sealed coordinate', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.text(0, 'done');
        round.sealParts();
        round.text(0, 'done again');
        expect(callbacks.onPart).toHaveBeenCalledTimes(1);
    });

    it('puts tool returns on the index after the assistant message', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.text(0, 'calling');
        round.sealParts();
        round.toolReturn({
            part_kind: 'tool-return',
            tool_name: 'zotero_search',
            tool_call_id: 'c1',
            content: '{}',
            outcome: 'success',
        } as any);

        expect(callbacks.onToolReturn).toHaveBeenCalledWith(
            expect.objectContaining({ event: 'tool_return', run_id: 'r1', message_index: 1 })
        );
    });

    it('advances both indices per round so a response never lands on a request index', () => {
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

        const partIndices = callbacks.onPart.mock.calls.map(([e]: any[]) => e.message_index);
        const returnIndices = callbacks.onToolReturn.mock.calls.map(([e]: any[]) => e.message_index);
        expect(partIndices).toEqual([0, 2]);
        expect(returnIndices).toEqual([1]);
        // No index is used for both kinds; that would destroy the assistant text.
        expect(partIndices.filter((i: number) => returnIndices.includes(i))).toEqual([]);
    });

    it('emits a tool call part with its arguments', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.toolCall(0, { id: 'c1', name: 'zotero_search', args: { query: 'x' } });

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

    it('emits thinking parts on their own part index', () => {
        const callbacks = callbacksSpy();
        const round = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any }).beginRound();
        round.thinking(0, 'considering');
        round.text(1, 'answer');
        expect(callbacks.onPart.mock.calls.map(([e]: any[]) => e.part_index)).toEqual([0, 1]);
    });

    it('reports which coordinates are sealed', () => {
        const callbacks = callbacksSpy();
        const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
        const first = emitter.beginRound();
        first.text(0, 'a');
        first.sealParts();
        expect(emitter.sealedCoordinates()).toEqual(['0:0']);
    });

    describe('finish()', () => {
        it('emits streaming_done, run_complete, run_citations, then done, in that order', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const order: string[] = [];
            callbacks.onStreamingDone.mockImplementation(() => order.push('streaming_done'));
            callbacks.onRunComplete.mockImplementation(() => order.push('run_complete'));
            callbacks.onRunCitations.mockImplementation(() => order.push('run_citations'));
            callbacks.onDone.mockImplementation(() => order.push('done'));

            emitter.finish();

            expect(order).toEqual(['streaming_done', 'run_complete', 'run_citations', 'done']);
        });

        it('emits each frame with the run id, usage, and an empty citations list', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });
            const usage = { requests: 1, tool_calls: 0 } as any;

            emitter.finish(usage);

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

        it('is a no-op on a second call', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.finish();
            emitter.finish();

            expect(callbacks.onDone).toHaveBeenCalledTimes(1);
            expect(callbacks.onRunComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('fail()', () => {
        it('emits onError with the run id', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'boom', is_retryable: true });

            expect(callbacks.onError).toHaveBeenCalledWith({
                event: 'error',
                run_id: 'r1',
                type: 'llm_error',
                message: 'boom',
                details: undefined,
                is_retryable: true,
            });
        });

        it('never lets a later finish() emit done', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'boom' });
            emitter.finish();

            expect(callbacks.onDone).not.toHaveBeenCalled();
            expect(callbacks.onRunComplete).not.toHaveBeenCalled();
            expect(callbacks.onStreamingDone).not.toHaveBeenCalled();
            expect(callbacks.onRunCitations).not.toHaveBeenCalled();
        });

        it('is a no-op on a second call', () => {
            const callbacks = callbacksSpy();
            const emitter = new FrameEmitter({ runId: 'r1', callbacks: callbacks as any });

            emitter.fail({ type: 'llm_error', message: 'first' });
            emitter.fail({ type: 'llm_error', message: 'second' });

            expect(callbacks.onError).toHaveBeenCalledTimes(1);
        });
    });
});
