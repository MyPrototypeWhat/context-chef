/**
 * E11: thinking field — Adapter mapping tests
 *
 * Covers:
 * - AnthropicAdapter: thinking → ThinkingBlockParam (with/without signature)
 * - AnthropicAdapter: redacted_thinking → RedactedThinkingBlockParam
 * - AnthropicAdapter: thinking + tool_calls combination
 * - OpenAIAdapter: thinking silently stripped
 * - GeminiAdapter: thinking → { text, thought: true } TextPart
 * - GeminiAdapter: redacted_thinking silently stripped
 *
 * Note: OpenAI and Gemini adapters have prefill degradation logic that pops
 * a trailing plain assistant/model message. Tests that inspect assistant output
 * must include a trailing user turn so the assistant message is NOT last.
 */

import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { OpenAIAdapter } from './openAIAdapter';
import type { Message } from '../types';

// ─── Local inspection types (avoid as-unknown casts in assertions) ──────────

/** Shape of an Anthropic content block for assertion purposes. */
interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
}

/** OpenAI message shape augmented with fields we're verifying are absent. */
interface OpenAIAssertMsg {
  role: string;
  content?: string;
  thinking?: unknown;
  redacted_thinking?: unknown;
  _cache_breakpoint?: unknown;
}

/** Gemini part shape augmented with the thought flag. */
interface GeminiAssertPart {
  text?: string;
  thought?: boolean;
  functionCall?: unknown;
}

// ─── Adapters ───────────────────────────────────────────────────────────────

const anthropic = new AnthropicAdapter();
const openai = new OpenAIAdapter();
const gemini = new GeminiAdapter();

// ─── AnthropicAdapter ──────────────────────────────────────────────────────

describe('AnthropicAdapter — thinking field', () => {
  it('maps thinking to ThinkingBlockParam before text block', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'The answer is 42.',
        thinking: { thinking: 'Let me reason about this...', signature: 'sig_abc123' },
      },
    ];
    const result = anthropic.compile(messages);
    const msg = result.messages[0];
    expect(msg.role).toBe('assistant');
    const content = msg.content as AnthropicBlock[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('thinking');
    expect(content[0].thinking).toBe('Let me reason about this...');
    expect(content[0].signature).toBe('sig_abc123');
    expect(content[1].type).toBe('text');
    expect(content[1].text).toBe('The answer is 42.');
  });

  it('uses empty string signature when signature is omitted', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Done.',
        thinking: { thinking: 'Thinking without sig' },
      },
    ];
    const result = anthropic.compile(messages);
    const content = result.messages[0].content as AnthropicBlock[];
    expect(content[0].type).toBe('thinking');
    expect(content[0].signature).toBe('');
  });

  it('maps redacted_thinking to RedactedThinkingBlockParam before text block', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Result.',
        redacted_thinking: { data: 'encrypted_blob_xyz' },
      },
    ];
    const result = anthropic.compile(messages);
    const content = result.messages[0].content as AnthropicBlock[];
    expect(content[0].type).toBe('redacted_thinking');
    expect(content[0].data).toBe('encrypted_blob_xyz');
    expect(content[1]).toMatchObject({ type: 'text', text: 'Result.' });
  });

  it('prepends thinking before tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        thinking: { thinking: 'I should call a tool.', signature: 'sig_tool' },
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"foo"}' },
          },
        ],
      },
    ];
    const result = anthropic.compile(messages);
    const content = result.messages[0].content as AnthropicBlock[];
    expect(content[0].type).toBe('thinking');
    expect(content[1].type).toBe('text');
    expect(content[2].type).toBe('tool_use');
  });

  it('does not add thinking block when thinking is absent', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'Hello!' }];
    const result = anthropic.compile(messages);
    const content = result.messages[0].content as AnthropicBlock[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
  });

  it('includes both thinking and redacted_thinking when both are present', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Final.',
        thinking: { thinking: 'visible thought', signature: 'sig_v' },
        redacted_thinking: { data: 'hidden_blob' },
      },
    ];
    const result = anthropic.compile(messages);
    const content = result.messages[0].content as AnthropicBlock[];
    expect(content[0].type).toBe('thinking');
    expect(content[1].type).toBe('redacted_thinking');
    expect(content[2].type).toBe('text');
  });
});

// ─── OpenAIAdapter ─────────────────────────────────────────────────────────

describe('OpenAIAdapter — thinking field', () => {
  // OpenAI prefill degradation pops the trailing plain assistant message.
  // All tests here put a user message AFTER the assistant to prevent this.

  it('strips thinking from assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hi there!',
        thinking: { thinking: 'How should I respond?', signature: 'sig_x' },
      },
      { role: 'user', content: 'Thanks' }, // prevent prefill degradation
    ];
    const result = openai.compile(messages);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant') as OpenAIAssertMsg | undefined;
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) return;
    expect(assistantMsg.thinking).toBeUndefined();
    expect(assistantMsg.content).toBe('Hi there!');
  });

  it('strips redacted_thinking from assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Q' },
      {
        role: 'assistant',
        content: 'A',
        redacted_thinking: { data: 'blob' },
      },
      { role: 'user', content: 'Next' }, // prevent prefill degradation
    ];
    const result = openai.compile(messages);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant') as OpenAIAssertMsg | undefined;
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) return;
    expect(assistantMsg.redacted_thinking).toBeUndefined();
  });

  it('strips _cache_breakpoint and thinking together', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'answer',
        _cache_breakpoint: true,
        thinking: { thinking: 'internal' },
      },
      { role: 'user', content: 'cont' }, // prevent prefill degradation
    ];
    const result = openai.compile(messages);
    const assistantMsg = result.messages.find((m) => m.role === 'assistant') as OpenAIAssertMsg | undefined;
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) return;
    expect(assistantMsg._cache_breakpoint).toBeUndefined();
    expect(assistantMsg.thinking).toBeUndefined();
  });
});

// ─── GeminiAdapter ─────────────────────────────────────────────────────────

describe('GeminiAdapter — thinking field', () => {
  // Gemini prefill degradation pops the trailing plain model message (1 text part).
  // Tests that inspect a model message add a user turn AFTER to prevent this.

  it('maps thinking to a thought:true TextPart before the text part', () => {
    // A model message with 2+ parts is NOT treated as prefill — no trailing user needed.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'The answer is 7.',
        thinking: { thinking: 'Let me calculate...' },
      },
    ];
    const result = gemini.compile(messages);
    const modelMsg = result.messages[0];
    expect(modelMsg.role).toBe('model');
    const parts = modelMsg.parts as GeminiAssertPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0].thought).toBe(true);
    expect(parts[0].text).toBe('Let me calculate...');
    expect(parts[1].text).toBe('The answer is 7.');
    expect(parts[1].thought).toBeUndefined();
  });

  it('prepends thought part before functionCall parts', () => {
    // tool_calls → not a plain text message → no prefill degradation
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        thinking: { thinking: 'I will call a tool.' },
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'fetch', arguments: '{"url":"x"}' } },
        ],
      },
    ];
    const result = gemini.compile(messages);
    const parts = result.messages[0].parts as GeminiAssertPart[];
    expect(parts[0].thought).toBe(true);
    expect(parts[0].text).toBe('I will call a tool.');
    expect(parts[parts.length - 1]).toHaveProperty('functionCall');
  });

  it('silently discards redacted_thinking (no Gemini equivalent)', () => {
    // Without thinking, this is a plain 1-part model message → prefill degradation fires.
    // Add a user turn after to keep the model message in place.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Answer.',
        redacted_thinking: { data: 'secret_blob' },
      },
      { role: 'user', content: 'ok' }, // prevent prefill degradation
    ];
    const result = gemini.compile(messages);
    const modelMsg = result.messages.find((m) => m.role === 'model');
    expect(modelMsg).toBeDefined();
    if (!modelMsg) return;
    const parts = modelMsg.parts as GeminiAssertPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe('Answer.');
    expect(parts[0].thought).toBeUndefined();
  });

  it('does not add thought part when thinking is absent', () => {
    // Plain 1-part model message → needs a trailing user to prevent degradation.
    const messages: Message[] = [
      { role: 'assistant', content: 'Normal response.' },
      { role: 'user', content: 'ok' }, // prevent prefill degradation
    ];
    const result = gemini.compile(messages);
    const modelMsg = result.messages.find((m) => m.role === 'model');
    expect(modelMsg).toBeDefined();
    if (!modelMsg) return;
    const parts = modelMsg.parts as GeminiAssertPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0].thought).toBeUndefined();
  });
});
