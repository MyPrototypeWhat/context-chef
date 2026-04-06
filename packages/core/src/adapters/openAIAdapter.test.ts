import { describe, expect, it } from 'vitest';
import type { Message, OpenAIPayload } from '../types';
import { OpenAIAdapter } from './openAIAdapter';

interface OAIMsg {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  thinking?: unknown;
  redacted_thinking?: unknown;
  _cache_breakpoint?: unknown;
}

/**
 * Round-trips the SDK's complex union type through JSON so tests can work with
 * a simple plain-object shape for structural assertions. JSON.parse returns `any`,
 * which TypeScript allows assigning to `OAIMsg[]` without a cast.
 */
function toPlainMessages(payload: OpenAIPayload): OAIMsg[] {
  const plain: OAIMsg[] = JSON.parse(JSON.stringify(payload.messages));
  return plain;
}

const adapter = new OpenAIAdapter();

describe('OpenAIAdapter', () => {
  it('passes through basic messages as-is', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'Thanks' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
    expect(msgs[1]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
    expect(msgs[3]).toMatchObject({ role: 'user', content: 'Thanks' });
  });

  it('strips _cache_breakpoint from messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello', _cache_breakpoint: true },
      { role: 'user', content: 'Next' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs[0]._cache_breakpoint).toBeUndefined();
  });

  it('strips thinking and redacted_thinking from messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Answer',
        thinking: { thinking: 'internal', signature: 'sig' },
        redacted_thinking: { data: 'blob' },
      },
      { role: 'user', content: 'Next' },
    ];
    const result = adapter.compile([...messages]);
    const assistant = toPlainMessages(result).find((m) => m.role === 'assistant');

    expect(assistant?.thinking).toBeUndefined();
    expect(assistant?.redacted_thinking).toBeUndefined();
    expect(assistant?.content).toBe('Answer');
  });

  it('preserves tool_calls on assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Check weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: 'tool', content: '{"temp":20}', tool_call_id: 'c1' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs).toHaveLength(3);
    expect(msgs[1].tool_calls).toHaveLength(1);
    expect(msgs[1].tool_calls?.[0].function.name).toBe('get_weather');
    expect(msgs[2].tool_call_id).toBe('c1');
  });

  it('degrades trailing assistant prefill to enforcement note on last user/system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Help me.' },
      { role: 'assistant', content: '<thinking>\n1. ' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    // Prefill message is removed
    expect(msgs).toHaveLength(2);
    // Last user/system message gets the enforcement note
    expect(msgs[1].content).toContain('Help me.');
    expect(msgs[1].content).toContain('SYSTEM INSTRUCTION: Your response MUST start verbatim');
    expect(msgs[1].content).toContain('<thinking>\n1. ');
  });

  it('does not degrade trailing assistant with tool_calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Do something' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'action', arguments: '{}' } }],
      },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs).toHaveLength(2);
    expect(msgs[1].tool_calls).toHaveLength(1);
  });

  it('does not degrade when trailing message is not assistant', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('Hello');
  });

  it('handles empty message array', () => {
    const result = adapter.compile([]);
    expect(result.messages).toHaveLength(0);
  });

  it('degrades prefill onto system message when no user message exists', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt.' },
      { role: 'assistant', content: 'Start with this.' },
    ];
    const result = adapter.compile([...messages]);
    const msgs = toPlainMessages(result);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('System prompt.');
    expect(msgs[0].content).toContain('Start with this.');
  });
});
