import { describe, it, expect } from 'vitest';
import { ToolCallAccumulator } from '@beaver/agent-local/llm/toolCallAccumulator';

describe('ToolCallAccumulator', () => {
    it('reassembles arguments split mid-token across fragments', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { id: 'call_1', name: 'zotero_search' });
        // A provider may break a chunk anywhere, including inside a key name.
        for (const fragment of ['{"que', 'ry": "mito', 'chondria", "li', 'mit": 5}']) {
            acc.appendArguments(0, fragment);
        }
        expect(acc.close()).toEqual([
            {
                id: 'call_1',
                name: 'zotero_search',
                args: { query: 'mitochondria', limit: 5 },
                rawArgs: '{"query": "mitochondria", "limit": 5}',
                parseError: null,
            },
        ]);
    });

    it('treats a tool call with no arguments as an empty object, not a parse error', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { id: 'c', name: 't' });
        const [call] = acc.close();
        expect(call.args).toEqual({});
        expect(call.parseError).toBeNull();
    });

    it('reports malformed arguments with the raw text instead of silently emptying them', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { id: 'c', name: 't' });
        acc.appendArguments(0, '{"query": "unterminated');
        const [call] = acc.close();
        expect(call.parseError).toBeTruthy();
        expect(call.rawArgs).toBe('{"query": "unterminated');
        expect(call.args).toEqual({});
    });

    it('rejects a non-object argument payload', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { id: 'c', name: 't' });
        acc.appendArguments(0, '"just a string"');
        expect(acc.close()[0].parseError).toContain('object');
    });

    it('keeps parallel tool calls separate by key', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { id: 'a', name: 'first' });
        acc.open(1, { id: 'b', name: 'second' });
        acc.appendArguments(0, '{"x":');
        acc.appendArguments(1, '{"y":');
        acc.appendArguments(0, '1}');
        acc.appendArguments(1, '2}');
        expect(acc.close()).toEqual([
            { id: 'a', name: 'first', args: { x: 1 }, rawArgs: '{"x":1}', parseError: null },
            { id: 'b', name: 'second', args: { y: 2 }, rawArgs: '{"y":2}', parseError: null },
        ]);
    });

    it('accepts an id and name that arrive after the first fragment', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, {});
        acc.appendArguments(0, '{"q":1}');
        acc.appendId(0, 'late_id');
        acc.appendName(0, 'late_name');
        const [call] = acc.close();
        expect(call.id).toBe('late_id');
        expect(call.name).toBe('late_name');
    });

    it('accumulates a name delivered in fragments', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, {});
        acc.appendName(0, 'zotero_');
        acc.appendName(0, 'search');
        expect(acc.close()[0].name).toBe('zotero_search');
    });

    it('synthesises an id when the provider sends none', () => {
        const acc = new ToolCallAccumulator();
        acc.open(0, { name: 't' });
        expect(acc.close()[0].id).toMatch(/.+/);
    });

    it('is empty until a call is opened', () => {
        const acc = new ToolCallAccumulator();
        expect(acc.isEmpty()).toBe(true);
        acc.open(0, { name: 't' });
        expect(acc.isEmpty()).toBe(false);
    });

    it('preserves open order regardless of key type', () => {
        const acc = new ToolCallAccumulator();
        acc.open('block_2', { name: 'second' });
        acc.open('block_1', { name: 'first' });
        expect(acc.close().map((c) => c.name)).toEqual(['second', 'first']);
    });
});
