import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import type { AnthropicPayload, Message } from '../types';
import { AnthropicAdapter, fromAnthropic } from './anthropicAdapter';

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

// ═══════════════════════════════════════════════════════
// fromAnthropic — input adapter
// ═══════════════════════════════════════════════════════

describe('fromAnthropic', () => {
  it('extracts top-level system blocks', () => {
    const system: TextBlockParam[] = [
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'Be concise.' },
    ];
    const messages: MessageParam[] = [{ role: 'user', content: 'Hello' }];
    const result = fromAnthropic(messages, system);

    expect(result.system).toHaveLength(2);
    expect(result.system[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
    expect(result.system[1]).toMatchObject({ role: 'system', content: 'Be concise.' });
    expect(result.history).toHaveLength(1);
  });

  it('returns empty system when no system provided', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'Hi' }];
    const result = fromAnthropic(messages);

    expect(result.system).toHaveLength(0);
    expect(result.history).toHaveLength(1);
  });

  it('handles string content shorthand', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const { history } = fromAnthropic(messages);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Hi!' });
  });

  it('converts image blocks to attachments', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
          },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Look at this');
    expect(history[0].attachments).toHaveLength(1);
    expect(history[0].attachments?.[0]).toEqual({
      mediaType: 'image/png',
      data: 'abc123',
    });
  });

  it('converts URL image source', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/img.jpg' },
          },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history[0].attachments?.[0]).toEqual({
      mediaType: 'image/*',
      data: 'https://example.com/img.jpg',
    });
  });

  it('converts document blocks to attachments', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'pdf-data' },
          },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history[0].attachments?.[0]).toEqual({
      mediaType: 'application/pdf',
      data: 'pdf-data',
    });
  });

  it('converts tool_use blocks to tool_calls', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'get_weather',
            input: { city: 'London' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temp": 15}' }],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history[1].content).toBe('Let me check.');
    expect(history[1].tool_calls).toHaveLength(1);
    expect(history[1].tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"London"}' },
    });
  });

  it('flattens tool_result blocks to separate IR tool messages', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'get_weather',
            input: { city: 'London' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '{"temp": 15}',
          },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    const toolMsg = history.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      role: 'tool',
      content: '{"temp": 15}',
      tool_call_id: 'call_1',
    });
  });

  it('maps thinking blocks to IR thinking field', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'reason about this' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me reason...', signature: 'sig123' },
          { type: 'text', text: 'The answer is 42.' },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history[1].thinking).toEqual({
      thinking: 'Let me reason...',
      signature: 'sig123',
    });
    expect(history[1].content).toBe('The answer is 42.');
  });

  it('maps redacted_thinking blocks to IR', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'reason about this' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-blob' },
          { type: 'text', text: 'Result.' },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history[1].redacted_thinking).toEqual({ data: 'opaque-blob' });
  });

  it('preserves image-only messages (no text)', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'img-only' },
          },
        ],
      },
    ];
    const { history } = fromAnthropic(messages);

    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('');
    expect(history[0].attachments).toHaveLength(1);
  });

  // ─── Boundary sanitization ───
  it('injects placeholder for missing tool result at boundary', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'run',
            input: {},
          },
        ],
      },
      // Missing: tool_result for call_1
      { role: 'user', content: 'what happened?' },
    ];
    const { history } = fromAnthropic(messages);

    const placeholder = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    expect(placeholder?.content).toBe('[No tool result available]');
  });
});

// ═══════════════════════════════════════════════════════
// AnthropicAdapter.compile — attachments output
// ═══════════════════════════════════════════════════════

describe('AnthropicAdapter — attachments output', () => {
  it('converts image attachments to image content blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Look at this',
        attachments: [{ mediaType: 'image/png', data: 'base64imgdata' }],
      },
    ];
    const result = adapter.compile([...messages]);
    const blocks = getContentBlocks(result);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Look at this' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'base64imgdata' },
    });
  });

  it('converts URL image attachments to url source', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Check this',
        attachments: [{ mediaType: 'image/jpeg', data: 'https://example.com/img.jpg' }],
      },
    ];
    const result = adapter.compile([...messages]);
    const blocks = getContentBlocks(result);

    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.jpg' },
    });
  });

  it('converts document attachments to document content blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Read this PDF',
        attachments: [{ mediaType: 'application/pdf', data: 'pdfbase64' }],
      },
    ];
    const result = adapter.compile([...messages]);
    const blocks = getContentBlocks(result);

    expect(blocks[1]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'pdfbase64' },
    });
  });

  it('does not add attachment blocks when no attachments', () => {
    const messages: Message[] = [{ role: 'user', content: 'Plain text' }];
    const result = adapter.compile([...messages]);
    const blocks = getContentBlocks(result);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Plain text' });
  });
});

// ═══════════════════════════════════════════════════════
// AnthropicAdapter.compile — positional system messages
// ═══════════════════════════════════════════════════════

describe('AnthropicAdapter — positional system messages', () => {
  it('keeps a positional system message at its place immediately after a user turn', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'A new tool is available.', _positional: true },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'Use it' },
    ];
    const result = new AnthropicAdapter().compile([...messages]);

    expect(result.system).toHaveLength(1);
    expect(result.system?.[0]).toMatchObject({ type: 'text', text: 'You are helpful.' });
    expect(result.messages).toHaveLength(4);
    expect(result.messages[1].role).toBe('system');
    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'text', text: 'A new tool is available.' },
    ]);
  });

  it('hoists a positional system message that follows a plain assistant turn (API rejects it there)', () => {
    const warn = vi.fn();
    const adapter = new AnthropicAdapter({ logger: { warn } });
    const result = adapter.compile([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'system', content: 'A new tool is available.', _positional: true },
    ]);

    expect(result.messages.every((m) => (m as { role: string }).role !== 'system')).toBe(true);
    expect(result.system?.map((b) => b.text)).toContain('A new tool is available.');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hoists a positional system message sitting between a tool_use and its tool_result', () => {
    const adapter = new AnthropicAdapter({ logger: { warn: vi.fn() } });
    const result = adapter.compile([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'system', content: 'mid-gap note', _positional: true },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ]);

    // The gap between tool_use and tool_result must stay unbroken.
    expect(result.messages.every((m) => (m as { role: string }).role !== 'system')).toBe(true);
    expect(result.system?.map((b) => b.text)).toContain('mid-gap note');
  });

  it('keeps a positional system message directly after a tool result', () => {
    const result = new AnthropicAdapter().compile([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'system', content: 'after tools', _positional: true },
    ]);

    const last = result.messages[result.messages.length - 1] as { role: string };
    expect(last.role).toBe('system');
  });

  it('fromAnthropic skips mid-stream system messages instead of parsing them into history', () => {
    const out = new AnthropicAdapter().compile([
      { role: 'system', content: 'base' },
      { role: 'user', content: 'q' },
      { role: 'system', content: '<announcements>x</announcements>', _positional: true },
    ]);
    const back = fromAnthropic(out.messages, out.system);

    expect(back.system.map((m) => m.content)).toEqual(['base']);
    expect(back.history.every((m) => (m as { role: string }).role !== 'system')).toBe(true);
    expect(JSON.stringify(back.history)).not.toContain('announcements');
  });

  it('fromAnthropic routes a LEADING system message in `messages` into system (no data loss)', () => {
    // Callers who put their system prompt in messages[0] instead of the
    // `system` param must not lose the text — it is the prompt's system
    // layer, not positional channel output.
    const back = fromAnthropic([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ] as unknown as Parameters<typeof fromAnthropic>[0]);

    expect(back.system.map((m) => m.content)).toEqual(['You are helpful.']);
    expect(back.history).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps _cache_breakpoint on a positional system message to cache_control', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Tool withdrawn.', _positional: true, _cache_breakpoint: true },
    ];
    const result = new AnthropicAdapter().compile([...messages]);

    expect(getContentBlocks(result, 1)[0]).toMatchObject({
      type: 'text',
      text: 'Tool withdrawn.',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('never leaks _positional into the emitted message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Note.', _positional: true },
    ];
    const result = new AnthropicAdapter().compile([...messages]);

    expect(JSON.stringify(result)).not.toContain('_positional');
    expect(Object.keys(result.messages[1])).toEqual(['role', 'content']);
  });

  it('hoists a positional system message that precedes any user/tool message, warning once', () => {
    const warn = vi.fn();
    const adapterWithLogger = new AnthropicAdapter({ logger: { warn } });
    const messages: Message[] = [
      { role: 'system', content: 'Leading note.', _positional: true },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Second leading note.', _positional: true },
    ];
    const result = adapterWithLogger.compile([...messages]);

    expect(result.system).toHaveLength(1);
    expect(result.system?.[0]).toMatchObject({ type: 'text', text: 'Leading note.' });
    // The second one follows a user message, so it stays positional.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe('system');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('positional system message');
  });

  it('warns only once across compile() calls', () => {
    const warn = vi.fn();
    const adapterWithLogger = new AnthropicAdapter({ logger: { warn } });
    const messages: Message[] = [
      { role: 'system', content: 'Leading note.', _positional: true },
      { role: 'user', content: 'Hello' },
    ];
    adapterWithLogger.compile([...messages]);
    adapterWithLogger.compile([...messages]);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a tool message as opening the stream for positional placement', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'system', content: 'Tool set changed.', _positional: true },
    ];
    const warn = vi.fn();
    const result = new AnthropicAdapter({ logger: { warn } }).compile([...messages]);

    expect(result.system).toBeUndefined();
    expect(result.messages[3].role).toBe('system');
    expect(warn).not.toHaveBeenCalled();
  });
});
