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
}

let available = false;
let localMode = false;
let modelConfigured = false;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    localMode = await isLocalModeInstance();
    if (!localMode) return;
    // Local mode only ever selects a custom model (see `availableModelsAtom`'s
    // local-mode filter in react/atoms/models.ts) — a non-null model here is a
    // configured custom model already.
    const state = await post<{ model: { isCustom: boolean } | null }>(
        '/beaver/test/window-runtime',
        { command: 'table-conversation' },
    );
    modelConfigured = !!state?.model;
});

describe('local mode: live R1/R2 streaming regression', () => {
    it('runs a tool-forcing prompt and finds no empty tool args or duplicated text', async (ctx) => {
        skipIfNoZotero(ctx, available);

        if (!localMode || !modelConfigured) {
            const reason = !localMode
                ? 'requires a local-mode instance (ping reports localMode: false)'
                : 'requires a configured custom model in local mode; none is selected';
            if (ZOTERO_PORT_IS_EXPLICIT) {
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

        const { runId, parts } = await post<{ runId?: string; parts?: RunPartRow[]; error?: string }>(
            '/beaver/test/window-runtime',
            { command: 'run-parts' },
        ) as { runId: string; parts: RunPartRow[] };
        expect(runId).toBeTruthy();
        expect(Array.isArray(parts)).toBe(true);
        expect(parts.length).toBeGreaterThan(0);

        // R1: every tool call executed with the arguments the model sent — never `{}`.
        const toolCalls = parts.filter(part => part.part_kind === 'tool-call');
        expect(toolCalls.length, 'the model made no tool call; R1 not exercised').toBeGreaterThan(0);
        for (const call of toolCalls) {
            const isNonEmptyObject =
                typeof call.args === 'object' && call.args !== null && !Array.isArray(call.args)
                && Object.keys(call.args as object).length > 0;
            expect(
                isNonEmptyObject,
                `tool-call ${call.tool_name} at (${call.message_index},${call.part_index}) had empty/non-object args: ${JSON.stringify(call.args)}`,
            ).toBe(true);
        }

        // R2a: no text/thinking part duplicated itself in place ("Ready.Ready.").
        const selfRepeating = parts.filter(part => part.repeats_itself);
        expect(
            selfRepeating.map(part => `(${part.message_index},${part.part_index})`),
            'a text part duplicated its own content in place (the "Ready.Ready." bug)',
        ).toEqual([]);

        // R2b: the text ending a tool round must not reappear verbatim as the text
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
    }, 150000);
});
