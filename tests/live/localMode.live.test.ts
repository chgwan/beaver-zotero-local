/**
 * Live regression pass for local mode's two structural streaming fixes,
 * driven through the real dev endpoints against a live provider:
 *
 *   R1 — a tool call must never execute with empty arguments (accumulate
 *        fragments, parse once).
 *   R2 — assistant text must never be duplicated: neither self-duplicated
 *        within one part ("Ready." + "Ready." landing in a single part's
 *        content) nor repeated verbatim across the boundary between a
 *        tool-calling round and the round that follows it.
 *
 * Needs a local-mode instance with a configured custom model — there is no
 * hosted backend to fall back to here. See the precondition check below for
 * what happens when that isn't the case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { isLocalModeInstance, isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { ZOTERO_PORT_IS_EXPLICIT } from '../helpers/fixtures';

/** Mirrors `RunPartRow` in `react/runtime/runPartsInspector.ts`. */
interface RunPartRow {
    message_index: number;
    part_index: number;
    part_kind: string;
    tool_name?: string;
    args?: unknown;
    content_len: number;
    content_hash: string;
    repeats_itself: boolean;
    ends_round: boolean;
    starts_round: boolean;
    starts_with_previous_round_text: boolean;
    duplicates_text_in_response: boolean;
    args_is_object: boolean;
    args_is_raw_string: boolean;
}

let available = false;
let localMode = false;
let modelConfigured = false;
/**
 * Set when the `table-conversation` precondition check itself couldn't be
 * answered (a staging/production build where `inspectRuntime()` is a no-op,
 * or the dev endpoint reporting `window_unavailable`) rather than answered
 * with "no model configured". Overrides the generic skip/fail reason so a
 * failure says what actually happened instead of misreporting it as "no
 * model selected".
 */
let preconditionDetail: string | null = null;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    localMode = await isLocalModeInstance();
    if (!localMode) return;
    try {
        // Local mode only ever selects a custom model (see `availableModelsAtom`'s
        // local-mode filter in react/atoms/models.ts) — a non-null model here is a
        // configured custom model already.
        const state = await post<{ model: { isCustom: boolean } | null } | { error?: string }>(
            '/beaver/test/window-runtime',
            { command: 'table-conversation' },
        );
        if (state && typeof state === 'object' && 'error' in state && state.error) {
            preconditionDetail = state.error === 'window_unavailable'
                ? 'the window-runtime dev endpoint reports window_unavailable (no Beaver window/pane is open on this instance to inspect)'
                : `the window-runtime dev endpoint returned an error: ${state.error}`;
            return;
        }
        modelConfigured = !!(state as { model: unknown } | undefined)?.model;
    } catch (error) {
        // `inspectRuntime()` is a no-op that returns `undefined` outside a
        // development build; the dev endpoint can't serialize that as JSON,
        // so it surfaces here as a JSON parse failure rather than a real
        // model check.
        preconditionDetail = `inspectRuntime is unavailable on this instance (likely not a development build): ${error instanceof Error ? error.message : String(error)}`;
    }
});

describe('local mode: live R1/R2 streaming regression', () => {
    it('runs a tool-forcing prompt and finds no empty tool args or duplicated text', async (ctx) => {
        skipIfNoZotero(ctx, available);

        if (!localMode || !modelConfigured) {
            const reason = preconditionDetail ?? (!localMode
                ? 'requires a local-mode instance (ping reports localMode: false)'
                : 'requires a configured custom model in local mode; none is selected');
            // Hard-fail a pinned instance only when the precondition was
            // actually evaluated and came back "local mode, no model
            // configured" — a pinned hosted instance, or a precondition that
            // couldn't be evaluated (staging build, window_unavailable),
            // skips cleanly instead of misreporting a setup gap as a failure.
            const confirmedNoModel = localMode && !modelConfigured && !preconditionDetail;
            if (ZOTERO_PORT_IS_EXPLICIT && confirmedNoModel) {
                throw new Error(
                    `ZOTERO_HTTP_PORT is pinned but this instance's precondition failed: ${reason}.`,
                );
            }
            ctx.skip(reason);
            return;
        }

        const sendResult = await post<{ ok: boolean; error?: string; settle: string | null }>(
            '/beaver/test/chat-send',
            {
                text: 'Search my Zotero library for anything about machine learning and summarize what you find.',
                newThread: true,
                waitForDone: true,
                timeoutMs: 120000,
            },
            { timeout: 130000 },
        );
        expect(sendResult.ok, sendResult.error).toBe(true);
        expect(sendResult.settle).toBe('done');

        const { runId, status, parts, warnings } = await post<{ runId?: string; status?: string; parts?: RunPartRow[]; warnings?: string[]; error?: string }>(
            '/beaver/test/window-runtime',
            { command: 'run-parts' },
        ) as { runId: string; status: string; parts: RunPartRow[]; warnings: string[] };
        expect(runId).toBeTruthy();
        // Check run status before anything else: an errored or still-running
        // run would otherwise be misreported as "the model made no tool call".
        expect(
            status,
            `run ${runId} did not complete (status: ${status}); can't evaluate tool-call/text invariants on an errored or in-progress run`,
        ).toBe('completed');
        expect(Array.isArray(parts)).toBe(true);
        expect(parts.length).toBeGreaterThan(0);

        // R1: every tool call executed with the arguments the model actually
        // sent — the parsed object (which may legitimately be `{}` for a
        // tool with no required parameters, e.g. `list_libraries`), never the
        // raw un-parsed text a parse failure would leave behind.
        const toolCalls = parts.filter(part => part.part_kind === 'tool-call');
        expect(toolCalls.length, 'the model made no tool call; R1 not exercised').toBeGreaterThan(0);
        for (const call of toolCalls) {
            expect(
                call.args_is_object,
                `tool-call ${call.tool_name} at (${call.message_index},${call.part_index}) did not execute with a parsed object: ${JSON.stringify(call.args)}`,
            ).toBe(true);
            expect(
                call.args_is_raw_string,
                `tool-call ${call.tool_name} at (${call.message_index},${call.part_index}) executed with the raw, un-parsed provider text: ${JSON.stringify(call.args)}`,
            ).toBe(false);
        }
        // A `retry-prompt` part means a tool call was sent back to the model
        // to retry (e.g. after a validation/parse failure) — a direct R1
        // signal independent of what the args on the retried call look like.
        const retryPrompts = parts.filter(part => part.part_kind === 'retry-prompt');
        expect(
            retryPrompts.map(part => `(${part.message_index},${part.part_index})`),
            'the run contains a retry-prompt part, meaning a tool call needed a retry',
        ).toEqual([]);
        // `local_round_cap` fires when the loop exhausts its round budget
        // while still calling tools — a sign the model (or R1 itself) is
        // stuck in a call/retry loop rather than making progress.
        expect(
            warnings ?? [],
            'the run hit the local_round_cap warning (exhausted its round budget while still calling tools)',
        ).not.toContain('local_round_cap');

        // R2a: no text/thinking part duplicated itself in place ("Ready.Ready.").
        const selfRepeating = parts.filter(part => part.repeats_itself);
        expect(
            selfRepeating.map(part => `(${part.message_index},${part.part_index})`),
            'a text part duplicated its own content in place (the "Ready.Ready." bug)',
        ).toEqual([]);

        // R2b: no two text parts of the same response share content — a
        // duplication landing in two separate parts rather than doubled
        // within one.
        const duplicatedInResponse = parts.filter(part => part.duplicates_text_in_response);
        expect(
            duplicatedInResponse.map(part => `(${part.message_index},${part.part_index})`),
            'two text parts of the same response shared identical content',
        ).toEqual([]);

        // R2c: the text ending a tool round must not reappear verbatim as the text
        // starting the next round (the cross-coordinate shape of the same bug).
        // Ignore very short texts — legitimate short phrases ("Let me check that.")
        // can recur without being the bug.
        const MIN_ROUND_BOUNDARY_LEN = 20;
        const roundEnds = parts.filter(part => part.ends_round && part.content_len >= MIN_ROUND_BOUNDARY_LEN);
        const roundStarts = parts.filter(part => part.starts_round && part.content_len >= MIN_ROUND_BOUNDARY_LEN);
        for (const endPart of roundEnds) {
            const nextStart = roundStarts.find(part => part.message_index > endPart.message_index);
            if (!nextStart) continue;
            expect(
                nextStart.content_hash === endPart.content_hash,
                `round-ending text at (${endPart.message_index},${endPart.part_index}) reappeared verbatim as the next round's opening text at (${nextStart.message_index},${nextStart.part_index})`,
            ).toBe(false);
        }

        // R2d: broader than R2c's exact-hash check — the next round's opening
        // text must not even *begin with* the previous round's closing text,
        // which would catch a regression that reproduces the prior text as a
        // prefix and then keeps going.
        const startsWithPrevious = parts.filter(part => part.starts_with_previous_round_text);
        expect(
            startsWithPrevious.map(part => `(${part.message_index},${part.part_index})`),
            "a round's opening text began with the previous round's closing text",
        ).toEqual([]);
    }, 150000);
});
