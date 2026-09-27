import { describe, expect, it } from 'vitest';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';
import { buildRunHistory, estimateTokens } from '@beaver/agent-local/run/runHistory';

function run(id: string, prompt: string, messages: ModelMessage[], overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'local',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: prompt },
        status: 'completed',
        model_messages: messages,
        model_name: 'm',
        created_at: '2026-01-01T00:00:00Z',
        consent_to_share: false,
        ...overrides,
    } as AgentRun;
}

const response = (runId: string, parts: any[]): ModelMessage => ({ kind: 'response', run_id: runId, parts });
const request = (runId: string, parts: any[]): ModelMessage => ({
    kind: 'request',
    run_id: runId,
    parts,
    instructions: '',
});
const text = (content: string) => ({ part_kind: 'text', content });
const call = (id: string, args: unknown = { query: 'x' }) => ({
    part_kind: 'tool-call',
    tool_name: 'search_items',
    tool_call_id: id,
    args,
});
const ret = (id: string, content: unknown, outcome: 'success' | 'failed' = 'success') => ({
    part_kind: 'tool-return',
    tool_name: 'search_items',
    tool_call_id: id,
    content,
    outcome,
});

describe('buildRunHistory', () => {
    it('returns no history for a new thread', () => {
        expect(buildRunHistory([run('r1', 'hi', [response('r1', [text('hello')])])], null)).toEqual([]);
    });

    it('replays the user message and the assistant text of each run, oldest first', () => {
        const runs = [
            run('r1', 'first question', [response('r1', [text('first answer')])]),
            run('r2', 'second question', [response('r2', [{ part_kind: 'thinking', content: 'hmm' }, text('second answer')])]),
        ];

        expect(buildRunHistory(runs, 'thread-1')).toEqual([
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'second answer' },
        ]);
    });

    it('keeps each tool call paired with its return, the return right after the call', () => {
        const runs = [
            run('r1', 'find papers', [
                response('r1', [text('Searching.'), call('c1', { query: 'mice' })]),
                request('r1', [ret('c1', { type: 'search_response', request_id: 'q', items: [1, 2] })]),
                response('r1', [text('Found two.')]),
            ]),
        ];

        expect(buildRunHistory(runs, 'thread-1')).toEqual([
            { role: 'user', content: 'find papers' },
            {
                role: 'assistant',
                content: 'Searching.',
                toolCalls: [
                    { id: 'c1', name: 'search_items', args: { query: 'mice' }, rawArgs: '{"query":"mice"}', parseError: null },
                ],
            },
            { role: 'tool', content: '{"items":[1,2]}', toolCallId: 'c1' },
            { role: 'assistant', content: 'Found two.' },
        ]);
    });

    it('replays a failed tool return as its error text', () => {
        const runs = [
            run('r1', 'q', [
                response('r1', [call('c1')]),
                request('r1', [ret('c1', 'Library not searchable.', 'failed')]),
            ]),
        ];

        const history = buildRunHistory(runs, 'thread-1');
        expect(history[2]).toEqual({ role: 'tool', content: 'Library not searchable.', toolCallId: 'c1' });
    });

    it('parses string arguments and replays unparseable ones as an empty JSON object', () => {
        const runs = [
            run('r1', 'q', [
                response('r1', [call('c1', '{"query":"a"}'), call('c2', '{not json'), call('c3', '[1,2]')]),
                request('r1', [ret('c1', {}), ret('c2', {}), ret('c3', {})]),
            ]),
        ];

        const [, assistant] = buildRunHistory(runs, 'thread-1');
        expect(assistant.toolCalls).toEqual([
            { id: 'c1', name: 'search_items', args: { query: 'a' }, rawArgs: '{"query":"a"}', parseError: null },
            { id: 'c2', name: 'search_items', args: {}, rawArgs: '{}', parseError: null },
            { id: 'c3', name: 'search_items', args: {}, rawArgs: '{}', parseError: null },
        ]);
    });

    it('renders earlier prompts with their context, dropping context from libraries outside the scope', () => {
        const runs = [
            run('r1', '/explain', [response('r1', [text('done')])], {
                user_prompt: {
                    content: '/explain',
                    actions: [{ command: 'explain', action_id: 'a', prompt: 'Explain the method.' }],
                    attachments: [
                        { type: 'item', library_id: 1, library_ref: 'u', zotero_key: 'ITEMKEY1' },
                        { type: 'item', library_id: 9, zotero_key: 'SECRET01' },
                    ],
                },
            }),
        ];

        const [user] = buildRunHistory(runs, 'thread-1', { isLibrarySearchable: (id) => id === 1 });
        expect(user.role).toBe('user');
        expect(user.content).toContain('Explain the method.');
        expect(user.content).toContain('u-ITEMKEY1');
        expect(user.content).not.toContain('SECRET01');
    });

    it('drops all library context from earlier prompts when no scope check is given', () => {
        const runs = [
            run('r1', 'q', [response('r1', [text('a')])], {
                user_prompt: { content: 'q', attachments: [{ type: 'item', library_id: 1, zotero_key: 'ITEMKEY1' }] },
            }),
        ];
        expect(buildRunHistory(runs, 'thread-1')[0]).toEqual({ role: 'user', content: 'q' });
    });

    it('drops a tool call that never got a return, and a return with no call', () => {
        const runs = [
            run('r1', 'q', [
                response('r1', [text('Looking.'), call('c1'), call('c2')]),
                request('r1', [ret('c1', { ok: 1 }), ret('orphan', { ok: 2 })]),
            ], { status: 'canceled' }),
        ];

        const history = buildRunHistory(runs, 'thread-1');
        expect(history).toHaveLength(3);
        expect(history[1].toolCalls?.map((c) => c.id)).toEqual(['c1']);
        expect(history[2].toolCallId).toBe('c1');
    });

    it('drops an assistant turn left with neither text nor answered calls', () => {
        const runs = [run('r1', 'q', [response('r1', [call('c1')])], { status: 'canceled' })];

        expect(buildRunHistory(runs, 'thread-1')).toEqual([{ role: 'user', content: 'q' }]);
    });

    it('skips runs from other threads and runs without a user message', () => {
        const runs = [
            run('r1', 'other', [response('r1', [text('x')])], { thread_id: 'thread-2' }),
            run('r2', '', [response('r2', [call('c1')]), request('r2', [ret('c1', {})])]),
            run('r3', 'mine', [response('r3', [text('y')])]),
        ];

        expect(buildRunHistory(runs, 'thread-1')).toEqual([
            { role: 'user', content: 'mine' },
            { role: 'assistant', content: 'y' },
        ]);
    });

    it('drops whole runs from the oldest end to fit half the context window', () => {
        const long = 'x'.repeat(400); // ~100 tokens
        const runs = [
            run('r1', long, [response('r1', [text(long)])]),
            run('r2', long, [response('r2', [text(long)])]),
            run('r3', 'last', [response('r3', [text('reply')])]),
        ];

        const history = buildRunHistory(runs, 'thread-1', { contextWindow: 500 });

        // 250-token budget: r1 (200) must go, r2 (200) + r3 (~3) fit.
        expect(history.map((m) => m.content)).toEqual([long, long, 'last', 'reply']);
        expect(history[0].role).toBe('user');
    });

    it('keeps everything when no context window is set', () => {
        const long = 'x'.repeat(4000);
        const runs = [run('r1', long, [response('r1', [text(long)])])];
        expect(buildRunHistory(runs, 'thread-1', { contextWindow: null })).toHaveLength(2);
    });

    it('estimates tokens from content and tool-call arguments', () => {
        expect(
            estimateTokens([
                { role: 'user', content: 'abcd' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c', name: 'ab', args: {}, rawArgs: 'cd', parseError: null }],
                },
            ])
        ).toBe(2);
    });
});
