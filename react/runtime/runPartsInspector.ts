import type { AgentRun } from "@beaver/agent-core/agents/types";

/**
 * One flattened part from a run's `model_messages`, positioned by its
 * coordinates in that array. Used by the `run-parts` dev inspect command to
 * check the two invariants a streamed run must hold: every tool call executed
 * with the arguments the model actually sent, and no assistant text was ever
 * duplicated — either self-duplicated within one part ("Ready.Ready.") or
 * repeated verbatim across a tool-round boundary. `repeats_itself`,
 * `ends_round`, and `starts_round` expose what those checks need without
 * leaking full part content (only a length and a hash do).
 */
export interface RunPartRow {
    message_index: number;
    part_index: number;
    part_kind: string;
    tool_name?: string;
    args?: string | Record<string, any> | null;
    content_len: number;
    content_hash: string;
    /** True when this part's own content is `X + X` for some non-trivial `X`. */
    repeats_itself: boolean;
    /** True when this is the last text part of a response that also made a tool call. */
    ends_round: boolean;
    /** True when this is the first text part of the response immediately following a tool round. */
    starts_round: boolean;
}

/** Fold a string into a running FNV-1a hash. */
function hashInto(seed: number, value: string): number {
    let hash = seed;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

const HASH_SEED = 0x811c9dc5;

function hashString(value: string): string {
    return hashInto(HASH_SEED, value).toString(36);
}

/**
 * The textual content a part carries, for length/hash purposes. Tool-call
 * arguments and non-string tool-return/retry-prompt content are stringified
 * so structurally-equal payloads hash the same regardless of the stream's
 * intermediate string vs. object representation.
 */
function partContentText(part: Record<string, any>): string {
    switch (part.part_kind) {
        case "tool-call":
            return typeof part.args === "string" ? part.args : JSON.stringify(part.args ?? null);
        case "tool-return":
        case "retry-prompt":
            return typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? null);
        default:
            return typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
    }
}

/**
 * True when trimmed content is exactly two back-to-back copies of the same
 * non-trivial string (the "Ready.Ready." shape) — a duplication landing
 * inside a single part rather than at two coordinates. Halves shorter than 4
 * characters are ignored: too short to distinguish a genuine duplication bug
 * from a coincidentally repetitive short string.
 */
function isSelfRepeating(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 8 || trimmed.length % 2 !== 0) return false;
    const half = trimmed.length / 2;
    const first = trimmed.slice(0, half);
    if (first.length < 4) return false;
    return first === trimmed.slice(half);
}

/** Index of the last part matching `kind`, or -1 if none does. */
function lastIndexOfPartKind(parts: Record<string, any>[], kind: string): number {
    for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].part_kind === kind) return i;
    }
    return -1;
}

/** Index of the first part matching `kind`, or -1 if none does. */
function firstIndexOfPartKind(parts: Record<string, any>[], kind: string): number {
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].part_kind === kind) return i;
    }
    return -1;
}

/**
 * Flatten a run's `model_messages` into one row per part, positioned by
 * `(message_index, part_index)` — the same coordinates the streaming loop
 * assigns parts to. `updateRunWithPart` replaces rather than appends, so those
 * coordinates can never collide; the fields that actually detect a
 * duplication bug are `repeats_itself` (content duplicated in place) and the
 * `ends_round`/`starts_round` pair (content duplicated across the boundary
 * between a tool-calling round and the round that follows it).
 */
export function flattenRunParts(run: AgentRun): RunPartRow[] {
    const rows: RunPartRow[] = [];
    let previousResponseHadToolCall = false;
    run.model_messages.forEach((message, message_index) => {
        const isResponse = message.kind === "response";
        const parts = message.parts as Record<string, any>[];
        const hasToolCall = isResponse && parts.some(part => part.part_kind === "tool-call");
        const lastTextIndex = hasToolCall ? lastIndexOfPartKind(parts, "text") : -1;
        const firstTextIndex = isResponse && previousResponseHadToolCall ? firstIndexOfPartKind(parts, "text") : -1;

        parts.forEach((part, part_index) => {
            const contentText = partContentText(part);
            const row: RunPartRow = {
                message_index,
                part_index,
                part_kind: part.part_kind,
                content_len: contentText.length,
                content_hash: hashString(contentText),
                repeats_itself: (part.part_kind === "text" || part.part_kind === "thinking") && isSelfRepeating(contentText),
                ends_round: lastTextIndex !== -1 && part_index === lastTextIndex,
                starts_round: firstTextIndex !== -1 && part_index === firstTextIndex,
            };
            if (part.part_kind === "tool-call" || part.part_kind === "tool-return" || part.part_kind === "retry-prompt") {
                row.tool_name = part.tool_name;
            }
            if (part.part_kind === "tool-call") {
                row.args = part.args;
            }
            rows.push(row);
        });

        if (isResponse) previousResponseHadToolCall = hasToolCall;
    });
    return rows;
}

/**
 * Pick the run the `run-parts` command should inspect: the run matching
 * `runId` when given, else the most recently started run in `runs` (which,
 * for `allRunsAtom`, is the current thread's active run when one is
 * streaming). Returns `undefined` when nothing matches.
 */
export function selectRunForInspection(runs: AgentRun[], runId?: string): AgentRun | undefined {
    if (runId) return runs.find(run => run.id === runId);
    return runs.length > 0 ? runs[runs.length - 1] : undefined;
}
