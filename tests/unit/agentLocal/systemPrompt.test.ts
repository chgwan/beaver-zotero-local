import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@beaver/agent-local/run/systemPrompt';

describe('buildSystemPrompt', () => {
    it('lists the offered tools', () => {
        const prompt = buildSystemPrompt({ toolNames: ['zotero_search', 'list_items'] });
        expect(prompt).toContain('Tools available: zotero_search, list_items.');
    });

    it('separates the library from published work when scholarly search is offered', () => {
        const prompt = buildSystemPrompt({ toolNames: ['zotero_search', 'scholarly_search'] });
        const lines = prompt.split('\n').filter((line) => line.includes('scholarly_search'));
        // One guidance line, plus the tool list.
        expect(lines).toHaveLength(2);
        const guidance = lines.find((line) => !line.startsWith('Tools available'))!;
        expect(guidance).toMatch(/zotero_search/);
        expect(guidance).toMatch(/never .*in the (user’s )?library/i);
    });

    it('says nothing about scholarly search when it is not offered', () => {
        const prompt = buildSystemPrompt({ toolNames: ['zotero_search'] });
        expect(prompt).not.toMatch(/scholarly_search|published work/);
    });

    it('appends the user instructions last', () => {
        const prompt = buildSystemPrompt({ toolNames: ['scholarly_search'], customInstructions: '  Be brief. ' });
        expect(prompt.endsWith('Instructions from the user:\nBe brief.')).toBe(true);
    });
});
