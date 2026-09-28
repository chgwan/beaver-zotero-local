import { describe, expect, it } from "vitest";
import type { AgentRun, ModelMessage } from "@beaver/agent-core/agents/types";
import {
    flattenRunParts,
    selectRunForInspection,
} from "../../../react/runtime/runPartsInspector";

function run(model_messages: ModelMessage[], id = "run-1"): AgentRun {
    return {
        id,
        user_id: "u1",
        thread_id: "t1",
        agent_name: "beaver",
        user_prompt: { content: "hi" },
        status: "completed",
        model_messages,
        model_name: "test-model",
        created_at: new Date().toISOString(),
        consent_to_share: false,
    };
}

describe("flattenRunParts", () => {
    it("assigns message_index and part_index per position in model_messages", () => {
        const target = run([
            { kind: "request", run_id: "run-1", instructions: "", parts: [{ part_kind: "user-prompt", content: "Search for X" }] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Looking that up." },
                { part_kind: "tool-call", tool_name: "search", args: { query: "X" }, tool_call_id: "call-1" },
            ] },
        ]);
        const rows = flattenRunParts(target);
        expect(rows.map(row => [row.message_index, row.part_index])).toEqual([
            [0, 0],
            [1, 0],
            [1, 1],
        ]);
    });

    it("populates tool_name and args only for tool-bearing part kinds", () => {
        const target = run([
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "user-prompt", content: "Search for X" },
                { part_kind: "tool-return", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "tool-call", tool_name: "search", args: { query: "X" }, tool_call_id: "call-1" },
            ] },
        ]);
        const rows = flattenRunParts(target);
        const userPrompt = rows.find(row => row.part_kind === "user-prompt")!;
        const toolReturn = rows.find(row => row.part_kind === "tool-return")!;
        const toolCall = rows.find(row => row.part_kind === "tool-call")!;
        expect(userPrompt.tool_name).toBeUndefined();
        expect(userPrompt.args).toBeUndefined();
        expect(toolReturn.tool_name).toBe("search");
        expect(toolReturn.args).toBeUndefined();
        expect(toolCall.tool_name).toBe("search");
        expect(toolCall.args).toEqual({ query: "X" });
    });

    it("passes string tool-call args through as-is instead of double-encoding them", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "tool-call", tool_name: "search", args: '{"query":"X"}', tool_call_id: "call-1" },
            ] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.args).toBe('{"query":"X"}');
    });

    it("computes content_len from the part's textual content", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.content_len).toBe("Ready.".length);
    });

    it("gives identical text content the same content_hash across parts", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready." }] },
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready." }] },
        ]);
        const [first, second] = flattenRunParts(target);
        expect(first.content_hash).toBe(second.content_hash);
    });

    it("gives different content different content_hash values (no collisions for near-identical strings)", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Ready." },
                { part_kind: "text", content: "Ready.." },
            ] },
        ]);
        const [first, second] = flattenRunParts(target);
        expect(first.content_hash).not.toBe(second.content_hash);
    });

    it("derives tool-return and retry-prompt content_hash from stringified non-string content", () => {
        const target = run([
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "tool-return", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-1" },
                { part_kind: "retry-prompt", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-2" },
            ] },
        ]);
        const [toolReturn, retryPrompt] = flattenRunParts(target);
        expect(toolReturn.content_hash).toBe(retryPrompt.content_hash);
        expect(toolReturn.content_len).toBe(JSON.stringify({ hits: 1 }).length);
    });

    it("every (message_index, part_index) pair appears exactly once", () => {
        const target = run([
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "user-prompt", content: "a" },
                { part_kind: "tool-return", tool_name: "search", content: "b", tool_call_id: "call-1" },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "c" },
                { part_kind: "thinking", content: "d" },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-2" },
            ] },
        ]);
        const rows = flattenRunParts(target);
        const seen = new Set(rows.map(row => `${row.message_index}:${row.part_index}`));
        expect(seen.size).toBe(rows.length);
    });

    it("returns an empty array for a run with no model messages", () => {
        expect(flattenRunParts(run([]))).toEqual([]);
    });

    it("marks a text part as repeats_itself when its content is X+X ('Ready.Ready.' shape)", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready.Ready." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(true);
    });

    it("does not mark repeats_itself for non-repeating text", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Looking that up now." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(false);
    });

    it("does not mark repeats_itself when the repeated half is shorter than 4 characters", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "abab" }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(false);
    });

    it("checks thinking parts for repeats_itself too", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "thinking", content: "Hmm okay.Hmm okay." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(true);
    });

    it("marks repeats_itself for a single-space-separated duplication ('Ready. Ready.')", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready. Ready." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(true);
    });

    it("marks repeats_itself for a blank-line-separated duplication ('Ready.\\n\\nReady.')", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ready.\n\nReady." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(true);
    });

    it("marks repeats_itself for a multi-sentence duplicated half", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Found one paper. It is X. Found one paper. It is X." },
            ] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(true);
    });

    it("does not mark repeats_itself for 'Ha ha' (halves shorter than 4 characters)", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "Ha ha" }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(false);
    });

    it("does not mark repeats_itself for a normal sentence that merely contains a repeated word/phrase", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "The report mentions machine learning research and machine learning applications." },
            ] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(false);
    });

    it("never marks repeats_itself for non-text/thinking parts, even with self-repeating content", () => {
        const target = run([
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "tool-return", tool_name: "search", content: "abcdabcd", tool_call_id: "call-1" },
            ] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.repeats_itself).toBe(false);
    });

    it("marks the last text part of a tool-calling round as ends_round", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Let me check that." },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-1" },
            ] },
        ]);
        const rows = flattenRunParts(target);
        expect(rows[0].ends_round).toBe(true);
        expect(rows[1].ends_round).toBe(false);
    });

    it("only marks the LAST text part as ends_round when a round has multiple text parts before the tool call", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "First." },
                { part_kind: "text", content: "Second." },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-1" },
            ] },
        ]);
        const rows = flattenRunParts(target);
        expect(rows[0].ends_round).toBe(false);
        expect(rows[1].ends_round).toBe(true);
    });

    it("does not mark ends_round for a response round with no tool call", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [{ part_kind: "text", content: "All done, no tools needed." }] },
        ]);
        const [row] = flattenRunParts(target);
        expect(row.ends_round).toBe(false);
    });

    it("marks the first text part of the response immediately after a tool round as starts_round", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Let me check that." },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "tool-return", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Found one result." },
            ] },
        ]);
        const rows = flattenRunParts(target);
        const startsRound = rows.filter(row => row.starts_round);
        expect(startsRound).toHaveLength(1);
        expect(startsRound[0].content_len).toBe("Found one result.".length);
    });

    it("only marks the FIRST text part as starts_round when the following round has multiple text parts", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Checking." },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "tool-return", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "First part." },
                { part_kind: "text", content: "Second part." },
            ] },
        ]);
        const rows = flattenRunParts(target);
        const responseTwoRows = rows.filter(row => row.message_index === 2);
        expect(responseTwoRows[0].starts_round).toBe(true);
        expect(responseTwoRows[1].starts_round).toBe(false);
    });

    it("does not mark starts_round for a response two rounds after a tool call", () => {
        const target = run([
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Checking." },
                { part_kind: "tool-call", tool_name: "search", args: { q: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "request", run_id: "run-1", instructions: "", parts: [
                { part_kind: "tool-return", tool_name: "search", content: { hits: 1 }, tool_call_id: "call-1" },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "Found one result." },
            ] },
            { kind: "response", run_id: "run-1", parts: [
                { part_kind: "text", content: "One more thing." },
            ] },
        ]);
        const rows = flattenRunParts(target);
        const responseThreeRows = rows.filter(row => row.message_index === 3);
        expect(responseThreeRows[0].starts_round).toBe(false);
    });
});

describe("selectRunForInspection", () => {
    const first = run([], "run-1");
    const second = run([], "run-2");
    const runs = [first, second];

    it("returns the run matching the given runId", () => {
        expect(selectRunForInspection(runs, "run-2")).toBe(second);
    });

    it("returns undefined when runId does not match any run", () => {
        expect(selectRunForInspection(runs, "missing")).toBeUndefined();
    });

    it("returns the latest run when no runId is given", () => {
        expect(selectRunForInspection(runs)).toBe(second);
    });

    it("returns undefined when there are no runs and no runId", () => {
        expect(selectRunForInspection([])).toBeUndefined();
    });
});
