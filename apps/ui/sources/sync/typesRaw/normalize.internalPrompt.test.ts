import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from '../reducer/reducer';
import { normalizeRawMessage } from './normalize';

const instructions = 'Base directory for this skill: /test/skills/example\n\nInternal skill instructions';

function output(data: unknown) {
    return { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } };
}

describe('internal Claude prompts in the transcript', () => {
    it.each([{ isMeta: true }, { isSynthetic: true }])('hides explicitly marked Skill instructions without removing their tool call or result (%j)', (flags) => {
        const state = createReducer();
        const rows = [
            output({ type: 'assistant', uuid: 'skill-call', message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'skill-tool', name: 'Skill', input: { skill: 'example' } },
            ] } }),
            output({ type: 'user', uuid: 'skill-result', isSynthetic: true, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'skill-tool', content: 'Launching skill: example' },
            ] } }),
            output({ type: 'user', uuid: 'skill-instructions', ...flags, message: { role: 'user', content: [
                { type: 'text', text: instructions },
            ] } }),
        ];
        const normalized = rows.map((row, index) => normalizeRawMessage(`skill-${index}`, null, index, row));
        expect(normalized[2]).toBeNull();
        reducer(state, normalized.filter((row) => row !== null));
        const messages = [...state.messages.values()];
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ tool: {
            id: 'skill-tool', name: 'Skill', state: 'completed', result: 'Launching skill: example',
        } });
    });

    it.each(['string', 'blocks'] as const)('hides synthetic %s instructions without relying on their wording', (format) => {
        const content = format === 'string' ? 'Provider-internal context' : [{ type: 'text', text: 'Provider-internal context' }];
        expect(normalizeRawMessage('internal', null, 1, output({ type: 'user', isSynthetic: true,
            message: { role: 'user', content } }))).toBeNull();
    });

    it.each([{}, { isMeta: false, isSynthetic: false }])('keeps unmarked Skill-like user messages (%j)', (flags) => {
        expect(normalizeRawMessage('user', null, 1, output({ type: 'user', ...flags,
            message: { role: 'user', content: instructions } }))).toMatchObject({ role: 'user', content: { text: instructions } });
        expect(normalizeRawMessage('stored-user', null, 1, { role: 'user', content: { type: 'text', text: instructions },
            meta: { source: 'cli' } })).toMatchObject({ role: 'user', content: { text: instructions } });
    });

    it('keeps a synthetic mixed message with a tool result', () => {
        const row = output({ type: 'user', isSynthetic: true, message: { role: 'user', content: [
            { type: 'text', text: 'Tool result context' },
            { type: 'tool_result', tool_use_id: 'skill-tool', content: 'Skill result' },
        ] } });
        expect(normalizeRawMessage('mixed', null, 1, row)?.content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'tool-result', tool_use_id: 'skill-tool', content: 'Skill result' }),
        ]));
    });
});
