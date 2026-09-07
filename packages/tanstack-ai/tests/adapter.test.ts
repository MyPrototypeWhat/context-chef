import type { ModelMessage } from '@tanstack/ai';
import { describe, expect, it } from 'vitest';
import { fromTanStackAI, type TanStackAIMessage, toTanStackAI } from '../src/adapter';

describe('fromTanStackAI', () => {
  it('converts user message with string content', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = fromTanStackAI(messages);
    expect(result).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Hello',
        _original: messages[0],
      }),
    ]);
  });

  it('converts user message with null content', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: null }];
    const result = fromTanStackAI(messages);
    expect(result[0].content).toBe('');
  });

  it('converts user message with ContentPart array', () => {
    const parts = [
      { type: 'text' as const, content: 'Hello' },
      {
        type: 'image' as const,
        source: { type: 'url' as const, value: 'https://example.com/img.png' },
      },
      { type: 'text' as const, content: 'World' },
    ];
    const messages: ModelMessage[] = [{ role: 'user', content: parts }];
    const result = fromTanStackAI(messages);
    expect(result[0].content).toBe('Hello\nWorld');
    expect(result[0]._original?.content).toBe(parts);
  });

  it('projects media content parts to IR attachments', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'Look at these' },
          {
            type: 'image',
            source: { type: 'data', value: 'aGVsbG8=', mimeType: 'image/png' },
          },
          {
            type: 'document',
            source: { type: 'url', value: 'https://example.com/doc.pdf' },
          },
        ],
      },
    ];
    const result = fromTanStackAI(messages);
    expect(result[0].attachments).toEqual([
      { mediaType: 'image/png', data: 'aGVsbG8=' },
      { mediaType: 'application/octet-stream', data: 'https://example.com/doc.pdf' },
    ]);
  });

  it('converts assistant message with tool calls', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'Let me check',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          },
        ],
      },
      { role: 'tool', content: 'result', toolCallId: 'tc_1' },
    ];
    const result = fromTanStackAI(messages);
    const assistant = result.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Let me check');
    expect(assistant?.tool_calls).toEqual([
      {
        id: 'tc_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"test"}' },
      },
    ]);
  });

  it('maps a thinking array to a joined IR thinking with first signature', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'answer',
        thinking: [
          { content: 'step one', signature: 'sig_1' },
          { content: 'step two', signature: 'sig_2' },
        ],
      },
    ];
    const result = fromTanStackAI(messages);
    const assistant = result.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toEqual({ thinking: 'step one\nstep two', signature: 'sig_1' });
  });

  it('converts tool message with toolCallId', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', content: 'Result data', toolCallId: 'tc_1' },
    ];
    const result = fromTanStackAI(messages);
    const toolMsg = result.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('Result data');
    expect(toolMsg?.tool_call_id).toBe('tc_1');
  });

  it('preserves name field', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hi', name: 'alice' }];
    const result = fromTanStackAI(messages);
    expect(result[0].name).toBe('alice');
  });

  // ─── Boundary sanitization ───
  it('injects placeholder for missing tool result at boundary', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'run', arguments: '{}' } }],
      },
      // Missing: tool result for tc_1
      { role: 'user', content: 'what happened?' },
    ];
    const result = fromTanStackAI(messages);

    const placeholder = result.find((m) => m.role === 'tool' && m.tool_call_id === 'tc_1');
    expect(placeholder?.content).toBe('[No tool result available]');
    // Placeholder carries the originating tool name so output adapters that
    // need it can emit a real value instead of falling back to 'unknown'.
    expect(placeholder?.name).toBe('run');
  });

  it('round-trips sanitized placeholder content through toTanStackAI', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'run', arguments: '{}' } }],
      },
      // Missing: tool result — sanitization will inject one
      { role: 'user', content: 'next' },
    ];
    const ir = fromTanStackAI(messages);
    const roundTripped = toTanStackAI(ir);

    const toolMessage = roundTripped.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toBe('[No tool result available]');
    expect(toolMessage?.toolCallId).toBe('tc_1');
  });
});

describe('toTanStackAI', () => {
  it('round-trips unmodified messages', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    expect(roundTripped).toEqual(original);
  });

  it('round-trips tool call messages', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'find something' },
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          },
        ],
      },
      { role: 'tool', content: 'Result', toolCallId: 'tc_1' },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    expect(roundTripped).toEqual(original);
  });

  it('round-trips message id and createdAt', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const original: ModelMessage[] = [
      { role: 'user', content: 'Hello', id: 'msg_1', createdAt },
      { role: 'assistant', content: 'Hi', id: 'msg_2', createdAt },
    ];
    const roundTripped = toTanStackAI(fromTanStackAI(original));
    expect(roundTripped).toEqual(original);
  });

  it('preserves metadata on tool calls during round-trip', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'find something' },
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
            metadata: { thoughtSignature: 'abc' },
          },
        ],
      },
      { role: 'tool', content: 'Result', toolCallId: 'tc_1' },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    const assistant = roundTripped.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0].metadata).toEqual({ thoughtSignature: 'abc' });
  });

  it('round-trips an unmodified thinking array byte-exact', () => {
    const thinking = [{ content: 'step one', signature: 'sig_1' }, { content: 'step two' }];
    const original: ModelMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', thinking },
    ];
    const roundTripped = toTanStackAI(fromTanStackAI(original));
    const assistant = roundTripped.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toBe(thinking); // same reference
  });

  it('omits thinking when the pipeline cleared it', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', thinking: [{ content: 'private reasoning' }] },
    ];
    const ir = fromTanStackAI(original);
    const assistant = ir.find((m) => m.role === 'assistant');
    // Simulate clear/compact stripping the reasoning
    if (assistant) assistant.thinking = undefined;
    const roundTripped = toTanStackAI(ir);
    const out = roundTripped.find((m) => m.role === 'assistant');
    expect(out?.thinking).toBeUndefined();
  });

  it('rebuilds thinking from IR when modified', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'a',
        thinking: [{ content: 'original reasoning', signature: 'sig_1' }],
      },
    ];
    const ir = fromTanStackAI(original);
    const assistant = ir.find((m) => m.role === 'assistant');
    if (assistant?.thinking) assistant.thinking = { ...assistant.thinking, thinking: 'rewritten' };
    const roundTripped = toTanStackAI(ir);
    const out = roundTripped.find((m) => m.role === 'assistant');
    expect(out?.thinking).toEqual([{ content: 'rewritten', signature: 'sig_1' }]);
  });

  it('reconstructs tool calls from IR when modified (metadata dropped)', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
            metadata: { providerExecuted: true },
          },
          {
            id: 'tc_2',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'Result 1', toolCallId: 'tc_1' },
      { role: 'tool', content: 'Result 2', toolCallId: 'tc_2' },
    ];
    const ir = fromTanStackAI(original);
    // Simulate compact stripping one tool call
    const assistant = ir.find((m) => m.role === 'assistant');
    // biome-ignore lint/style/noNonNullAssertion: tool_calls guaranteed by fromTanStackAI above
    assistant!.tool_calls = [assistant!.tool_calls![0]];
    const roundTripped = toTanStackAI(ir);
    const roundTrippedAssistant = roundTripped.find((m) => m.role === 'assistant');
    // Tool calls were modified (different length), so metadata is lost
    expect(roundTrippedAssistant?.toolCalls).toHaveLength(1);
    expect(roundTrippedAssistant?.toolCalls?.[0].metadata).toBeUndefined();
  });

  it('detects modified content and reconstructs from IR', () => {
    const original: ModelMessage[] = [{ role: 'user', content: 'Hello world' }];
    const ir = fromTanStackAI(original);
    // Simulate Janitor modifying the content
    ir[0].content = '[Summary] User said hello';
    const roundTripped = toTanStackAI(ir);
    expect(roundTripped[0].content).toBe('[Summary] User said hello');
  });

  it('preserves multimodal content when unmodified', () => {
    const parts = [
      { type: 'text' as const, content: 'Look at this' },
      {
        type: 'image' as const,
        source: { type: 'url' as const, value: 'https://example.com/img.png' },
      },
    ];
    const original: ModelMessage[] = [{ role: 'user', content: parts }];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    // Content should be the original parts array (by reference)
    expect(roundTripped[0].content).toBe(parts);
  });

  it('keeps tool messages independent (no merging)', () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'tc_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'Result 1', toolCallId: 'tc_1' },
      { role: 'tool', content: 'Result 2', toolCallId: 'tc_2' },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    const toolMessages = roundTripped.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toEqual({ role: 'tool', content: 'Result 1', toolCallId: 'tc_1' });
    expect(toolMessages[1]).toEqual({ role: 'tool', content: 'Result 2', toolCallId: 'tc_2' });
  });

  it('converts system IR messages to user messages', () => {
    // Defensive path: system-role messages may come from onBeforeCompress or direct calls
    const irMessages: TanStackAIMessage[] = [
      { role: 'system', content: '[Previous conversation summary]' },
      { role: 'user', content: 'What next?' },
    ];
    const result = toTanStackAI(irMessages);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('[Previous conversation summary]');
  });
});
