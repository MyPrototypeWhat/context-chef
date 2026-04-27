import { describe, expect, it } from 'vitest';
import { ContextChef, type Skill } from '../src/index';
import { InMemoryStore } from '../src/modules/memory/inMemoryStore';
import type { Message } from '../src/types';

const planning: Skill = {
  name: 'planning',
  description: 'Plan changes before editing',
  whenToUse: 'When the task is non-trivial and requires multiple steps',
  instructions: 'Read code, list affected files, write plan to scratchpad.',
  allowedTools: ['read_file', 'grep'],
};

const editing: Skill = {
  name: 'editing',
  description: 'Apply planned changes',
  instructions: 'Apply the plan one step at a time. Run tests after each change.',
};

describe('ContextChef.registerSkills / getRegisteredSkills', () => {
  it('round-trips registered skills', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning, editing]);
    const skills = chef.getRegisteredSkills();
    expect(skills.map((s) => s.name)).toEqual(['planning', 'editing']);
    expect(skills[0].description).toBe('Plan changes before editing');
  });

  it('returns a defensive copy from getRegisteredSkills', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    const copy = chef.getRegisteredSkills();
    copy[0].name = 'mutated';
    expect(chef.getRegisteredSkills()[0].name).toBe('planning');
  });

  it('does not retain references to caller-owned skill objects', () => {
    const chef = new ContextChef();
    const local: Skill = { ...planning };
    chef.registerSkills([local]);
    local.name = 'mutated-by-caller';
    expect(chef.getRegisteredSkills()[0].name).toBe('planning');
  });

  it('replaces the registered set on subsequent calls', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning, editing]);
    chef.registerSkills([editing]);
    expect(chef.getRegisteredSkills().map((s) => s.name)).toEqual(['editing']);
  });
});

describe('ContextChef.activateSkill', () => {
  it('activates a Skill object directly without registry lookup', () => {
    const chef = new ContextChef();
    const standalone: Skill = {
      name: 'standalone',
      description: 'Not registered',
      instructions: 'do the thing',
    };
    chef.activateSkill(standalone);
    const active = chef.getActiveSkill();
    expect(active).toBeDefined();
    expect(active?.name).toBe('standalone');
  });

  it('activates a registered skill by name', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning, editing]);
    chef.activateSkill('editing');
    expect(chef.getActiveSkill()?.name).toBe('editing');
  });

  it('throws when activating an unknown skill name', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    expect(() => chef.activateSkill('does-not-exist')).toThrow(/no skill named "does-not-exist"/);
  });

  it('throws and lists "(none)" when nothing is registered', () => {
    const chef = new ContextChef();
    expect(() => chef.activateSkill('whatever')).toThrow(/Available: \(none\)/);
  });

  it('clears the active skill when passed null', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    chef.activateSkill('planning');
    expect(chef.getActiveSkill()).toBeDefined();

    chef.activateSkill(null);
    expect(chef.getActiveSkill()).toBeUndefined();
  });

  it('returns this for chaining', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    expect(chef.activateSkill('planning')).toBe(chef);
    expect(chef.activateSkill(null)).toBe(chef);
  });

  it('returns a defensive copy from getActiveSkill', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    chef.activateSkill('planning');
    const got = chef.getActiveSkill();
    if (got) got.name = 'mutated';
    expect(chef.getActiveSkill()?.name).toBe('planning');
  });
});

describe('ContextChef.compile() — skill instructions injection', () => {
  it('injects skill instructions as a dedicated system message between systemPrompt and history', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'You are an expert.' }]);
    chef.setHistory([{ role: 'user', content: 'help' }]);
    chef.registerSkills([planning]);
    chef.activateSkill('planning');

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as unknown as Message[];

    // [systemPrompt, skillSystem, userHistory]
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are an expert.');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toBe(planning.instructions);
    expect(messages[2].role).toBe('user');
  });

  it('does not inject any extra system message when no skill is active', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'You are an expert.' }]);
    chef.setHistory([{ role: 'user', content: 'help' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.messages.length).toBe(2);
    // No second system message slot
    expect(payload.messages.filter((m) => m.role === 'system').length).toBe(1);
  });

  it('removes the injected system message after deactivation', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'You are an expert.' }]);
    chef.setHistory([{ role: 'user', content: 'help' }]);
    chef.registerSkills([planning]);

    chef.activateSkill('planning');
    const beforeOff = await chef.compile({ target: 'openai' });
    expect(beforeOff.messages.length).toBe(3);

    chef.activateSkill(null);
    const afterOff = await chef.compile({ target: 'openai' });
    expect(afterOff.messages.length).toBe(2);
  });

  it('updates the injected system message when switching skills', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sp' }]);
    chef.setHistory([{ role: 'user', content: 'go' }]);
    chef.registerSkills([planning, editing]);

    chef.activateSkill('planning');
    const first = await chef.compile({ target: 'openai' });
    expect(first.messages[1].content).toBe(planning.instructions);

    chef.activateSkill('editing');
    const second = await chef.compile({ target: 'openai' });
    expect(second.messages[1].content).toBe(editing.instructions);
  });

  it('exposes meta.activeSkillName when a skill is active', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sp' }]);
    chef.registerSkills([planning]);
    chef.activateSkill('planning');

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta?.activeSkillName).toBe('planning');
  });

  it('omits meta.activeSkillName when no skill is active', async () => {
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sp' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta?.activeSkillName).toBeUndefined();
  });
});

describe('ContextChef snapshot / restore — skill state', () => {
  it('persists activeSkillName and skillInstructions in the snapshot', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    chef.activateSkill('planning');

    const snap = chef.snapshot();
    expect(snap.activeSkillName).toBe('planning');
    expect(snap.skillInstructions).toBe(planning.instructions);
  });

  it('restores the active skill by name when the registry still contains it', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning, editing]);
    chef.activateSkill('planning');
    const snap = chef.snapshot();

    chef.activateSkill('editing');
    expect(chef.getActiveSkill()?.name).toBe('editing');

    chef.restore(snap);
    expect(chef.getActiveSkill()?.name).toBe('planning');
    expect(chef.getActiveSkill()?.instructions).toBe(planning.instructions);
  });

  it('restores instructions verbatim even when the registry is empty', async () => {
    // Snapshot from a chef that knows the skill
    const original = new ContextChef();
    original.registerSkills([planning]);
    original.activateSkill('planning');
    const snap = original.snapshot();

    // Fresh chef — registry empty — must still inject instructions on compile
    const fresh = new ContextChef();
    fresh.restore(snap);
    fresh.setSystemPrompt([{ role: 'system', content: 'sp' }]);

    const active = fresh.getActiveSkill();
    expect(active?.name).toBe('planning');
    expect(active?.instructions).toBe(planning.instructions);

    const payload = await fresh.compile({ target: 'openai' });
    expect(payload.messages[1].content).toBe(planning.instructions);
    expect(payload.meta?.activeSkillName).toBe('planning');
  });

  it('restoring a snapshot taken with no active skill clears activeSkill', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    const snap = chef.snapshot(); // no active skill

    chef.activateSkill('planning');
    expect(chef.getActiveSkill()).toBeDefined();

    chef.restore(snap);
    expect(chef.getActiveSkill()).toBeUndefined();
  });

  it('snapshot is backwards-compatible — missing skill fields restore cleanly', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);
    chef.activateSkill('planning');

    // Construct a legacy-shaped snapshot without skill fields
    const legacy = chef.snapshot();
    const stripped = { ...legacy };
    delete (stripped as { activeSkillName?: string }).activeSkillName;
    delete (stripped as { skillInstructions?: string }).skillInstructions;

    chef.restore(stripped);
    expect(chef.getActiveSkill()).toBeUndefined();
  });
});

describe('Skill ⊥ Pruner decoupling', () => {
  it('activateSkill does NOT mutate the Pruner blocklist', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning]);

    expect(chef.getPruner().getBlockedTools()).toEqual([]);

    chef.activateSkill('planning');
    expect(chef.getPruner().getBlockedTools()).toEqual([]);

    chef.activateSkill(null);
    expect(chef.getPruner().getBlockedTools()).toEqual([]);
  });

  it('activateSkill does NOT add or remove registered tools', () => {
    const chef = new ContextChef();
    chef.registerTools([
      { name: 'read_file', description: 'read', tags: ['file'] },
      { name: 'write_file', description: 'write', tags: ['file'] },
    ]);
    chef.registerSkills([planning]);

    const before = chef
      .getPruner()
      .getAllTools()
      .map((t) => t.name)
      .sort();

    chef.activateSkill('planning');
    const after = chef
      .getPruner()
      .getAllTools()
      .map((t) => t.name)
      .sort();
    expect(after).toEqual(before);
  });

  it('a developer-supplied blocklist is preserved across skill activation', () => {
    const chef = new ContextChef();
    chef.getPruner().setBlockedTools(['delete_file']);
    chef.registerSkills([planning]);

    chef.activateSkill('planning');
    expect(chef.getPruner().getBlockedTools()).toEqual(['delete_file']);

    chef.activateSkill(null);
    expect(chef.getPruner().getBlockedTools()).toEqual(['delete_file']);
  });
});

describe('Skill instructions placement relative to memory', () => {
  it('places the skill system message BEFORE the memory block (per spec §6.3)', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.getMemory().set('style', 'be concise');

    chef.setSystemPrompt([{ role: 'system', content: 'You are an expert.' }]);
    chef.setHistory([{ role: 'user', content: 'help' }]);
    chef.registerSkills([planning]);
    chef.activateSkill('planning');

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as unknown as Message[];

    // Order must be: [user system, skill system, memory system, user history]
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBe(3);
    expect(systemMessages[0].content).toBe('You are an expert.');
    expect(systemMessages[1].content).toBe(planning.instructions);
    expect(typeof systemMessages[2].content).toBe('string');
    expect(systemMessages[2].content as string).toContain('be concise');

    // Slot positions in the full message array — skill MUST come before memory
    const skillIdx = messages.findIndex((m) => m.content === planning.instructions);
    const memoryIdx = messages.findIndex(
      (m) =>
        m.role === 'system' && typeof m.content === 'string' && m.content.includes('be concise'),
    );
    expect(skillIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(-1);
    expect(skillIdx).toBeLessThan(memoryIdx);
  });
});

describe('ChefSnapshot — combined Pruner blocklist + active skill round-trip', () => {
  it('snapshot/restore preserves blocklist and active skill independently', () => {
    const chef = new ContextChef();
    chef.registerSkills([planning, editing]);

    chef.getPruner().setBlockedTools(['delete_file', 'drop_table']);
    chef.activateSkill('planning');

    const snap = chef.snapshot('combined');

    // Mutate both pieces of state in the same chef
    chef.getPruner().setBlockedTools([]);
    chef.activateSkill('editing');

    expect(chef.getPruner().getBlockedTools()).toEqual([]);
    expect(chef.getActiveSkill()?.name).toBe('editing');

    chef.restore(snap);

    expect(chef.getPruner().getBlockedTools()).toEqual(['delete_file', 'drop_table']);
    expect(chef.getActiveSkill()?.name).toBe('planning');
  });

  it('a fresh chef can restore a combined snapshot when registry is repopulated', () => {
    const source = new ContextChef();
    source.registerSkills([planning]);
    source.getPruner().setBlockedTools(['delete_file']);
    source.activateSkill('planning');
    const snap = source.snapshot();

    const target = new ContextChef();
    target.registerSkills([planning]);
    target.restore(snap);

    expect(target.getPruner().getBlockedTools()).toEqual(['delete_file']);
    expect(target.getActiveSkill()?.name).toBe('planning');
    expect(target.getActiveSkill()?.instructions).toBe(planning.instructions);
  });
});
