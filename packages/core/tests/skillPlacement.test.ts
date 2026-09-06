import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContextChef, type Skill } from '../src/index';
import { InMemoryStore } from '../src/modules/memory/inMemoryStore';
import type { AnthropicPayload, Message } from '../src/types';

const ANCHOR = 'Above is the current system state. Use it to guide your next action.';

const planning: Skill = {
  name: 'planning',
  description: 'Plan before editing',
  instructions: 'Read code, list affected files, write a plan.',
};

const editing: Skill = {
  name: 'editing',
  description: 'Apply planned changes',
  instructions: 'Apply the plan one step at a time.',
};

interface PlainMessage {
  role: string;
  content: string;
}

function plain(payload: { messages: unknown }): PlainMessage[] {
  return JSON.parse(JSON.stringify(payload.messages));
}

const history = (): Message[] => [
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'q2' },
];

describe("skillPlacement 'tail'", () => {
  it('wraps the instructions into the tail stitch instead of a system message', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory(history())
      .activateSkill(planning);

    const messages = plain(await chef.compile({ target: 'openai' }));

    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).not.toContain(planning.instructions);

    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<skill_instructions skill="planning">');
    expect(last.content).toContain(planning.instructions);
    expect(last.content).toContain('</skill_instructions>');
  });

  it('leads the stitch — before memory data, dynamic state and implicit context', async () => {
    const chef = new ContextChef({
      skillPlacement: 'tail',
      memory: { store: new InMemoryStore(), memoryPlacement: 'before_history_tail' },
      onBeforeCompile: () => 'rag snippet',
    });
    await chef.getMemory().set('lang', 'TypeScript');
    chef.setHistory(history()).activateSkill(planning);
    chef.setDynamicState(z.object({ step: z.number() }), { step: 3 });

    const messages = plain(await chef.compile({ target: 'openai' }));
    const tail = messages[messages.length - 1].content;

    const skillAt = tail.indexOf('<skill_instructions');
    const memoryAt = tail.indexOf('<memory>');
    const stateAt = tail.indexOf('<dynamic_state>');
    const implicitAt = tail.indexOf('<implicit_context>');

    expect(skillAt).toBeGreaterThan(-1);
    expect(skillAt).toBeLessThan(memoryAt);
    expect(memoryAt).toBeLessThan(stateAt);
    expect(stateAt).toBeLessThan(implicitAt);
  });

  it('does not trigger the state anchor on its own', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef.setHistory(history()).activateSkill(planning);

    const messages = plain(await chef.compile({ target: 'openai' }));
    expect(JSON.stringify(messages)).not.toContain(ANCHOR);
  });

  it('still reports meta.activeSkillName', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef.setHistory(history()).activateSkill(planning);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta?.activeSkillName).toBe('planning');
  });

  it('injects nothing once the skill is deactivated', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef.setHistory(history()).activateSkill(planning).activateSkill(null);

    const messages = plain(await chef.compile({ target: 'openai' }));
    expect(JSON.stringify(messages)).not.toContain('<skill_instructions');
    expect(messages[messages.length - 1].content).toBe('q2');
  });

  it('creates a user message carrying the stitch when history ends in a tool result', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef.setHistory([
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
    ]);
    chef.activateSkill(planning);

    const messages = plain(await chef.compile({ target: 'openai' }));
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('<skill_instructions skill="planning">');
  });
});

describe("skillPlacement default 'after_system'", () => {
  it('keeps the pre-existing top-of-sandwich system message', async () => {
    const chef = new ContextChef();
    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory(history())
      .activateSkill(planning);

    const messages = plain(await chef.compile({ target: 'openai' }));
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
    expect(messages[1].content).toBe(planning.instructions);
    expect(messages[4].content).toBe('q2');
  });

  it('is bit-identical to passing the default explicitly', async () => {
    const build = async (placement?: 'after_system') => {
      const chef = new ContextChef(placement ? { skillPlacement: placement } : {});
      chef
        .setSystemPrompt([{ role: 'system', content: 'sys' }])
        .setHistory(history())
        .activateSkill(planning);
      const { meta: _meta, ...wire } = await chef.compile({ target: 'anthropic' });
      // `meta` carries the window id, which is unique per chef instance —
      // what has to be bit-identical is the payload the provider sees.
      return JSON.stringify(wire);
    };

    expect(await build()).toBe(await build('after_system'));
  });
});

describe("skillPlacement 'tail' — cache stability across mode switches", () => {
  const prefix = (payload: AnthropicPayload) =>
    JSON.stringify({
      system: payload.system ?? [],
      // Everything before the tail-carrying user message must stay byte-identical.
      messages: payload.messages.slice(0, payload.messages.length - 1),
    });

  it('leaves the cacheable prefix byte-identical across activate / switch / deactivate', async () => {
    const chef = new ContextChef({ skillPlacement: 'tail' });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory(history());

    const none = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    chef.activateSkill(planning);
    const first = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    chef.activateSkill(editing);
    const switched = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    chef.activateSkill(null);
    const cleared = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(prefix(first)).toBe(prefix(none));
    expect(prefix(switched)).toBe(prefix(none));
    expect(prefix(cleared)).toBe(prefix(none));

    // ...and the tail did change, so this is not a vacuous comparison.
    expect(JSON.stringify(first.messages.at(-1))).toContain('planning');
    expect(JSON.stringify(switched.messages.at(-1))).toContain('editing');
  });

  it("'after_system' by contrast rewrites the cached system prefix on a switch", async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory(history());

    chef.activateSkill(planning);
    const first = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
    chef.activateSkill(editing);
    const switched = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(JSON.stringify(first.system)).not.toBe(JSON.stringify(switched.system));
  });
});
