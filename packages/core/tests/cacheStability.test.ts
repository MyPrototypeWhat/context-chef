import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditAnthropicCachePlacement } from '../src/adapters/anthropicCacheAudit';
import { ContextChef, InMemoryStore } from '../src/index';
import type { AnthropicPayload, Message } from '../src/types';

// ═══════════════════════════════════════════════════════
// guardrailPlacement: 'last_user'
// ═══════════════════════════════════════════════════════

describe("withGuardrails placement: 'last_user'", () => {
  const history: Message[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];

  it('keeps the enforce-XML text OUT of the Anthropic system parameter', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory(history);
    chef.withGuardrails({
      enforceXML: { outputTag: 'out' },
      prefill: '<thinking>',
      placement: 'last_user',
    });

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    const systemText = JSON.stringify(payload.system ?? []);
    expect(systemText).not.toContain('EPHEMERAL_MESSAGE');

    // Enforce text rides the last user message instead
    const userMessages = payload.messages.filter((m) => m.role === 'user');
    const lastUser = JSON.stringify(userMessages[userMessages.length - 1]);
    expect(lastUser).toContain('EPHEMERAL_MESSAGE');
    expect(lastUser).toContain('<out>');

    // Prefill unaffected: still a trailing assistant message
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last)).toContain('<thinking>');
  });

  it("default placement 'system' still delivers a system message (pre-existing behavior)", async () => {
    const chef = new ContextChef();
    chef.setHistory(structuredClone(history));
    chef.withGuardrails({ enforceXML: { outputTag: 'out' } });

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(JSON.stringify(payload.system ?? [])).toContain('EPHEMERAL_MESSAGE');
  });

  it('works on OpenAI: enforce text lands in the last user message, not a system message', async () => {
    const chef = new ContextChef();
    chef.setHistory(structuredClone(history));
    chef.withGuardrails({ enforceXML: { outputTag: 'out' }, placement: 'last_user' });

    const payload = await chef.compile({ target: 'openai' });

    const systems = payload.messages.filter((m) => m.role === 'system');
    expect(JSON.stringify(systems)).not.toContain('EPHEMERAL_MESSAGE');
    const users = payload.messages.filter((m) => m.role === 'user');
    expect(JSON.stringify(users[users.length - 1])).toContain('EPHEMERAL_MESSAGE');
  });

  it('placement survives snapshot/restore', async () => {
    const chef = new ContextChef();
    chef.setHistory(structuredClone(history));
    chef.withGuardrails({ enforceXML: { outputTag: 'out' }, placement: 'last_user' });

    const snap = chef.snapshot();
    chef.withGuardrails(null);
    chef.restore(snap);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    expect(JSON.stringify(payload.system ?? [])).not.toContain('EPHEMERAL_MESSAGE');
    expect(JSON.stringify(payload.messages)).toContain('EPHEMERAL_MESSAGE');
  });
});

// ═══════════════════════════════════════════════════════
// auditAnthropicCachePlacement
// ═══════════════════════════════════════════════════════

describe('auditAnthropicCachePlacement', () => {
  const sys = (text: string, breakpoint = false) => ({
    type: 'text' as const,
    text,
    ...(breakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
  });

  it('flags volatile memory data inside the cached system prefix', () => {
    const payload = {
      system: [
        sys('You recall the following from previous conversations:\n<memory>...</memory>'),
        sys('stable instructions', true), // breakpoint AFTER the volatile block
      ],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);

    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBe('system[0]');
    expect(issues[0].message).toContain('before_history_tail');
  });

  it('clean when the volatile content sits AFTER the last breakpoint', () => {
    const payload = {
      system: [
        sys('stable instructions', true),
        sys('You recall the following from previous conversations:\n<memory>...</memory>'),
      ],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    expect(auditAnthropicCachePlacement(payload)).toHaveLength(0);
  });

  it('clean when no breakpoints exist at all', () => {
    const payload = {
      system: [sys('<dynamic_state>volatile</dynamic_state>')],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    expect(auditAnthropicCachePlacement(payload)).toHaveLength(0);
  });

  it('flags volatile content in messages before a message-level breakpoint', () => {
    const payload = {
      system: [sys('stable')],
      messages: [
        { role: 'user' as const, content: '<dynamic_state>v1</dynamic_state>' },
        {
          role: 'assistant' as const,
          content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
        },
      ],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);
    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBe('messages[0]');
  });

  it('points guardrail issues at the placement option', () => {
    const payload = {
      system: [sys('<EPHEMERAL_MESSAGE>rules</EPHEMERAL_MESSAGE>'), sys('stable', true)],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("placement: 'last_user'");
  });

  it('dedupeKey is position-independent: the same issue kind at different indices matches', () => {
    const early = auditAnthropicCachePlacement({
      system: [sys('stable')],
      messages: [
        { role: 'user', content: '<dynamic_state>v1</dynamic_state>' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
        },
      ],
    } as unknown as AnthropicPayload);
    const late = auditAnthropicCachePlacement({
      system: [sys('stable')],
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: '<dynamic_state>v2</dynamic_state>' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
        },
      ],
    } as unknown as AnthropicPayload);

    expect(early).toHaveLength(1);
    expect(late).toHaveLength(1);
    expect(early[0].location).not.toBe(late[0].location);
    expect(early[0].dedupeKey).toBe(late[0].dedupeKey);
  });

  it('diagnoses a breakpoint sitting ON the volatile tail segment without circular advice', () => {
    // Tail-placed dynamic state merged into the last user message, which also
    // carries the final breakpoint: re-suggesting a tail placement would be
    // circular — the content is already at the tail; the breakpoint must move.
    const payload = {
      system: [sys('stable')],
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'q2\n\n<dynamic_state>v</dynamic_state>',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);
    expect(issues).toHaveLength(1);
    expect(issues[0].dedupeKey).toBe('dynamic state@breakpoint-tail');
    expect(issues[0].message).toContain('move the breakpoint');
    expect(issues[0].message).not.toContain("placement: 'last_user'");
  });

  it('flags skill tail instructions and announcements caught inside the cached prefix', () => {
    // Both channels always render at the conversational tail, so the only way
    // they end up hashed is a breakpoint placed at or after them.
    const payload = {
      system: [sys('stable')],
      messages: [
        {
          role: 'user',
          content: 'q1\n\n<skill_instructions skill="triage">rules</skill_instructions>',
        },
        { role: 'assistant', content: 'a1' },
        {
          role: 'user',
          content: '<announcements><announcement id="t">x</announcement></announcements>',
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
        },
      ],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.dedupeKey).sort()).toEqual([
      'announcements@prefix',
      'skill tail instructions@prefix',
    ]);
    expect(issues.every((i) => i.message.includes('move the cache breakpoint'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// Assembler tail placement (agent-loop shapes)
// ═══════════════════════════════════════════════════════

describe('tail injection placement in agent loops', () => {
  const TaskSchema = z.object({ step: z.string() });
  const toolCall = {
    id: 'c1',
    type: 'function' as const,
    function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
  };
  const midLoopHistory = (): Message[] => [
    { role: 'user', content: 'q1', _cache_breakpoint: true },
    { role: 'assistant', content: '', tool_calls: [toolCall] },
    { role: 'tool', content: 'file contents', tool_call_id: 'c1' },
  ];

  it('tool-result tail: volatile state is appended as a NEW user message, earlier messages untouched', async () => {
    const chef = new ContextChef();
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory(midLoopHistory())
      .setDynamicState(TaskSchema, { step: 'interpret tool output' });

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Message[];

    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<dynamic_state>');

    // The user turn that started the tool sequence stays byte-identical —
    // this is what keeps a breakpoint on it (or after it) valid.
    const q1 = messages.find((m) => typeof m.content === 'string' && m.content.startsWith('q1'));
    expect(q1?.content).toBe('q1');

    // Tool result still directly precedes the injected user message.
    expect(messages[messages.length - 2].role).toBe('tool');
  });

  it("guardrail 'last_user' rides the appended tail message in mid-loop compiles, with prefill last", async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory(midLoopHistory());
    chef.withGuardrails({
      enforceXML: { outputTag: 'out' },
      prefill: '<thinking>',
      placement: 'last_user',
    });

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    const messages = payload.messages as Array<{ role: string }>;

    // Prefill stays the FINAL message; the guardrail user message sits before it.
    expect(messages[messages.length - 1].role).toBe('assistant');
    const beforePrefill = JSON.stringify(messages[messages.length - 2]);
    expect(beforePrefill).toContain('EPHEMERAL_MESSAGE');

    // Not merged into the old user turn (the 4.1.0 walk-back bug).
    expect(JSON.stringify(messages[0])).not.toContain('EPHEMERAL_MESSAGE');
  });

  it('no user message + prefill: the injected user lands BEFORE the prefill assistant', async () => {
    const chef = new ContextChef();
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setDynamicState(TaskSchema, { step: 'bootstrap' });
    chef.withGuardrails({ prefill: '<thinking>' });

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    const messages = payload.messages as Array<{ role: string }>;

    // [user (injected state), assistant (prefill)] — an [assistant, user]
    // ending would 400 on Anthropic and silently disable the prefill.
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(JSON.stringify(messages[0])).toContain('dynamic_state');
    expect(messages[1].role).toBe('assistant');
    expect(JSON.stringify(messages[1])).toContain('<thinking>');
  });

  it("memory 'before_history_tail' in a mid-loop compile leaves prior history byte-identical across mutations", async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
    });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);

    await chef.getMemory().set('k', 'v1');
    chef.setHistory(midLoopHistory());
    const first = await chef.compile({ target: 'openai' });

    await chef.getMemory().set('k', 'v2');
    chef.setHistory(midLoopHistory());
    const second = await chef.compile({ target: 'openai' });

    // Everything BEFORE the injected tail message is identical across the two
    // compiles — a provider prefix cache over those messages survives the
    // memory mutation.
    const stablePrefix = (p: { messages: unknown[] }) =>
      JSON.stringify(p.messages.slice(0, p.messages.length - 1));
    expect(stablePrefix(first)).toBe(stablePrefix(second));
  });
});

// ═══════════════════════════════════════════════════════
// Memory static tool definitions — array/object contract
// ═══════════════════════════════════════════════════════

describe('memory tool definitions array contract', () => {
  it('returns a fresh mutable array; the definition objects stay frozen and reference-stable', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    const memory = chef.getMemory();

    const a = await memory.getToolDefinitions();
    const b = await memory.getToolDefinitions();

    expect(a).not.toBe(b);
    expect(a[0]).toBe(b[0]); // deep-equal payloads across compiles need identity here
    expect(Object.isFrozen(a[0])).toBe(true);

    // 4.0-era callers append/sort the returned array — must not throw.
    a.push({ name: 'extra', description: 'x', parameters: { type: 'object', properties: {} } });
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════
// ChefConfig.cacheAudit wiring
// ═══════════════════════════════════════════════════════

describe('ChefConfig.cacheAudit', () => {
  it('warns once per distinct issue on the Anthropic target', async () => {
    const logger = { warn: vi.fn() };
    const chef = new ContextChef({
      logger,
      cacheAudit: true,
      memory: { store: new InMemoryStore() }, // default after_system placement
    });
    await chef.getMemory().set('rule', 'always test');

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      // Breakpoint on a HISTORY message — the volatile memory block in the
      // system parameter then sits upstream of the last breakpoint.
      .setHistory([{ role: 'user', content: 'q', _cache_breakpoint: true }]);

    await chef.compile({ target: 'anthropic' });
    await chef.compile({ target: 'anthropic' }); // second compile — no duplicate warning

    const auditWarns = logger.warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('cache audit'),
    );
    expect(auditWarns.length).toBeGreaterThanOrEqual(1);
    // once per DISTINCT issue — dedup across compiles
    const unique = new Set(auditWarns.map((c: unknown[]) => String(c[0])));
    expect(unique.size).toBe(auditWarns.length);
  });

  it('warns once per issue KIND even as the issue drifts through message positions', async () => {
    const logger = { warn: vi.fn() };
    const TaskSchema = z.object({ step: z.string() });
    const chef = new ContextChef({ logger, cacheAudit: true });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);

    // Breakpoint on the LAST user message + default 'last_user' dynamic state:
    // the volatile text merges into the breakpointed tail segment. As history
    // grows, the same misconfiguration moves from messages[0] to messages[2] —
    // a positional dedup key would warn again; the semantic key must not.
    chef
      .setHistory([{ role: 'user', content: 'q1', _cache_breakpoint: true }])
      .setDynamicState(TaskSchema, { step: 'one' });
    await chef.compile({ target: 'anthropic' });

    chef
      .setHistory([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2', _cache_breakpoint: true },
      ])
      .setDynamicState(TaskSchema, { step: 'two' });
    await chef.compile({ target: 'anthropic' });

    const auditWarns = logger.warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('cache audit'),
    );
    expect(auditWarns).toHaveLength(1);
  });

  it('does nothing on non-Anthropic targets and when disabled', async () => {
    const logger = { warn: vi.fn() };
    const chef = new ContextChef({
      logger,
      cacheAudit: true,
      memory: { store: new InMemoryStore() },
    });
    await chef.getMemory().set('rule', 'v');
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'q', _cache_breakpoint: true }]);

    await chef.compile({ target: 'openai' });

    const auditWarns = logger.warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('cache audit'),
    );
    expect(auditWarns).toHaveLength(0);
  });
});
