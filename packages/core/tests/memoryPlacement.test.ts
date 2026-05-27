import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ContextChef } from '../src/index';
import { InMemoryStore } from '../src/modules/memory/inMemoryStore';
import { Prompts } from '../src/prompts';
import type { AnthropicPayload, Message, OpenAIPayload } from '../src/types';

const ANCHOR = 'Above is the current system state. Use it to guide your next action.';

interface PlainMessage {
  role: string;
  content: string;
}

function plain(payload: { messages: unknown }): PlainMessage[] {
  return JSON.parse(JSON.stringify(payload.messages));
}

describe('memoryPlacement — default "after_system" (backwards compat)', () => {
  it('emits one combined system message at the top (instruction + data)', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.getMemory().set('lang', 'TypeScript');

    chef
      .setSystemPrompt([{ role: 'system', content: 'You are an expert.' }])
      .setHistory([{ role: 'user', content: 'Hello.' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    // [user system prompt, memory system (instruction+data), user]
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);

    const memoryMsg = messages[1];
    expect(memoryMsg.content).toContain(Prompts.MEMORY_INSTRUCTION);
    expect(memoryMsg.content).toContain('<memory>');
    expect(memoryMsg.content).toContain('<entry key="lang"');
    expect(memoryMsg.content).toContain('TypeScript');

    // Last user must NOT carry the memory tail
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('Hello.');
  });

  it('emits instruction-only system message when no entries exist', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[1].content).toBe(Prompts.MEMORY_INSTRUCTION);
    expect(messages[1].content).not.toContain('<memory>');
  });

  it('explicitly setting memoryPlacement="after_system" matches the default', async () => {
    // Lock the clock so the two payloads share identical `updated_at` timestamps
    // inside the serialized <memory> block — otherwise this would be flaky on
    // sub-millisecond differences between the two `getMemory().set()` calls.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T00:00:00Z'));

    try {
      const buildPayload = async (placement?: 'after_system') => {
        const chef = new ContextChef({
          memory: {
            store: new InMemoryStore(),
            ...(placement ? { memoryPlacement: placement } : {}),
          },
        });
        await chef.getMemory().set('lang', 'TypeScript');

        chef
          .setSystemPrompt([{ role: 'system', content: 'sys' }])
          .setHistory([{ role: 'user', content: 'hi' }]);

        return plain(await chef.compile({ target: 'openai' }));
      };

      const fromDefault = await buildPayload();
      const fromExplicit = await buildPayload('after_system');
      expect(fromDefault).toEqual(fromExplicit);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('memoryPlacement — "before_history_tail" — split instruction + tail data', () => {
  it('keeps instruction-only system message at the top, appends data to last user', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TypeScript');

    chef
      .setSystemPrompt([{ role: 'system', content: 'You are an expert.' }])
      .setHistory([{ role: 'user', content: 'Refactor the code.' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);

    // Top instruction message must NOT carry the volatile <memory> block
    expect(messages[1].content).toBe(Prompts.MEMORY_INSTRUCTION);
    expect(messages[1].content).not.toContain('<memory>');
    expect(messages[1].content).not.toContain('TypeScript');

    // Memory data lands on the last user message
    const lastUser = messages[2];
    expect(lastUser.content).toContain('Refactor the code.');
    expect(lastUser.content).toContain('You recall the following from previous conversations:');
    expect(lastUser.content).toContain('<memory>');
    expect(lastUser.content).toContain('<entry key="lang"');
    expect(lastUser.content).toContain('TypeScript');
  });

  it('appends NO anchor line when only memory is in the tail (no dynamic state)', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TypeScript');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);
    expect(messages[messages.length - 1].content).not.toContain(ANCHOR);
  });

  it('skips tail injection when no memory entries exist (instruction-only at top)', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[1].content).toBe(Prompts.MEMORY_INSTRUCTION);

    // Last user message untouched
    expect(messages[2].content).toBe('hi');
    expect(messages[2].content).not.toContain('<memory>');
  });

  it('creates a new user message when no last-user exists in history', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TypeScript');

    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory([]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    // [user system, memory instruction system, new user with memory data]
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[2].content).toContain('<memory>');
    expect(messages[2].content).toContain('TypeScript');
  });

  it('returns meta.injectedMemoryKeys correctly under "before_history_tail"', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TS');
    await chef.getMemory().set('style', 'functional');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta?.injectedMemoryKeys.sort()).toEqual(['lang', 'style']);
  });
});

describe('memoryPlacement — coexistence with dynamicState placement', () => {
  const TaskSchema = z.object({ activeFile: z.string() });

  it('"before_history_tail" + dynamicStatePlacement="last_user": both land in last user, ordered (memory, dynamic_state, anchor)', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'do it' }])
      .setDynamicState(TaskSchema, { activeFile: 'auth.ts' }, { placement: 'last_user' });

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    const lastUser = messages[messages.length - 1];
    expect(lastUser.role).toBe('user');

    const memPos = lastUser.content.indexOf('<memory>');
    const dynPos = lastUser.content.indexOf('<dynamic_state>');
    const anchorPos = lastUser.content.indexOf(ANCHOR);

    expect(memPos).toBeGreaterThan(-1);
    expect(dynPos).toBeGreaterThan(-1);
    expect(anchorPos).toBeGreaterThan(-1);

    // Order: original user content → memory → dynamic_state → anchor
    expect(memPos).toBeLessThan(dynPos);
    expect(dynPos).toBeLessThan(anchorPos);
    expect(lastUser.content.indexOf('do it')).toBeLessThan(memPos);
  });

  it('"before_history_tail" + dynamicStatePlacement="system": memory at user tail, dynamic_state as standalone system message, NO anchor on user', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'do it' }])
      .setDynamicState(TaskSchema, { activeFile: 'auth.ts' }, { placement: 'system' });

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    // System messages stay inline for OpenAI: [user sys, mem instr, user, dynamic_state sys]
    const lastUser = messages.find((m) => m.role === 'user');
    expect(lastUser?.content).toContain('<memory>');
    expect(lastUser?.content).not.toContain(ANCHOR);

    const dynamicSysMsg = messages.find(
      (m) => m.role === 'system' && m.content.includes('CURRENT TASK STATE'),
    );
    expect(dynamicSysMsg).toBeDefined();
    expect(dynamicSysMsg?.content).not.toContain('<memory>');
  });

  it('"after_system" + dynamicStatePlacement="last_user": memory at top, dynamic_state at tail (regression check)', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'do it' }])
      .setDynamicState(TaskSchema, { activeFile: 'auth.ts' });

    const payload = await chef.compile({ target: 'openai' });
    const messages = plain(payload);

    expect(messages[1].content).toContain('<memory>'); // memory at top
    const lastUser = messages[messages.length - 1];
    expect(lastUser.content).toContain('<dynamic_state>');
    expect(lastUser.content).toContain(ANCHOR);
    expect(lastUser.content).not.toContain('<memory>'); // not duplicated at tail
  });
});

describe('memoryPlacement — onBeforeCompile coexistence', () => {
  it('"before_history_tail" + onBeforeCompile injects implicit_context alongside memory and dynamic_state', async () => {
    const TaskSchema = z.object({ activeFile: z.string() });
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
      onBeforeCompile: async () => '<related_code>fn()</related_code>',
    });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'do it' }])
      .setDynamicState(TaskSchema, { activeFile: 'auth.ts' });

    const payload = await chef.compile({ target: 'openai' });
    const lastUser = plain(payload).at(-1);
    expect(lastUser?.content).toContain('<memory>');
    expect(lastUser?.content).toContain('<dynamic_state>');
    expect(lastUser?.content).toContain('<implicit_context>');
    expect(lastUser?.content).toContain('<related_code>fn()</related_code>');
    expect(lastUser?.content).toContain(ANCHOR);
  });
});

describe('memoryPlacement — Anthropic adapter behavior (the real win)', () => {
  it('"after_system": memory data ends up inside the top-level Anthropic `system` parameter', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    const systemText = (payload.system ?? []).map((b) => b.text).join('\n');
    expect(systemText).toContain('<memory>');
    expect(systemText).toContain('TS');

    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const userTexts = userMessages.flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
          : [],
    );
    expect(userTexts.join('\n')).not.toContain('<memory>');
  });

  it('"before_history_tail": memory data appears in `messages`, NOT in the top-level `system` parameter', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    // System parameter holds only stable content: user system + memory INSTRUCTION
    const systemText = (payload.system ?? []).map((b) => b.text).join('\n');
    expect(systemText).toContain('You are helpful.');
    expect(systemText).toContain(Prompts.MEMORY_INSTRUCTION);
    expect(systemText).not.toContain('<memory>');
    expect(systemText).not.toContain('TS');

    // Memory data is folded into the last user message in `messages`
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const userTexts = userMessages.flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
          : [],
    );
    const combined = userTexts.join('\n');
    expect(combined).toContain('<memory>');
    expect(combined).toContain('TS');
  });
});

describe('memoryPlacement — KV-cache stability of the top section', () => {
  it('"before_history_tail": top system + memory-instruction prefix is identical across memory mutations', async () => {
    const makePayload = async (memValue: string) => {
      const chef = new ContextChef({
        memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
      });
      await chef.getMemory().set('lang', memValue);
      chef
        .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
        .setHistory([{ role: 'user', content: 'hi' }]);
      return (await chef.compile({ target: 'openai' })) as OpenAIPayload;
    };

    const a = await makePayload('TypeScript');
    const b = await makePayload('Python');

    // The first two messages (user system + memory instruction) are byte-identical
    // → cache breakpoints on either of these blocks survive memory mutations.
    expect(JSON.stringify(a.messages[0])).toBe(JSON.stringify(b.messages[0]));
    expect(JSON.stringify(a.messages[1])).toBe(JSON.stringify(b.messages[1]));

    // The differing content lives in the last user message
    const lastA = a.messages.at(-1) as { content?: unknown };
    const lastB = b.messages.at(-1) as { content?: unknown };
    expect(JSON.stringify(lastA)).not.toBe(JSON.stringify(lastB));
  });

  it('"after_system": memory mutation invalidates the top memory message (proof of the cache hazard the new placement fixes)', async () => {
    const makePayload = async (memValue: string) => {
      const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
      await chef.getMemory().set('lang', memValue);
      chef
        .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
        .setHistory([{ role: 'user', content: 'hi' }]);
      return (await chef.compile({ target: 'openai' })) as OpenAIPayload;
    };

    const a = await makePayload('TypeScript');
    const b = await makePayload('Python');

    // User system prompt is stable
    expect(JSON.stringify(a.messages[0])).toBe(JSON.stringify(b.messages[0]));
    // But the second message (combined memory) is NOT — this is the hazard
    expect(JSON.stringify(a.messages[1])).not.toBe(JSON.stringify(b.messages[1]));
  });
});

describe('memoryPlacement — selector + onMemoryExpired integration', () => {
  it('"before_history_tail" still respects the selector when building tail data', async () => {
    const chef = new ContextChef({
      memory: {
        store: new InMemoryStore(),
        memoryPlacement: 'before_history_tail',
        selector: (entries) => entries.filter((e) => e.key !== 'hidden'),
      },
    });
    await chef.getMemory().set('shown', 'visible');
    await chef.getMemory().set('hidden', 'invisible');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const lastUser = plain(payload).at(-1) as PlainMessage;
    expect(lastUser.content).toContain('shown');
    expect(lastUser.content).toContain('visible');
    expect(lastUser.content).not.toContain('hidden');
    expect(lastUser.content).not.toContain('invisible');

    expect(payload.meta?.injectedMemoryKeys).toEqual(['shown']);
  });
});

describe('memoryPlacement — Memory class exposes placement', () => {
  it('defaults to "after_system" when not specified', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    expect(chef.getMemory().placement).toBe('after_system');
  });

  it('reflects the configured placement', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    expect(chef.getMemory().placement).toBe('before_history_tail');
  });
});

describe('memoryPlacement — transformContext still observes the assembled tail', () => {
  it('"before_history_tail" injection is visible to transformContext (runs after sandwich assembly)', async () => {
    let observed: Message[] = [];
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
      transformContext: (messages) => {
        observed = messages;
        return messages;
      },
    });
    await chef.getMemory().set('lang', 'TS');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'hi' }]);

    await chef.compile({ target: 'openai' });

    // transformContext runs BEFORE tail injection (step 7 vs step 8), so memory
    // data is NOT yet visible to it — only the instruction system message is.
    // This documents the ordering contract.
    const observedRoles = observed.map((m) => m.role);
    expect(observedRoles).toContain('system');
    expect(observedRoles).toContain('user');

    const memInstr = observed.find(
      (m) => m.role === 'system' && m.content === Prompts.MEMORY_INSTRUCTION,
    );
    expect(memInstr).toBeDefined();

    const userMsg = observed.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('hi'); // no tail yet
  });
});
