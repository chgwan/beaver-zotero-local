import type { AgentRun } from "@beaver/agent-core/agents/types";

/**
 * One flattened part from a run's `model_messages`, positioned by its
 * coordinates in that array. Used by the `run-parts` dev inspect command to
 * check the two invariants a streamed run must hold: every tool call executed
 * with the arguments the model actually sent, and no assistant text was
 * written to more than one coordinate.
 */
export interface RunPartRow {
    message_index: number;
    part_index: number;
    part_kind: string;
    tool_name?: string;
    args?: string | Record<string, any> | null;
    content_len: number;
    content_hash: string;
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
 * Flatten a run's `model_messages` into one row per part, positioned by
 * `(message_index, part_index)` — the same coordinates the streaming loop
 * assigns parts to. A healthy run has each coordinate occupied by exactly one
 * part and no assistant text repeated across coordinates.
 */
export function flattenRunParts(run: AgentRun): RunPartRow[] {
    const rows: RunPartRow[] = [];
    run.model_messages.forEach((message, message_index) => {
        message.parts.forEach((part, part_index) => {
            const anyPart = part as Record<string, any>;
            const contentText = partContentText(anyPart);
            const row: RunPartRow = {
                message_index,
                part_index,
                part_kind: part.part_kind,
                content_len: contentText.length,
                content_hash: hashString(contentText),
            };
            if (part.part_kind === "tool-call" || part.part_kind === "tool-return" || part.part_kind === "retry-prompt") {
                row.tool_name = anyPart.tool_name;
            }
            if (part.part_kind === "tool-call") {
                row.args = anyPart.args;
            }
            rows.push(row);
        });
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
