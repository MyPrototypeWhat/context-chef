import type { Message } from '@context-chef/core';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { fromModelMessages, toModelMessages } from '../src/modelMessageAdapter';

describe('fromModelMessages', () => {
  it('keeps string-shorthand user content as text in IR', () => {
    const ir = fromModelMessages([{ role: 'user', content: 'hello' }]);
    expect(ir[0].content).toBe('hello');
    expect(ir[0]._mmUserContent).toBe('hello');
  });

  it('extracts text and records image + file parts as attachments', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'imgdata', mediaType: 'image/png' },
          { type: 'file', data: 'pdfdata', mediaType: 'application/pdf', filename: 'r.pdf' },
        ],
      },
    ];
    const ir = fromModelMessages(messages);
    expect(ir[0].content).toBe('look');
    expect(ir[0].attachments).toEqual([
      { mediaType: 'image/png', data: 'imgdata' },
      { mediaType: 'application/pdf', data: 'pdfdata', filename: 'r.pdf' },
    ]);
  });

  it('extracts assistant tool calls and reasoning', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'answer' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { a: 1 } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } }],
      },
    ];
    const assistant = fromModelMessages(messages).find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('answer');
    expect(assistant?.thinking).toEqual({ thinking: 'thinking' });
    expect(assistant?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
    ]);
  });

  it('splits a tool message into one IR message per tool-result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'bar', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'r1' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'bar', output: { type: 'json', value: { n: 2 } } },
        ],
      },
    ];
    const ir = fromModelMessages(messages).filter((m) => m.role === 'tool');
    expect(ir).toHaveLength(2);
    expect(ir[0]).toMatchObject({ content: 'r1', tool_call_id: 'c1' });
    expect(ir[1]).toMatchObject({ content: '{"n":2}', tool_call_id: 'c2' });
  });
});

describe('round-trip (ModelMessage → IR → ModelMessage)', () => {
  // Fixtures are valid histories (lead with user; every tool-result has a
  // preceding assistant tool-call) so ensureValidHistory is a no-op and the
  // round-trip is verbatim — same discipline as tests/adapter.test.ts.
  const cases: Record<string, ModelMessage[]> = {
    'string content stays a string': [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ],
    'array content with text + file': [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'file', data: 'd', mediaType: 'image/png' },
        ],
      },
    ],
    'image parts': [
      { role: 'user', content: [{ type: 'image', image: 'imgdata', mediaType: 'image/png' }] },
    ],
    'reasoning byte-exact': [
      { role: 'user', content: 'reason' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'exact reasoning bytes' },
          { type: 'text', text: 'final' },
        ],
      },
    ],
    'tool call + result': [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { q: 'x' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
        ],
      },
    ],
    'assistant tool-approval-request rides through verbatim': [
      { role: 'user', content: 'approve?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'need approval' },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
        ],
      },
    ],
    'tool-approval-response preserved in order after its result': [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        ],
      },
    ],
    'tool-approval-response BEFORE its result (leading approval, pending buffer)': [
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
        ],
      },
    ],
    'tool parts interleaved (result, approval, result) preserved in order': [
      { role: 'user', content: 'two tools' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'bar', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'r1' } },
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'bar', output: { type: 'text', value: 'r2' } },
        ],
      },
    ],
    'providerOptions on a message': [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ],
  };

  for (const [name, original] of Object.entries(cases)) {
    it(name, () => {
      const roundTripped = toModelMessages(fromModelMessages(original));
      expect(roundTripped).toEqual(original);
    });
  }
});

describe('toModelMessages', () => {
  it('emits a text-part array for synthetic messages (e.g. summary) with no pass-through', () => {
    const result = toModelMessages([{ role: 'user', content: 'summary text' }]);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'summary text' }] }]);
  });

  it('reconstructs from IR fields when content was modified (e.g. cleared tool result)', () => {
    const ir = fromModelMessages([
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'run', output: { type: 'text', value: 'long' } },
        ],
      },
    ]);
    const toolIr = ir.find((m) => m.role === 'tool');
    if (!toolIr) throw new Error('expected tool IR message');
    toolIr.content = '[cleared]'; // simulate Janitor edit
    const result = toModelMessages(ir);
    const toolMsg = result.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected a tool message');
    const part = toolMsg.content[0];
    if (part.type !== 'tool-result') throw new Error('expected a tool-result part');
    expect(part.output).toEqual({ type: 'text', value: '[cleared]' });
    expect(part.toolName).toBe('run');
  });

  it('keeps empty-string content as a string (not a text-part array)', () => {
    const result = toModelMessages([
      { role: 'user', content: '', _mmUserContent: '', _mmOriginalText: '' } as Message,
    ]);
    expect(result).toEqual([{ role: 'user', content: '' }]);
  });

  it('drops co-located approval parts when the tool result is modified (lossy by design)', () => {
    const ir = fromModelMessages([
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        ],
      },
    ]);
    const toolIr = ir.find((m) => m.role === 'tool');
    if (!toolIr) throw new Error('expected tool IR message');
    toolIr.content = '[cleared]'; // simulate a Janitor edit → modified rebuild path
    const result = toModelMessages(ir);
    const toolMsg = result.find((m) => m.role === 'tool');
    if (toolMsg?.role !== 'tool') throw new Error('expected a tool message');
    expect(toolMsg.content).toHaveLength(1);
    expect(toolMsg.content[0].type).toBe('tool-result');
  });
});
