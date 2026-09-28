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
