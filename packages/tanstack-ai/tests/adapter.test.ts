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
        _originalContent: 'Hello',
        _originalText: 'Hello',
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
    expect(result[0]._originalContent).toBe(parts);
  });

  it('converts assistant message with tool calls', () => {
    const messages: ModelMessage[] = [
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
    ];
    const result = fromTanStackAI(messages);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Let me check');
    expect(result[0].tool_calls).toEqual([
      {
        id: 'tc_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"test"}' },
      },
    ]);
  });

  it('converts tool message with toolCallId', () => {
    const messages: ModelMessage[] = [{ role: 'tool', content: 'Result data', toolCallId: 'tc_1' }];
    const result = fromTanStackAI(messages);
    expect(result[0].role).toBe('tool');
    expect(result[0].content).toBe('Result data');
    expect(result[0].tool_call_id).toBe('tc_1');
  });

  it('preserves name field', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hi', name: 'alice' }];
    const result = fromTanStackAI(messages);
    expect(result[0].name).toBe('alice');
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

  it('preserves providerMetadata on tool calls during round-trip', () => {
    const original: ModelMessage[] = [
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
            providerMetadata: { openai: { index: 0 } },
          },
        ],
      },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    expect(roundTripped[0].toolCalls?.[0].providerMetadata).toEqual({
      openai: { index: 0 },
    });
  });

  it('reconstructs tool calls from IR when modified', () => {
    const original: ModelMessage[] = [
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
            providerMetadata: { openai: { index: 0 } },
          },
          {
            id: 'tc_2',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          },
        ],
      },
    ];
    const ir = fromTanStackAI(original);
    // Simulate compact stripping one tool call
    ir[0].tool_calls = [ir[0].tool_calls?.[0] ?? ir[0].tool_calls[0]];
    const roundTripped = toTanStackAI(ir);
    // Tool calls were modified (different length), so providerMetadata is lost
    expect(roundTripped[0].toolCalls).toHaveLength(1);
    expect(roundTripped[0].toolCalls?.[0].providerMetadata).toBeUndefined();
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
      { role: 'tool', content: 'Result 1', toolCallId: 'tc_1' },
      { role: 'tool', content: 'Result 2', toolCallId: 'tc_2' },
    ];
    const ir = fromTanStackAI(original);
    const roundTripped = toTanStackAI(ir);
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0]).toEqual({ role: 'tool', content: 'Result 1', toolCallId: 'tc_1' });
    expect(roundTripped[1]).toEqual({ role: 'tool', content: 'Result 2', toolCallId: 'tc_2' });
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
