import { describe, expect, it } from 'vitest';
import type { AnthropicPayload, Message } from '../types';
import { AnthropicAdapter } from './anthropicAdapter';

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  tool_use_id?: string;
  content?: string;
  id?: string;
  name?: string;
  input?: unknown;
  cache_control?: { type: string };
}

/**
 * Round-trips the SDK's complex union type through JSON so tests can work with
 * a simple plain-object shape for structural assertions. JSON.parse returns `any`,
 * which TypeScript allows assigning to plain interfaces without an explicit cast.
 */
function getContentBlocks(result: AnthropicPayload, messageIndex = 0): AnthropicBlock[] {
  const plain: AnthropicBlock[] = JSON.parse(JSON.stringify(result.messages[messageIndex].content));
  return plain;
}

function getSystemBlock(result: AnthropicPayload, index = 0): AnthropicBlock {
  const plain: AnthropicBlock = JSON.parse(JSON.stringify(result.system?.[index]));
  return plain;
}

const adapter = new AnthropicAdapter();

describe('AnthropicAdapter', () => {
  it('separates system messages into system array', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = adapter.compile([...messages]);

    expect(result.system).toHaveLength(2);
    expect(result.system?.[0]).toMatchObject({ type: 'text', text: 'You are helpful.' });
    expect(result.system?.[1]).toMatchObject({ type: 'text', text: 'Be concise.' });
    expect(result.messages).toHaveLength(1);
  });

  it('omits system when no system messages exist', () => {
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    const result = adapter.compile([...messages]);
    expect(result.system).toBeUndefined();
  });

  it('maps user and assistant roles directly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const result = adapter.compile([...messages]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('maps tool role to user with tool_result block', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: '{"result": "ok"}',
        tool_call_id: 'call_1',
      },
    ];
    const result = adapter.compile([...messages]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    const content = getContentBlocks(result);
    expect(content[0].type).toBe('tool_result');
    expect(content[0].tool_use_id).toBe('call_1');
    expect(content[0].content).toBe('{"result": "ok"}');
  });

  it('uses empty string for tool_call_id when missing', () => {
    const messages: Message[] = [{ role: 'tool', content: 'result' }];
    const result = adapter.compile([...messages]);
    const content = getContentBlocks(result);
    expect(content[0].tool_use_id).toBe('');
  });

  it('converts tool_calls to tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
          },
        ],
      },
    ];
    const result = adapter.compile([...messages]);
    const content = getContentBlocks(result);

    expect(content).toHaveLength(2); // text + tool_use
    expect(content[0]).toMatchObject({ type: 'text', text: '' });
    expect(content[1]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'London' },
    });
  });

  it('handles multiple parallel tool_calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Checking...',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
    ];
    const result = adapter.compile([...messages]);
    const content = getContentBlocks(result);

    expect(content).toHaveLength(3); // text + 2 tool_use
    expect(content[0].type).toBe('text');
    expect(content[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'a' });
    expect(content[2]).toMatchObject({ type: 'tool_use', id: 'c2', name: 'b' });
  });

  it('sets cache_control on system messages with _cache_breakpoint', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Cached system prompt', _cache_breakpoint: true },
      { role: 'user', content: 'Hi' },
    ];
    const result = adapter.compile([...messages]);

    const sysBlock = getSystemBlock(result);
    expect(sysBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sets cache_control on user/assistant text with _cache_breakpoint', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Important message', _cache_breakpoint: true },
    ];
    const result = adapter.compile([...messages]);
    const content = getContentBlocks(result);

    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not set cache_control when _cache_breakpoint is absent', () => {
    const messages: Message[] = [{ role: 'system', content: 'Normal prompt' }];
    const result = adapter.compile([...messages]);
    const sysBlock = getSystemBlock(result);
    expect(sysBlock.cache_control).toBeUndefined();
  });

  it('handles complete multi-turn conversation with tool calling', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a weather assistant.' },
      { role: 'user', content: 'Weather in London?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
          },
        ],
      },
      { role: 'tool', content: '{"temp":15}', tool_call_id: 'c1' },
      { role: 'assistant', content: 'It is 15°C in London.' },
      { role: 'user', content: 'Thanks!' },
    ];
    const result = adapter.compile([...messages]);

    expect(result.system).toHaveLength(1);
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant'); // tool_calls
    expect(result.messages[2].role).toBe('user'); // tool_result
    expect(result.messages[3].role).toBe('assistant'); // response
    expect(result.messages[4].role).toBe('user'); // follow-up
  });
});
