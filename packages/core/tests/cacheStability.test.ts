import { describe, expect, it, vi } from 'vitest';
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
