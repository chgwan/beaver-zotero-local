/**
 * The only writer of run frames.
 *
 * Frame coordinates are load-bearing. A part frame *replaces* whatever sits at
 * `(message_index, part_index)`, so re-emitting one coordinate while streaming
 * is correct and harmless. Emitting the same content at a *second* coordinate
 * is not: both survive and the reader sees the text twice. Tool returns append
 * rather than replace, so one must be emitted exactly once. And a message
 * index carries a kind — sending a tool return at an assistant message's own
 * index would collide with it, so each round uses a disjoint index for each.
 *
 * Those rules are enforced here rather than trusted to the loop: a round hands
 * out its own indices, its parts are sealed when its stream ends, and a write
 * after sealing is refused. `finish()` and `fail()` own the run's closing
 * sequence for the same reason — each fires exactly once, and an error already
 * reported must not be followed by a normal completion.
 */

import type {
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    RunUsage,
} from '@beaver/agent-core/agents/types';
import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';

export interface FrameEmitterOptions {
    runId: string;
    callbacks: WSCallbacks;
}

/**
 * A tool return with an explicit outcome. `ToolReturnPart.outcome` is
 * optional on the wire type (older threads predate the field), but a return
 * this emitter produces must say whether the call succeeded so a failed tool
 * renders as failed rather than as a silent success.
 */
export type SealedToolReturn = ToolReturnPart & { outcome: 'success' | 'failed' };

export interface RoundFrames {
    /** Emit the full accumulated text so far for this part. */
    text(partIndex: number, content: string): void;
    thinking(partIndex: number, content: string): void;
    toolCall(
        partIndex: number,
        call: { id: string; name: string; args: Record<string, unknown> }
    ): void;
    /** Close this round's assistant message. No further parts are accepted. */
    sealParts(): void;
    toolReturn(part: SealedToolReturn): void;
}

/** What `fail()` needs to report a run-ending error. */
export interface FrameEmitterFailure {
    type: string;
    message: string;
    details?: string;
    is_retryable?: boolean;
}

export class FrameEmitter {
    private readonly runId: string;
    private readonly callbacks: WSCallbacks;
    private roundIndex = 0;
    private readonly sealed = new Set<string>();
    /** Set by `finish()` or `fail()`. Both become a no-op once either has run. */
    private finished = false;

    constructor(options: FrameEmitterOptions) {
        this.runId = options.runId;
        this.callbacks = options.callbacks;
    }

    /** Coordinates closed to further writes, as `messageIndex:partIndex`. */
    sealedCoordinates(): string[] {
        return [...this.sealed];
    }

    beginRound(): RoundFrames {
        const round = this.roundIndex++;
        const responseIndex = round * 2;
        const requestIndex = round * 2 + 1;
        const touched = new Set<number>();
        let partsSealed = false;

        const emitPart = (
            partIndex: number,
            part: TextPart | ThinkingPart | ToolCallPart
        ): void => {
            if (partsSealed) {
                if (typeof console !== 'undefined') {
                    console.log(
                        `Beaver: refused a frame for ${responseIndex}:${partIndex}; ` +
                            'the round already ended.'
                    );
                }
                return;
            }
            touched.add(partIndex);
            this.callbacks.onPart({
                event: 'part',
                run_id: this.runId,
                message_index: responseIndex,
                part_index: partIndex,
                part,
            });
        };

        return {
            text: (partIndex, content) =>
                emitPart(partIndex, { part_kind: 'text', content } as TextPart),

            thinking: (partIndex, content) =>
                emitPart(partIndex, { part_kind: 'thinking', content } as ThinkingPart),

            toolCall: (partIndex, call) =>
                emitPart(partIndex, {
                    part_kind: 'tool-call',
                    tool_name: call.name,
                    tool_call_id: call.id,
                    args: call.args,
                } as ToolCallPart),

            sealParts: () => {
                if (partsSealed) return;
                partsSealed = true;
                for (const partIndex of touched) {
                    this.sealed.add(`${responseIndex}:${partIndex}`);
                }
            },

            toolReturn: (part) => {
                this.callbacks.onToolReturn({
                    event: 'tool_return',
                    run_id: this.runId,
                    message_index: requestIndex,
                    part,
                });
            },
        };
    }

    /**
     * Emit the closing sequence for a run that finished normally: the model
     * stopped producing tokens, the run is durable, and citations (an empty
     * list here — local mode resolves none) are settled. A second call, and
     * any call after `fail()`, is a no-op — a run ends exactly once, and never
     * with both an error and a normal completion.
     */
    finish(usage: RunUsage | null = null): void {
        if (this.finished) return;
        this.finished = true;
        this.callbacks.onStreamingDone?.({ event: 'streaming_done', run_id: this.runId });
        this.callbacks.onRunComplete({
            event: 'run_complete',
            run_id: this.runId,
            usage,
            cost: null,
            citations: null,
            agent_actions: null,
        });
        this.callbacks.onRunCitations?.({
            event: 'run_citations',
            run_id: this.runId,
            citations: [],
        });
        this.callbacks.onDone();
    }

    /**
     * End the run in error. Emits `onError` and marks the run finished so a
     * later `finish()` call — from a loop's cleanup path, say — never sends
     * `done` after the error already ended it. A second call is a no-op.
     */
    fail(error: FrameEmitterFailure): void {
        if (this.finished) return;
        this.finished = true;
        this.callbacks.onError({
            event: 'error',
            run_id: this.runId,
            type: error.type,
            message: error.message,
            details: error.details,
            is_retryable: error.is_retryable,
        });
    }
}
