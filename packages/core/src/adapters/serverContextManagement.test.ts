import type { MessageParam as SDKMessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Content as SDKContent } from '@google/generative-ai';
import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../index';
import { Janitor } from '../modules/janitor';
import type { AnthropicPayload, Message } from '../types';
import { AnthropicAdapter, fromAnthropic } from './anthropicAdapter';
import { fromGemini, GeminiAdapter } from './geminiAdapter';
import { OpenAIAdapter } from './openAIAdapter';

const makeTokenizer = (perMessage: number) => (messages: Message[]) => messages.length * perMessage;

// ═══════════════════════════════════════════════════════
// Anthropic compaction block passthrough
// ═══════════════════════════════════════════════════════

describe('Anthropic compaction block', () => {
  const compactionMessages = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'compaction', content: 'Summary of the earlier conversation.' },
        { type: 'text', text: 'Continuing from the summary.' },
      ],
    },
  ] as unknown as SDKMessageParam[];

  it('fromAnthropic maps a compaction block to a pinned passthrough field', () => {
    const { history } = fromAnthropic(compactionMessages);

    const assistant = history.find((m) => m.role === 'assistant');
    expect(assistant?._anthropic_compaction).toBe('Summary of the earlier conversation.');
    expect(assistant?.pinned).toBe(true);
    expect(assistant?.content).toBe('Continuing from the summary.');
  });

  it('the target adapter re-emits the compaction block first, verbatim', () => {
    const { history } = fromAnthropic(compactionMessages);
    const payload = new AnthropicAdapter().compile(history as Message[]);

    const assistant = payload.messages.find((m) => m.role === 'assistant');
    const blocks = assistant?.content as Array<{ type: string; content?: string; text?: string }>;
    expect(blocks[0]).toEqual({
      type: 'compaction',
      content: 'Summary of the earlier conversation.',
    });
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('switching provider preserves the compaction summary as marked text (OpenAI)', () => {
    const { history } = fromAnthropic(compactionMessages);
    // Trailing user turn — a trailing plain assistant message would be
    // treated as a prefill by the adapter's degradation path and popped.
    const payload = new OpenAIAdapter().compile([
      ...(history as Message[]),
      { role: 'user', content: 'next question' },
    ]);

    const flat = JSON.stringify(payload.messages);
    expect(flat).toContain('[Summary of earlier conversation (compacted server-side)]');
    expect(flat).toContain('Summary of the earlier conversation.');
    expect(flat).not.toContain('_anthropic_compaction');
  });

  it('switching provider preserves the compaction summary as marked text (Gemini)', () => {
    const { history } = fromAnthropic(compactionMessages);
    const payload = new GeminiAdapter().compile([
      ...(history as Message[]),
      { role: 'user', content: 'next question' },
    ]);

    const flat = JSON.stringify(payload.messages);
    expect(flat).toContain('[Summary of earlier conversation (compacted server-side)]');
    expect(flat).toContain('Summary of the earlier conversation.');
  });

  it('client-side compression cannot destroy a compaction block (pinned)', async () => {
    const { history } = fromAnthropic(compactionMessages);
    const more: Message[] = [
      ...(history as Message[]),
      { role: 'user', content: 'follow-up 1' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'follow-up 2' },
    ];

    const janitor = new Janitor({
      contextWindow: 20,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.2,
      compressionModel: async () => '<summary>S</summary>',
    });

    const result = await janitor.compress(more);

    const kept = result.find((m) => typeof m._anthropic_compaction === 'string');
    expect(kept?._anthropic_compaction).toBe('Summary of the earlier conversation.');
  });
});

// ═══════════════════════════════════════════════════════
// Server-side context management strategy
// ═══════════════════════════════════════════════════════

describe("contextManagement strategy 'server'", () => {
  it('emits context_management + betas on the anthropic target and skips client compression', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const logger = { warn: vi.fn() };
    const chef = new ContextChef({
      logger,
      contextManagement: { strategy: 'server' },
      janitor: {
        contextWindow: 10,
        triggerRatio: 1,
        tokenizer: makeTokenizer(10),
        compressionModel,
      },
    });

    chef.setHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(compressionModel).not.toHaveBeenCalled(); // server wins
    expect(payload.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] });
    expect(payload.betas).toEqual(['compact-2026-01-12']);
    // Both configured → construction-time warning fired
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Server-side compaction wins'),
    );
  });

  it('passes a custom server config through verbatim and derives betas per edit type', async () => {
    const server = {
      edits: [
        { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } },
        { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 30000 } },
        { type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150000 } },
      ],
    };
    const chef = new ContextChef({ contextManagement: { strategy: 'server', server } });
    chef.setHistory([{ role: 'user', content: 'a' }]);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(payload.context_management).toBe(server);
    expect(payload.betas).toEqual(
      expect.arrayContaining(['context-management-2025-06-27', 'compact-2026-01-12']),
    );
  });

  it('does not attach context_management on non-anthropic targets', async () => {
    const chef = new ContextChef({ contextManagement: { strategy: 'server' } });
    chef.setHistory([{ role: 'user', content: 'a' }]);

    const openaiPayload = await chef.compile({ target: 'openai' });
    const geminiPayload = await chef.compile({ target: 'gemini' });

    expect(
      (openaiPayload as unknown as Record<string, unknown>).context_management,
    ).toBeUndefined();
    expect(
      (geminiPayload as unknown as Record<string, unknown>).context_management,
    ).toBeUndefined();
  });

  it('attaches context_management when an AnthropicAdapter instance is passed as target', async () => {
    const chef = new ContextChef({ contextManagement: { strategy: 'server' } });
    chef.setHistory([{ role: 'user', content: 'a' }]);

    const payload = (await chef.compile({ target: new AnthropicAdapter() })) as AnthropicPayload;

    expect(payload.context_management).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// Gemini thought signatures
// ═══════════════════════════════════════════════════════

describe('Gemini thought signatures', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'check flight AA100' }] },
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'check_flight', args: { flight: 'AA100' } },
          thoughtSignature: 'SIG-FC-1',
        },
      ],
    },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'check_flight', response: { status: 'on time' } } }],
    },
    {
      role: 'model',
      parts: [{ text: 'Your flight is on time.', thoughtSignature: 'SIG-TEXT-1' }],
    },
    // Trailing user turn — a trailing model message would be treated as a
    // prefill by the adapter's degradation path and popped.
    { role: 'user', parts: [{ text: 'thanks' }] },
  ] as unknown as SDKContent[];

  it('fromGemini captures signatures on functionCall and text parts', () => {
    const { history } = fromGemini(contents);

    const withCall = history.find((m) => m.tool_calls?.length);
    expect(withCall?.tool_calls?.[0].thoughtSignature).toBe('SIG-FC-1');

    const finalText = history.find((m) => m.content === 'Your flight is on time.');
    expect(finalText?._gemini_thought_signature).toBe('SIG-TEXT-1');
  });

  it('the target adapter re-emits signatures verbatim', () => {
    const { history } = fromGemini(contents);
    const payload = new GeminiAdapter().compile(history as Message[]);

    const flat = JSON.stringify(payload.messages);
    expect(flat).toContain('SIG-FC-1');
    expect(flat).toContain('SIG-TEXT-1');

    const modelWithCall = payload.messages.find((c) =>
      c.parts.some((p) => 'functionCall' in p && p.functionCall),
    );
    const fcPart = modelWithCall?.parts.find((p) => 'functionCall' in p) as
      | { thoughtSignature?: string }
      | undefined;
    expect(fcPart?.thoughtSignature).toBe('SIG-FC-1');
  });

  it("compact({ clear: ['thinking'] }) cannot destroy tool-call signatures", () => {
    const { history } = fromGemini(contents);
    const janitor = new Janitor({ contextWindow: Infinity });

    const compacted = janitor.compact(history as Message[], { clear: ['thinking'] });

    const withCall = compacted.find((m) => m.tool_calls?.length);
    expect(withCall?.tool_calls?.[0].thoughtSignature).toBe('SIG-FC-1');
  });
});

// ═══════════════════════════════════════════════════════
// ToolDefinition.deferLoading passthrough
// ═══════════════════════════════════════════════════════

describe('ToolDefinition.deferLoading', () => {
  it('survives registerTools → compile payload.tools', async () => {
    const chef = new ContextChef();
    chef.registerTools([
      { name: 'search', description: 'Search things' },
      { name: 'rare_tool', description: 'Rarely needed', deferLoading: true },
    ]);
    chef.setHistory([{ role: 'user', content: 'q' }]);

    const payload = await chef.compile({ target: 'anthropic' });

    const rare = payload.tools?.find((t) => t.name === 'rare_tool');
    expect(rare?.deferLoading).toBe(true);
    expect(payload.tools?.find((t) => t.name === 'search')?.deferLoading).toBeUndefined();
  });
});
