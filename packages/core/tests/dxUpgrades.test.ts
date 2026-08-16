import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiAdapter } from '../src/adapters/geminiAdapter';
import { OpenAIAdapter } from '../src/adapters/openAIAdapter';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

const StateSchema = z.object({ goal: z.string() });

describe('withGuardrails v4 semantics', () => {
  it('is order-independent: setDynamicState AFTER withGuardrails keeps the guardrail', async () => {
    const chef = new ContextChef();
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'q' }])
      .withGuardrails({ enforceXML: { outputTag: 'out' } })
      .setDynamicState(StateSchema, { goal: 'g' }, { placement: 'system' });

    const payload = await chef.compile({ target: 'openai' });
    const flat = JSON.stringify(payload.messages);

    expect(flat).toContain('CRITICAL OUTPUT FORMAT INSTRUCTIONS');
    expect(flat).toContain('<dynamic_state>');
  });

  it('does not accumulate across repeated calls (replace semantics)', async () => {
    const chef = new ContextChef();
    chef
      .setHistory([{ role: 'user', content: 'q' }])
      .withGuardrails({ prefill: 'FIRST' })
      .withGuardrails({ prefill: 'SECOND' });

    const payload = await chef.compile({ target: 'anthropic' });
    const flat = JSON.stringify(payload.messages);

    expect(flat).toContain('SECOND');
    expect(flat).not.toContain('FIRST');
    // Exactly one trailing assistant prefill
    const assistants = payload.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
  });

  it('withGuardrails(null) clears the guardrail', async () => {
    const chef = new ContextChef();
    chef
      .setHistory([{ role: 'user', content: 'q' }])
      .withGuardrails({ enforceXML: { outputTag: 'out' } })
      .withGuardrails(null);

    const payload = await chef.compile({ target: 'openai' });
    expect(JSON.stringify(payload.messages)).not.toContain('CRITICAL OUTPUT FORMAT');
  });

  it('survives snapshot/restore', async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'q' }]);
    chef.withGuardrails({ enforceXML: { outputTag: 'answer' } });

    const snap = chef.snapshot();
    chef.withGuardrails(null);
    chef.restore(snap);

    const payload = await chef.compile({ target: 'openai' });
    expect(JSON.stringify(payload.messages)).toContain('CRITICAL OUTPUT FORMAT');
  });
});

describe('preserveThinkingAsText (T2.3)', () => {
  const history: Message[] = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'answer',
      thinking: { thinking: 'step by step reasoning', signature: 'sig1' },
    },
    { role: 'user', content: 'next' },
  ];

  it('OpenAI adapter: off by default (thinking dropped)', () => {
    const payload = new OpenAIAdapter().compile(structuredClone(history));
    expect(JSON.stringify(payload.messages)).not.toContain('step by step reasoning');
  });

  it('OpenAI adapter: on — thinking becomes a <thinking> text prefix', () => {
    const payload = new OpenAIAdapter({ preserveThinkingAsText: true }).compile(
      structuredClone(history),
    );
    const assistant = payload.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('<thinking>\nstep by step reasoning\n</thinking>');
    expect(assistant?.content).toContain('answer');
  });

  it('OpenAI adapter: redacted_thinking is never textified (dropped with one warning)', () => {
    const logger = { warn: vi.fn() };
    const adapter = new OpenAIAdapter({ preserveThinkingAsText: true, logger });
    const redacted: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', redacted_thinking: { data: 'OPAQUE' } },
      { role: 'user', content: 'next' },
    ];

    const payload = adapter.compile(structuredClone(redacted));
    adapter.compile(structuredClone(redacted)); // second compile — no second warning

    expect(JSON.stringify(payload.messages)).not.toContain('OPAQUE');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('Gemini adapter: on — thinking becomes a <thinking> text prefix', () => {
    const payload = new GeminiAdapter({ preserveThinkingAsText: true }).compile(
      structuredClone(history),
    );
    expect(JSON.stringify(payload.messages)).toContain('step by step reasoning');
  });
});

describe('event granularity (T2.5)', () => {
  it('compress:start and compress:end fire around an actual compression', async () => {
    const events: string[] = [];
    const chef = new ContextChef({
      janitor: {
        contextWindow: 30,
        triggerRatio: 1,
        tokenizer: (msgs: Message[]) => msgs.length * 10,
        preserveRatio: 0.3,
        compressionModel: async () => '<summary>S</summary>',
      },
    });
    chef.on('compress:start', ({ currentTokens, limit }) => {
      events.push(`start:${currentTokens}>${limit}`);
    });
    chef.on('compress:end', ({ compressed }) => {
      events.push(`end:${compressed}`);
    });

    chef.setHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
    await chef.compile({ target: 'openai' });

    expect(events).toEqual(['start:50>30', 'end:true']);
  });

  it('compress:end fires with compressed:false when under budget', async () => {
    const events: string[] = [];
    const chef = new ContextChef();
    chef.on('compress:start', () => {
      events.push('start');
    });
    chef.on('compress:end', ({ compressed }) => {
      events.push(`end:${compressed}`);
    });

    chef.setHistory([{ role: 'user', content: 'q' }]);
    await chef.compile({ target: 'openai' });

    expect(events).toEqual(['end:false']);
  });

  it('offload:created fires with the URI', async () => {
    const files = new Map<string, string>();
    const adapter = {
      write: async (f: string, c: string) => void files.set(f, c),
      read: async (f: string) => files.get(f) ?? null,
      exists: async (f: string) => files.has(f),
    };
    const uris: string[] = [];
    const chef = new ContextChef({ vfs: { threshold: 10, adapter } });
    chef.on('offload:created', ({ uri }) => void uris.push(uri));

    await chef.offloadAsync('x'.repeat(5000));

    expect(uris).toHaveLength(1);
    expect(uris[0]).toContain('context://');
  });

  it('pruner:tool-blocked fires on a blocked dispatch', async () => {
    const blocked: string[] = [];
    const chef = new ContextChef();
    chef.registerTools([{ name: 'rm_rf', description: 'danger' }]);
    chef.getPruner().setBlockedTools(['rm_rf']);
    chef.on('pruner:tool-blocked', ({ name }) => void blocked.push(name));

    const check = chef.checkToolCall({ name: 'rm_rf' });
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget emit

    expect(check.allowed).toBe(false);
    expect(blocked).toEqual(['rm_rf']);
  });
});

describe('transformToolResult (T2.6)', () => {
  const toolHistory: Message[] = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'fetch_logs', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'SECRET=abc123 line2', tool_call_id: 'c1' },
    { role: 'user', content: 'analyze' },
  ];

  it('rewrites tool results before anything else sees them, with resolved names', async () => {
    const seen: Array<{ toolName: string | null; toolCallId: string | null }> = [];
    const chef = new ContextChef({
      transformToolResult: async (content, info) => {
        seen.push(info);
        return content.replace(/SECRET=\S+/, '[REDACTED]');
      },
    });
    chef.setHistory(structuredClone(toolHistory));

    const payload = await chef.compile({ target: 'openai' });
    const flat = JSON.stringify(payload.messages);

    expect(flat).toContain('[REDACTED]');
    expect(flat).not.toContain('abc123');
    expect(seen).toEqual([{ toolName: 'fetch_logs', toolCallId: 'c1' }]);
  });

  it('does not mutate the stored history', async () => {
    const original = structuredClone(toolHistory);
    const chef = new ContextChef({
      transformToolResult: () => '[GONE]',
    });
    chef.setHistory(original);

    await chef.compile({ target: 'openai' });
    const second = await chef.compile({ target: 'openai' });

    // Original objects untouched; transform applied per compile
    expect(original[2].content).toBe('SECRET=abc123 line2');
    expect(JSON.stringify(second.messages)).toContain('[GONE]');
  });
});

describe('compile() serialization (T2.4.1)', () => {
  it('concurrent compile() calls run strictly one after another', async () => {
    const order: string[] = [];
    const chef = new ContextChef({
      transformContext: async (messages) => {
        order.push('enter');
        await new Promise((r) => setTimeout(r, 20));
        order.push('exit');
        return messages;
      },
    });
    chef.setHistory([{ role: 'user', content: 'q' }]);

    await Promise.all([chef.compile({ target: 'openai' }), chef.compile({ target: 'openai' })]);

    // Interleaving would produce enter,enter,exit,exit
    expect(order).toEqual(['enter', 'exit', 'enter', 'exit']);
  });

  it('a failing compile does not poison the chain', async () => {
    let calls = 0;
    const chef = new ContextChef({
      transformContext: (messages) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return messages;
      },
    });
    chef.setHistory([{ role: 'user', content: 'q' }]);

    await expect(chef.compile({ target: 'openai' })).rejects.toThrow('boom');
    await expect(chef.compile({ target: 'openai' })).resolves.toBeDefined();
  });
});
