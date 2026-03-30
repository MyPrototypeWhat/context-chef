import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { Message } from '@context-chef/core';
import { describe, expect, it } from 'vitest';
import { fromAISDK, toAISDK } from '../src/adapter';

describe('fromAISDK', () => {
  it('converts system messages', () => {
    const prompt: LanguageModelV3Prompt = [{ role: 'system', content: 'You are helpful.' }];
    const result = fromAISDK(prompt);
    expect(result).toEqual([{ role: 'system', content: 'You are helpful.' }]);
  });

  it('converts user messages with text parts', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
      },
    ];
    const result = fromAISDK(prompt);
    expect(result[0].content).toBe('Hello\nWorld');
    expect(result[0]._originalContent).toBeDefined();
  });

  it('stores original content including file parts', () => {
    const filePart = {
      type: 'file' as const,
      data: 'base64data',
      mediaType: 'image/png',
    };
    const content = [{ type: 'text' as const, text: 'Look at this' }, filePart];
    const prompt: LanguageModelV3Prompt = [{ role: 'user', content }];
    const result = fromAISDK(prompt);
    expect(result[0].content).toBe('Look at this');
    expect(result[0]._originalContent).toEqual(content);
  });

  it('converts assistant messages with text + tool calls', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'Tokyo' },
          },
        ],
      },
    ];
    const result = fromAISDK(prompt);
    expect(result[0].content).toBe('Let me check.');
    expect(result[0].tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      },
    ]);
    expect(result[0]._originalContent).toBeDefined();
  });

  it('converts assistant reasoning to thinking', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I need to think...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ];
    const result = fromAISDK(prompt);
    expect(result[0].thinking).toEqual({ thinking: 'I need to think...' });
    expect(result[0].content).toBe('Here is my answer.');
  });

  it('converts tool messages to individual IR messages', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            output: { type: 'text', value: 'Sunny, 25°C' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call_2',
            toolName: 'get_time',
            output: { type: 'text', value: '14:30' },
          },
        ],
      },
    ];
    const result = fromAISDK(prompt);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'tool',
      content: 'Sunny, 25°C',
      tool_call_id: 'call_1',
    });
    expect(result[0]._originalContent).toBeDefined();
    expect(result[1]).toMatchObject({
      role: 'tool',
      content: '14:30',
      tool_call_id: 'call_2',
    });
  });

  it('handles json tool result output', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'query_db',
            output: { type: 'json', value: { rows: 42 } },
          },
        ],
      },
    ];
    const result = fromAISDK(prompt);
    expect(result[0].content).toBe('{"rows":42}');
  });
});

describe('toAISDK', () => {
  it('converts system messages', () => {
    const messages: Message[] = [{ role: 'system', content: 'Be helpful.' }];
    const result = toAISDK(messages);
    expect(result).toEqual([{ role: 'system', content: 'Be helpful.' }]);
  });

  it('falls back to text part when no _originalContent (e.g. compression summary)', () => {
    const messages: Message[] = [{ role: 'user', content: 'Hi there' }];
    const result = toAISDK(messages);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi there' }] }]);
  });

  it('uses _originalContent for lossless round-trip', () => {
    const originalContent = [
      { type: 'text' as const, text: 'See this' },
      { type: 'file' as const, data: 'base64data', mediaType: 'image/png' },
    ];
    const messages: Message[] = [
      { role: 'user', content: 'See this', _originalContent: originalContent },
    ];
    const result = toAISDK(messages);
    expect(result[0]).toMatchObject({ role: 'user', content: originalContent });
  });

  it('coalesces consecutive tool messages', () => {
    const part1 = {
      type: 'tool-result' as const,
      toolCallId: 'call_1',
      toolName: 'tool_a',
      output: { type: 'text' as const, value: 'result1' },
    };
    const part2 = {
      type: 'tool-result' as const,
      toolCallId: 'call_2',
      toolName: 'tool_b',
      output: { type: 'text' as const, value: 'result2' },
    };
    const messages: Message[] = [
      { role: 'tool', content: 'result1', tool_call_id: 'call_1', _originalContent: [part1] },
      { role: 'tool', content: 'result2', tool_call_id: 'call_2', _originalContent: [part2] },
    ];
    const result = toAISDK(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    if (result[0].role === 'tool') {
      expect(result[0].content).toHaveLength(2);
      expect(result[0].content[0].toolCallId).toBe('call_1');
      expect(result[0].content[1].toolCallId).toBe('call_2');
    }
  });

  it('falls back for tool messages without _originalContent', () => {
    const messages: Message[] = [{ role: 'tool', content: 'some output', tool_call_id: 'call_1' }];
    const result = toAISDK(messages);
    if (result[0].role === 'tool') {
      expect(result[0].content[0].output).toEqual({
        type: 'text',
        value: 'some output',
      });
    }
  });
});

describe('round-trip', () => {
  it('preserves a full conversation through fromAISDK → toAISDK', () => {
    const original: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
      { role: 'assistant', content: [{ type: 'text', text: '4' }] },
      { role: 'user', content: [{ type: 'text', text: 'Thanks!' }] },
    ];

    const ir = fromAISDK(original);
    const roundTripped = toAISDK(ir);
    expect(roundTripped).toEqual(original);
  });

  it('preserves tool call + result through round-trip', () => {
    const original: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'search',
            input: { query: 'test' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'search',
            output: { type: 'text', value: 'Found 5 results' },
          },
        ],
      },
    ];

    const ir = fromAISDK(original);
    const roundTripped = toAISDK(ir);
    expect(roundTripped).toEqual(original);
  });

  it('preserves file parts through round-trip', () => {
    const original: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this' },
          { type: 'file', data: 'base64data', mediaType: 'image/png' },
        ],
      },
    ];

    const ir = fromAISDK(original);
    const roundTripped = toAISDK(ir);
    expect(roundTripped).toEqual(original);
  });

  it('uses modified content when Janitor changes it (e.g. compact)', () => {
    const original: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'run_cmd',
            output: { type: 'text', value: 'very long output here' },
          },
        ],
      },
    ];

    const ir = fromAISDK(original);
    // Simulate what Janitor.compact() does: replace content
    ir[0].content = '[Tool result cleared]';

    const roundTripped = toAISDK(ir);
    if (roundTripped[0].role === 'tool') {
      const part = roundTripped[0].content[0];
      if (part.type === 'tool-result') {
        expect(part.output).toEqual({ type: 'text', value: '[Tool result cleared]' });
        expect(part.toolName).toBe('run_cmd');
      }
    }
  });

  it('preserves providerOptions through round-trip', () => {
    const original: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ];

    const ir = fromAISDK(original);
    const roundTripped = toAISDK(ir);
    expect(roundTripped).toEqual(original);
  });
});
