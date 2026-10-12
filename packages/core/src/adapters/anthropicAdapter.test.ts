import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import type { AnthropicPayload, Message } from '../types';
import { estimateObject } from '../utils/tokenUtils';
import {
  AnthropicAdapter,
  type AnthropicCompactionBlock,
  anthropicCompactionMessage,
  anthropicServerContextManagement,
  fromAnthropic,
  withoutThinking,
} from './anthropicAdapter';
import { OpenAIAdapter } from './openAIAdapter';

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

describe('anthropicServerContextManagement', () => {
  it('defaults to a single compact_20260112 edit with its beta', () => {
    expect(anthropicServerContextManagement()).toEqual({
      context_management: { edits: [{ type: 'compact_20260112' }] },
      betas: ['compact-2026-01-12'],
    });
  });

  it('returns a fresh default object per call (callers may mutate the payload)', () => {
    const a = anthropicServerContextManagement().context_management;
    const b = anthropicServerContextManagement().context_management;
    expect(a).not.toBe(b);
  });

  it('passes an explicit config through verbatim', () => {
    const config = { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens' } }] };
    const result = anthropicServerContextManagement(config);
    expect(result.context_management).toBe(config);
    expect(result.betas).toEqual(['compact-2026-01-12']);
  });

  it('maps non-compact edit types to the context-management beta', () => {
    const result = anthropicServerContextManagement({
      edits: [{ type: 'clear_tool_uses_20250919' }],
    });
    expect(result.betas).toEqual(['context-management-2025-06-27']);
  });

  it('dedupes betas across edits and ignores type-less entries', () => {
    const result = anthropicServerContextManagement({
      edits: [
        { type: 'compact_20260112' },
        { type: 'clear_tool_uses_20250919' },
        { type: 'clear_thinking_20251015' },
        {},
      ],
    });
    expect(result.betas).toEqual(['compact-2026-01-12', 'context-management-2025-06-27']);
  });

  it('yields no betas for a config without edits', () => {
    expect(anthropicServerContextManagement({}).betas).toEqual([]);
  });
});

// Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 sign each thinking block over
// everything before it; any byte the round-trip changes in an earlier turn
// fails that check. An unmodified parsed message must replay as it came in.
describe('fromAnthropic → AnthropicAdapter verbatim replay', () => {
  function roundTrip(messages: MessageParam[], edit?: (history: Message[]) => Message[]) {
    const { history } = fromAnthropic(messages);
    return new AnthropicAdapter().compile(edit ? edit(history) : history);
  }

  const toolTurn: MessageParam[] = [
    { role: 'user', content: 'Compare both cities.' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'SIG_A' },
        { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Oslo' } },
        { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Rome' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '4°C' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '19°C' },
        { type: 'text', text: 'Also mention humidity.' },
      ],
    },
  ];

  it('keeps every thinking block of an assistant turn', () => {
    const result = roundTrip([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_A' },
          { type: 'thinking', thinking: '', signature: 'SIG_B' },
          { type: 'text', text: 'Answer.' },
        ],
      },
    ]);

    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'thinking', thinking: '', signature: 'SIG_A' },
      { type: 'thinking', thinking: '', signature: 'SIG_B' },
      { type: 'text', text: 'Answer.' },
    ]);
  });

  it('keeps separate text blocks separate', () => {
    const result = roundTrip([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    ]);

    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'text', text: 'Part one.' },
      { type: 'text', text: 'Part two.' },
    ]);
  });

  it('does not add an empty text block to a tool-only assistant turn', () => {
    const result = roundTrip(toolTurn);

    expect(getContentBlocks(result, 1).map((b) => b.type)).toEqual([
      'thinking',
      'tool_use',
      'tool_use',
    ]);
  });

  it('replays parallel tool results and the user text after them as one user message', () => {
    const result = roundTrip(toolTurn);

    expect(result.messages).toHaveLength(3);
    expect(getContentBlocks(result, 2)).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '4°C' },
      { type: 'tool_result', tool_use_id: 'call_2', content: '19°C' },
      { type: 'text', text: 'Also mention humidity.' },
    ]);
  });

  it('replays block types the IR does not model', () => {
    const serverToolTurn = [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
      { type: 'thinking', thinking: '', signature: 'SIG_A' },
      { type: 'text', text: 'Found it.' },
    ];
    const result = roundTrip([
      { role: 'user', content: 'search' },
      { role: 'assistant', content: serverToolTurn } as unknown as MessageParam,
    ]);

    expect(getContentBlocks(result, 1)).toEqual(serverToolTurn);
  });

  it('keeps the signature of a compaction block', () => {
    const compaction = { type: 'compaction', content: 'Summary so far.', signature: 'SIG_C' };
    const result = roundTrip([
      { role: 'assistant', content: [compaction] } as unknown as MessageParam,
      { role: 'user', content: 'next' },
    ]);

    expect(JSON.stringify(result.messages)).toContain('"signature":"SIG_C"');
  });

  // On-demand compaction (compact-2026-09-04): the block replaces everything it
  // summarized and must lead `messages`, or the API rejects the request.
  const leadingCompaction = [
    {
      role: 'assistant',
      content: [{ type: 'compaction', content: 'Summary so far.', signature: 'SIG_C' }],
    },
    { role: 'user', content: 'Now do the same for Ingredient.' },
  ] as unknown as MessageParam[];

  it('lets a compaction block that opens the history stay first', () => {
    const result = roundTrip(leadingCompaction);

    expect(result.messages[0].role).toBe('assistant');
    expect(getContentBlocks(result, 0)[0].type).toBe('compaction');
  });

  it('still opens with a user turn on targets without compaction blocks', async () => {
    const { history } = fromAnthropic(leadingCompaction);
    const payload = new OpenAIAdapter().compile(history);

    expect(payload.messages[0].role).toBe('user');
  });

  it('rebuilds a tool result whose IR content was changed', () => {
    const result = roundTrip(toolTurn, (history) =>
      history.map((m) => (m.tool_call_id === 'call_1' ? { ...m, content: '[cleared]' } : m)),
    );

    const blocks = JSON.stringify(result.messages);
    expect(blocks).toContain('[cleared]');
    expect(blocks).not.toContain('4°C');
  });

  it('drops replayed thinking once the IR thinking was stripped', () => {
    const result = roundTrip(toolTurn, (history) =>
      history.map((m) => {
        if (m.role !== 'assistant') return m;
        const { thinking: _stripped, ...rest } = m;
        return rest;
      }),
    );

    expect(JSON.stringify(result.messages)).not.toContain('SIG_A');
  });

  it('replays every other block of the original once withoutThinking took the thinking out', () => {
    const result = roundTrip(toolTurn, (history) =>
      history.map((m) => (m.role === 'assistant' ? withoutThinking(m) : m)),
    );

    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Oslo' } },
      { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Rome' } },
    ]);
    expect(getContentBlocks(result, 2)).toHaveLength(3);
  });

  it('never replays an original that held nothing but thinking as an empty message', () => {
    const result = roundTrip(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'SIG_A' }] },
      ],
      (history) => history.map((m) => (m.role === 'assistant' ? withoutThinking(m) : m)),
    );

    expect(getContentBlocks(result, 1)).not.toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SIG_A');
  });

  it('leaves a message its original no longer matches to the IR rebuild, without its thinking', () => {
    const result = roundTrip(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'SIG_A' },
            { type: 'text', text: 'Answer.' },
          ],
        },
      ],
      (history) =>
        history.map((m) =>
          m.role === 'assistant' ? withoutThinking({ ...m, content: 'Edited.' }) : m,
        ),
    );

    expect(getContentBlocks(result, 1)).toEqual([{ type: 'text', text: 'Edited.' }]);
  });

  it('rebuilds the rest of a user message when one of its parts was removed', () => {
    const result = roundTrip(toolTurn, (history) =>
      history.filter((m) => m.tool_call_id !== 'call_2'),
    );

    const blocks = JSON.stringify(result.messages);
    expect(blocks).toContain('4°C');
    expect(blocks).not.toContain('19°C');
  });

  it("replaces the original's cache breakpoints with the chef's", () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_A' },
          { type: 'text', text: 'a' },
        ],
      },
    ];

    const result = roundTrip(messages, (history) =>
      history.map((m) => (m.role === 'assistant' ? { ...m, _cache_breakpoint: true } : m)),
    );

    expect(getContentBlocks(result, 0)[0].cache_control).toBeUndefined();
    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'thinking', thinking: '', signature: 'SIG_A' },
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not count the stored original toward the token estimate', () => {
    const { history } = fromAnthropic(toolTurn);
    const withoutOrigin = history.map(({ _anthropic_origin: _origin, ...msg }) => msg);

    expect(estimateObject(history)).toBe(estimateObject(withoutOrigin));
  });

  it('does not let payload edits leak back into the parsed history', () => {
    const { history } = fromAnthropic(toolTurn);
    const first = new AnthropicAdapter().compile(history);
    (getFirstBlock(first, 2) as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };

    const second = new AnthropicAdapter().compile(history);
    expect(getContentBlocks(second, 2)[0].cache_control).toBeUndefined();
  });
});

function getFirstBlock(result: AnthropicPayload, messageIndex: number): unknown {
  const content = result.messages[messageIndex].content;
  return Array.isArray(content) ? content[0] : undefined;
}

describe('AnthropicAdapter — turn-scoped system messages', () => {
  const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21';
  const reminder = 'Request independent reads in one turn.';

  it('sends clear_at on a positional system message marked _clear_at, with its beta', () => {
    const result = new AnthropicAdapter().compile([
      { role: 'user', content: 'Fix the failing test.' },
      { role: 'system', content: reminder, _positional: true, _clear_at: 'next_user_message' },
    ]);

    expect(result.messages[1]).toEqual({
      role: 'system',
      clear_at: 'next_user_message',
      content: [{ type: 'text', text: reminder }],
    });
    expect(result.betas).toEqual([CLEAR_AT_BETA]);
  });

  it('asks for no beta when no message is turn-scoped', () => {
    const result = new AnthropicAdapter().compile([
      { role: 'user', content: 'Fix the failing test.' },
      { role: 'system', content: reminder, _positional: true },
    ]);

    expect(result).not.toHaveProperty('betas');
    expect(JSON.stringify(result)).not.toContain('clear_at');
  });

  it('puts a breakpoint meant for a turn-scoped message on the turn before it', () => {
    // A cleared message is in no cache key, and the API rejects cache_control on one.
    const result = new AnthropicAdapter().compile([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
      { role: 'system', content: 'Exit 137.', _positional: true, _clear_at: 'next_user_message' },
      {
        role: 'system',
        content: reminder,
        _positional: true,
        _clear_at: 'next_user_message',
        _cache_breakpoint: true,
      },
    ]);

    expect(getContentBlocks(result, 2)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        content: 'result',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(getContentBlocks(result, 3)).toEqual([{ type: 'text', text: 'Exit 137.' }]);
    expect(getContentBlocks(result, 4)).toEqual([{ type: 'text', text: reminder }]);
  });

  it('drops clear_at from a turn-scoped message it has to hoist', () => {
    const result = new AnthropicAdapter({ logger: { warn: vi.fn() } }).compile([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: reminder, _positional: true, _clear_at: 'next_user_message' },
    ]);

    expect(result.system).toEqual([{ type: 'text', text: reminder }]);
    expect(result).not.toHaveProperty('betas');
  });
});

describe('fromAnthropic — keepPositionalSystem', () => {
  const sent = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Fix the failing test.' },
    { role: 'system', content: [{ type: 'text', text: 'The repo uses pnpm.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }] },
    { role: 'user', content: 'Go on.' },
    {
      role: 'system',
      clear_at: 'next_user_message',
      content: [{ type: 'text', text: 'Request independent reads in one turn.' }],
    },
  ] as unknown as MessageParam[];

  const withoutOrigin = (history: Message[]) =>
    history.map(({ _anthropic_origin: _origin, ...message }) => message);

  it("keeps the host's own mid-stream system messages where they were", () => {
    const { system, history } = fromAnthropic(sent, undefined, { keepPositionalSystem: true });

    expect(system).toEqual([{ role: 'system', content: 'You are helpful.' }]);
    expect(withoutOrigin(history)).toEqual([
      { role: 'user', content: 'Fix the failing test.' },
      { role: 'system', content: 'The repo uses pnpm.', _positional: true },
      { role: 'assistant', content: 'Running the tests.' },
      { role: 'user', content: 'Go on.' },
      {
        role: 'system',
        content: 'Request independent reads in one turn.',
        _positional: true,
        _clear_at: 'next_user_message',
      },
    ]);
  });

  it('reads clear_at "never" as a system message that stays', () => {
    const { history } = fromAnthropic(
      [
        { role: 'user', content: 'q' },
        { role: 'system', clear_at: 'never', content: 'Keep answers short.' },
      ] as unknown as MessageParam[],
      undefined,
      { keepPositionalSystem: true },
    );

    expect(history[1]).toEqual({
      role: 'system',
      content: 'Keep answers short.',
      _positional: true,
    });
  });

  it('round-trips a payload with positional and turn-scoped system messages', () => {
    const anthropic = new AnthropicAdapter();
    const payload = anthropic.compile([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'The repo uses pnpm.', _positional: true },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'Go on.' },
      { role: 'system', content: 'Exit 137.', _positional: true, _clear_at: 'next_user_message' },
    ]);

    const back = fromAnthropic(payload.messages, payload.system, { keepPositionalSystem: true });

    expect(anthropic.compile([...back.system, ...back.history])).toEqual(payload);
  });

  it('skips them by default, as 4.x does', () => {
    const { history } = fromAnthropic(sent);

    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('anthropicCompactionMessage', () => {
  const block: AnthropicCompactionBlock = {
    type: 'compaction',
    content: 'Summary so far.',
    signature: 'SIG_C',
    tool_changes: [{ type: 'tool_removal', name: 'grep' }],
  };

  it('replays the signed block verbatim, first in messages', () => {
    const result = new AnthropicAdapter().compile([
      anthropicCompactionMessage(block),
      {
        role: 'assistant',
        content: 'Kept.',
        thinking: { thinking: 'Kept reasoning.', signature: 'SIG_K' },
      },
      { role: 'user', content: 'Now do the same for Ingredient.' },
    ]);

    expect(result.messages[0]).toEqual({ role: 'assistant', content: [block] });
    expect(getContentBlocks(result, 1)).toEqual([
      { type: 'thinking', thinking: 'Kept reasoning.', signature: 'SIG_K' },
      { type: 'text', text: 'Kept.' },
    ]);
  });

  it('is the message fromAnthropic parses the block into', () => {
    const { history } = fromAnthropic([
      { role: 'assistant', content: [block] },
      { role: 'user', content: 'next' },
    ] as unknown as MessageParam[]);

    // history[0] is the placeholder user turn ensureValidHistory opens with.
    expect(anthropicCompactionMessage(block)).toEqual(history[1]);
    expect(anthropicCompactionMessage(block)).toMatchObject({
      role: 'assistant',
      content: '',
      _anthropic_compaction: 'Summary so far.',
      pinned: true,
      _anthropic_origin: { blocks: [block], part: 0, parts: 1 },
    });
  });

  it("does not share the caller's block", () => {
    const own = structuredClone(block);
    const message = anthropicCompactionMessage(own);
    own.content = 'Changed afterwards.';

    const result = new AnthropicAdapter().compile([message, { role: 'user', content: 'next' }]);
    expect(result.messages[0]).toEqual({ role: 'assistant', content: [block] });
  });

  it('inlines the summary on targets without compaction blocks', () => {
    const payload = new OpenAIAdapter().compile([
      anthropicCompactionMessage(block),
      { role: 'user', content: 'next' },
    ]);

    expect(JSON.stringify(payload)).toContain('Summary so far.');
    expect(JSON.stringify(payload)).not.toContain('SIG_C');
  });
});
