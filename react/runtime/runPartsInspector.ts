import type { AgentRun } from "@beaver/agent-core/agents/types";

/**
 * One flattened part from a run's `model_messages`, positioned by its
 * coordinates in that array. Used by the `run-parts` dev inspect command to
 * check the invariants a streamed run must hold: every tool call executed
 * with the arguments the model actually sent (never `{}`, and never the raw
 * text the provider sent when it failed to parse), and no assistant text was
 * ever duplicated — self-duplicated within one part ("Ready.Ready."),
 * duplicated against another text part of the same response, or repeated
 * verbatim (or as a prefix) across a tool-round boundary. `repeats_itself`,
 * `ends_round`, `starts_round`, `starts_with_previous_round_text`, and
 * `duplicates_text_in_response` expose what those checks need without
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
    /**
     * True when this is a `starts_round` part whose content begins with the
     * previous round's closing text (≥20 trimmed characters) — catches a
     * regression that reproduces the prior round's text as a prefix followed
     * by more content, which an exact-hash comparison at the boundary misses.
     */
    starts_with_previous_round_text: boolean;
    /**
     * True when this text part's content hash matches another non-empty text
     * part's hash within the same response — a self-duplication landing in
     * two separate parts rather than doubled within one.
     */
    duplicates_text_in_response: boolean;
    /**
     * True for a tool-call part whose `args` is the parsed object the model
     * sent (not a raw, un-parsed string). Always false for non-tool-call
     * parts.
     */
    args_is_object: boolean;
    /**
     * True for a tool-call part whose `args` is still the raw text the
     * provider sent — a parse failure, since a successfully parsed call's
     * `args` is always an object (see `RoundFrames.toolCall()` in
     * `packages/agent-local/src/run/frameEmitter.ts`). Always false for
     * non-tool-call parts.
     */
    args_is_raw_string: boolean;
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
 * Matches trimmed content that is two back-to-back copies of the same
 * non-trivial string, optionally separated by whitespace (a run of spaces or
 * newlines) — covers both "Ready.Ready." and "Ready. Ready." /
 * "Ready.\n\nReady.". The `{4,}` floor on the captured half (non-greedy, so
 * the smallest valid split is tried first) keeps short incidental repeats
 * like "Ha ha" or "abab" from matching, since a match needs the string to
 * fully split into two identical halves of at least 4 characters each. The
 * `[\s\S]` (rather than `.`) lets a half itself span multiple lines/sentences
 * — this repo's `target` predates the `s`/dotAll regex flag.
 */
const SELF_REPEAT_PATTERN = /^([\s\S]{4,}?)\s*\1$/;

/**
 * True when trimmed content is the same non-trivial string duplicated
 * back-to-back (the "Ready.Ready." shape) — a duplication landing inside a
 * single part rather than at two coordinates.
 */
function isSelfRepeating(content: string): boolean {
    return SELF_REPEAT_PATTERN.test(content.trim());
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

/** Trimmed-character floor for a round boundary comparison to count as a real overlap. */
const MIN_ROUND_BOUNDARY_LEN = 20;

/**
 * True when `content` begins with `previousRoundEndContent` (trimmed), and
 * that shared text is long enough to not be a coincidental short phrase.
 * Broader than an exact-hash match at the boundary: it also catches a
 * regression that reproduces the prior round's text as a prefix and then
 * keeps going, which an exact-equality check would miss.
 */
function startsWithPreviousRoundText(content: string, previousRoundEndContent: string | null): boolean {
    if (previousRoundEndContent === null) return false;
    const trimmedPrev = previousRoundEndContent.trim();
    if (trimmedPrev.length < MIN_ROUND_BOUNDARY_LEN) return false;
    return content.trim().startsWith(trimmedPrev);
}

/**
 * Flatten a run's `model_messages` into one row per part, positioned by
 * `(message_index, part_index)` — the same coordinates the streaming loop
 * assigns parts to. `updateRunWithPart` replaces rather than appends, so those
 * coordinates can never collide; the fields that actually detect a
 * duplication bug are `repeats_itself` (content duplicated in place),
 * `duplicates_text_in_response` (content duplicated across two parts of the
 * same response), and the `ends_round`/`starts_round`/
 * `starts_with_previous_round_text` set (content duplicated, exactly or as a
 * prefix, across the boundary between a tool-calling round and the round that
 * follows it).
 */
export function flattenRunParts(run: AgentRun): RunPartRow[] {
    const rows: RunPartRow[] = [];
    let previousResponseHadToolCall = false;
    let previousRoundEndContent: string | null = null;
    run.model_messages.forEach((message, message_index) => {
        const isResponse = message.kind === "response";
        const parts = message.parts as Record<string, any>[];
        const hasToolCall = isResponse && parts.some(part => part.part_kind === "tool-call");
        const lastTextIndex = hasToolCall ? lastIndexOfPartKind(parts, "text") : -1;
        const firstTextIndex = isResponse && previousResponseHadToolCall ? firstIndexOfPartKind(parts, "text") : -1;

        // Count non-empty text-part content hashes within this response, so a
        // duplication landing in two separate parts (rather than doubled
        // within one, which `repeats_itself` already catches) is visible too.
        const textHashCounts = new Map<string, number>();
        if (isResponse) {
            parts.forEach(part => {
                if (part.part_kind !== "text") return;
                const text = partContentText(part);
                if (text.length === 0) return;
                const hash = hashString(text);
                textHashCounts.set(hash, (textHashCounts.get(hash) ?? 0) + 1);
            });
        }

        parts.forEach((part, part_index) => {
            const contentText = partContentText(part);
            const contentHash = hashString(contentText);
            const startsRound = firstTextIndex !== -1 && part_index === firstTextIndex;
            const isToolCall = part.part_kind === "tool-call";
            const row: RunPartRow = {
                message_index,
                part_index,
                part_kind: part.part_kind,
                content_len: contentText.length,
                content_hash: contentHash,
                repeats_itself: (part.part_kind === "text" || part.part_kind === "thinking") && isSelfRepeating(contentText),
                ends_round: lastTextIndex !== -1 && part_index === lastTextIndex,
                starts_round: startsRound,
                starts_with_previous_round_text: startsRound && startsWithPreviousRoundText(contentText, previousRoundEndContent),
                duplicates_text_in_response: part.part_kind === "text" && contentText.length > 0 && (textHashCounts.get(contentHash) ?? 0) > 1,
                args_is_object: isToolCall && typeof part.args === "object" && part.args !== null && !Array.isArray(part.args),
                args_is_raw_string: isToolCall && typeof part.args === "string",
            };
            if (part.part_kind === "tool-call" || part.part_kind === "tool-return" || part.part_kind === "retry-prompt") {
                row.tool_name = part.tool_name;
            }
            if (part.part_kind === "tool-call") {
                row.args = part.args;
            }
            rows.push(row);
        });

        if (isResponse) {
            previousResponseHadToolCall = hasToolCall;
            previousRoundEndContent = hasToolCall && lastTextIndex !== -1 ? partContentText(parts[lastTextIndex]) : null;
        }
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
