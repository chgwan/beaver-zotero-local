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
 *
 * Delivery is serial. Renderer callbacks may be async (a tool return loads
 * item data before it updates the run), so every frame is queued and each
 * callback's result is awaited before the next frame is delivered — the same
 * contract the hosted transport gives them. Emitting methods stay synchronous
 * so streaming stays cheap: a part frame still waiting in the queue is
 * replaced in place by a newer frame for the same coordinate, so a flood of
 * text deltas never grows the queue past one pending frame per coordinate.
 * Callers await `flush()` where ordering against their own work matters, and
 * `finish()` / `fail()` resolve only once every earlier frame has settled.
 */

import type {
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    RunUsage,
} from '@beaver/agent-core/agents/types';
import type {
    WSCallbacks,
    WSPartEvent,
    WSWarningEvent,
} from '@beaver/agent-core/protocol/agentProtocol';

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
    /**
     * Emit a tool call. `args` is the parsed object, or the raw text the
     * provider sent when it did not parse, so a malformed call shows what the
     * model actually wrote.
     */
    toolCall(
        partIndex: number,
        call: { id: string; name: string; args: Record<string, unknown> | string }
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

/** A frame waiting for delivery. */
interface QueuedFrame {
    /** Set for part frames, which a newer frame at the same coordinate replaces. */
    coordinate?: string;
    deliver: () => unknown;
}

const log = (message: string): void => {
    if (typeof console !== 'undefined') console.log(`Beaver: ${message}`);
};

export class FrameEmitter {
    private readonly runId: string;
    private readonly callbacks: WSCallbacks;
    private roundIndex = 0;
    private readonly sealed = new Set<string>();
    /** Set by `finish()` or `fail()`. Both become a no-op once either has run. */
    private finished = false;

    private readonly queue: QueuedFrame[] = [];
    /** Part frames still in `queue`, by coordinate, so a newer one can replace them. */
    private readonly queuedParts = new Map<string, QueuedFrame>();
    /** The running drain, or null when the queue is idle. */
    private draining: Promise<void> | null = null;

    constructor(options: FrameEmitterOptions) {
        this.runId = options.runId;
        this.callbacks = options.callbacks;
    }

    /** Resolves once every frame emitted so far has been delivered and settled. */
    flush(): Promise<void> {
        return this.draining ?? Promise.resolve();
    }

    private enqueue(frame: QueuedFrame): void {
        this.queue.push(frame);
        if (frame.coordinate) this.queuedParts.set(frame.coordinate, frame);
        if (!this.draining) this.draining = this.drain();
    }

    private enqueuePart(event: WSPartEvent): void {
        const coordinate = `${event.message_index}:${event.part_index}`;
        const waiting = this.queuedParts.get(coordinate);
        if (waiting) {
            // Parts replace, so only the newest content at a coordinate matters.
            waiting.deliver = () => this.callbacks.onPart(event);
            return;
        }
        this.enqueue({ coordinate, deliver: () => this.callbacks.onPart(event) });
    }

    /**
     * Deliver queued frames one at a time, awaiting each callback. A callback
     * that throws or rejects is reported through `onError` as an event-handling
     * failure and delivery continues with the next frame, as the hosted
     * transport does.
     */
    private async drain(): Promise<void> {
        while (this.queue.length > 0) {
            const frame = this.queue.shift()!;
            if (frame.coordinate && this.queuedParts.get(frame.coordinate) === frame) {
                this.queuedParts.delete(frame.coordinate);
            }
            try {
                await frame.deliver();
            } catch (error) {
                log(`a run frame callback failed: ${error}`);
                try {
                    this.callbacks.onError({
                        event: 'error',
                        type: 'event_handling_error',
                        message: 'Failed to handle server event',
                        details: String(error),
                    });
                } catch (reportError) {
                    log(`reporting a callback failure failed: ${reportError}`);
                }
            }
        }
        this.draining = null;
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
                log(`refused a frame for ${responseIndex}:${partIndex}; the round already ended.`);
                return;
            }
            touched.add(partIndex);
            this.enqueuePart({
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
                const event = {
                    event: 'tool_return' as const,
                    run_id: this.runId,
                    message_index: requestIndex,
                    part,
                };
                this.enqueue({ deliver: () => this.callbacks.onToolReturn(event) });
            },
        };
    }

    /**
     * Queue a non-fatal warning behind every frame emitted so far. Ignored
     * once the run has ended.
     */
    warning(warning: Pick<WSWarningEvent, 'type' | 'message' | 'data'>): void {
        if (this.finished) return;
        const event: WSWarningEvent = { event: 'warning', run_id: this.runId, ...warning };
        this.enqueue({ deliver: () => this.callbacks.onWarning(event) });
    }

    /**
     * Close a run that finished normally: the model stopped producing tokens,
     * the run is durable, and citations (an empty list here — local mode
     * resolves none) are settled. The frames queue behind every earlier frame,
     * and the returned promise resolves once they have all been delivered. A
     * second call, and any call after `fail()`, is a no-op — a run ends exactly
     * once, and never with both an error and a normal completion.
     */
    finish(usage: RunUsage | null = null): Promise<void> {
        if (this.finished) return this.flush();
        this.finished = true;
        const runId = this.runId;
        this.enqueue({ deliver: () => this.callbacks.onStreamingDone?.({ event: 'streaming_done', run_id: runId }) });
        this.enqueue({
            deliver: () =>
                this.callbacks.onRunComplete({
                    event: 'run_complete',
                    run_id: runId,
                    usage,
                    cost: null,
                    citations: null,
                    agent_actions: null,
                }),
        });
        this.enqueue({
            deliver: () => this.callbacks.onRunCitations?.({ event: 'run_citations', run_id: runId, citations: [] }),
        });
        this.enqueue({ deliver: () => this.callbacks.onDone() });
        return this.flush();
    }

    /**
     * End the run in error. The error queues behind every earlier frame, and
     * the returned promise resolves once it has been delivered. Marks the run
     * finished, so a later `finish()` — from a loop's cleanup path, say — never
     * sends `done` after the error already ended it. A second call is a no-op.
     */
    fail(error: FrameEmitterFailure): Promise<void> {
        if (this.finished) return this.flush();
        this.finished = true;
        const event = {
            event: 'error' as const,
            run_id: this.runId,
            type: error.type,
            message: error.message,
            details: error.details,
            is_retryable: error.is_retryable,
        };
        this.enqueue({ deliver: () => this.callbacks.onError(event) });
        return this.flush();
    }
}
