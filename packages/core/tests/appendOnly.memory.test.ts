/**
 * `ChefConfig.appendOnly`, concept two: what the model can pull is not pushed.
 *
 * Memory is stated once when the window starts — a snapshot of what the
 * selector picks — and after that only what the model was not told: the
 * host's own writes and TTL expiry. A write the model made through
 * `chef.handleTool` is already in the conversation as its tool result. Skill
 * instructions are events: appended once when a skill is activated or
 * switched, withdrawn with a tombstone. An explicit `'after_system'`
 * placement keeps them in the system prompt, where each change is a `system`
 * checkpoint.
 *
 * Conversations are compiled turn by turn from the first request, as an agent
 * loop does. Every expected message below is worked out by hand from the
 * host history, the memory store and what each turn appends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type ChefConfig,
  type ChefEvents,
  ContextChef,
  checkPrefixContinuity,
  InMemoryBackend,
  LEGACY_VOCABULARY,
  Prompts,
  UNIFIED_VOCABULARY,
} from '../src/index';
import type { MemoryStore } from '../src/modules/memory/memoryStore';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  OpenAIPayload,
  TargetPayload,
} from '../src/types';

const silent: ChefLogger = { warn: () => {} };
const TARGETS = ['anthropic', 'openai', 'gemini', 'openai-responses'] as const;
type Target = (typeof TARGETS)[number];
/** Behavior that does not depend on the wire runs on one target of each family. */
const THREE = ['anthropic', 'openai', 'gemini'] as const;

const user = (content: string): Message => ({ role: 'user', content });
const reply = (content: string, signature: string): Message => ({
  role: 'assistant',
  content,
  thinking: { thinking: `Reasoning signed ${signature}.`, signature },
});
const call = (id: string, signature: string): Message => ({
  role: 'assistant',
  content: '',
  thinking: { thinking: 'Search first.', signature },
  tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
});
const result = (id: string, content: string): Message => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

const turn1: Message[] = [user('Find the release date.')];
const turn2: Message[] = [...turn1, call('t1', 'SIG_1'), result('t1', '2026-09-28')];
const turn3: Message[] = [...turn2, reply('It is 2026-09-28.', 'SIG_2'), user('And the price?')];
const turn4: Message[] = [...turn3, reply('About $40.', 'SIG_3'), user('Thanks.')];
const turn5: Message[] = [...turn4, reply('You are welcome.', 'SIG_4'), user('Bye.')];

/** The host history of each turn, as Chat Completions sends it. */
const TURN1 = ['Find the release date.'];
const TOOL_LOOP = ['', '2026-09-28'];
const ANSWERED = ['It is 2026-09-28.', 'And the price?'];

// Every entry is written at this instant unless a test moves the clock, so its `updated_at` is known.
const NOW = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-01T00:01:00.000Z';

/** An entry as the `<memory>` block lists it. */
const entry = (key: string, value: string, updates = 1, at = NOW): string =>
  `<entry key="${key}">\n<metadata>\n- updated_at=${at}\n- update_count=${updates}\n</metadata>\n` +
  `<value>\n${value}\n</value>\n</entry>`;
const removed = (key: string): string => `<entry key="${key}" removed="true"/>`;
const memoryXml = (entries: string[]): string => `<memory>\n${entries.join('\n\n')}\n</memory>`;
/** The legacy snapshot: the entries the selector picked, then the key guidance. */
const snapshot = (entries: string[], keys: string[]): string =>
  `${Prompts.MEMORY_BLOCK_HEADER}\n${memoryXml(entries)}\n\nExisting memory keys: ` +
  `${keys.join(', ')}. Prefer updating these keys over creating new ones to maintain consistency.`;
const delta = (entries: string[]): string =>
  `${Prompts.MEMORY_DELTA_HEADER}\n${memoryXml(entries)}`;

const LANG = entry('lang', 'TypeScript');
const SNAPSHOT = snapshot([LANG], ['lang']);
const STYLE = entry('style', 'terse');

const ANCHOR = Prompts.EVENT_STATE_ANCHOR;
const State = z.object({ step: z.number() });
const state = (step: number, rev: number) =>
  `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>`;

const RESEARCHER = { name: 'researcher', description: 'Research', instructions: 'Cite sources.' };
const WRITER = { name: 'writer', description: 'Write', instructions: 'Write short paragraphs.' };
const skillEvent = (name: string, instructions: string, rev: number): string =>
  `<skill_instructions rev="${rev}" skill="${name}">\n` +
  `${rev > 1 ? `${Prompts.SKILL_RESTATED}\n\n` : ''}${instructions}\n</skill_instructions>`;
const skillWithdrawn = (rev: number): string =>
  `<skill_instructions rev="${rev}" withdrawn="true">${Prompts.SKILL_WITHDRAWN}</skill_instructions>`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/** A chef with memory over a fresh store; it checks the pipeline invariants and records what it reports. */
function chefWith(config: ChefConfig = {}) {
  const chef = new ContextChef({
    logger: silent,
    appendOnly: true,
    pipelineChecks: true,
    store: new InMemoryBackend(),
    memory: {},
    ...config,
  }).setSystemPrompt([{ role: 'system', content: 'You are terse.' }]);
  const breaks: ChefEvents['prefix:break'][] = [];
  const invariants: string[] = [];
  chef.on('prefix:break', (event) => {
    breaks.push(event);
  });
  chef.on('pipeline:invariant', ({ message }) => {
    invariants.push(message);
  });
  return { chef, breaks, invariants };
}

/** Compiles each turn in order, `setup` first, as the agent loop does. */
async function converse(
  chef: ContextChef,
  turns: Message[][],
  target: Target = 'openai',
  setup: (chef: ContextChef, turn: number) => unknown = () => {},
): Promise<TargetPayload[]> {
  const payloads: TargetPayload[] = [];
  for (const [i, history] of turns.entries()) {
    await setup(chef, i + 1);
    payloads.push(await chef.setHistory(history).compile({ target }));
  }
  return payloads;
}

function expectAppendOnly(payloads: TargetPayload[]) {
  for (let i = 1; i < payloads.length; i++) {
    expect(checkPrefixContinuity(payloads[i - 1], payloads[i])).toEqual({ ok: true });
  }
}

/** Chat Completions message contents: the plainest view of the window. */
const contents = (payload: TargetPayload): string[] =>
  (payload as OpenAIPayload).messages.map((m) => String(m.content));
const roles = (payload: TargetPayload): string[] =>
  (payload as OpenAIPayload).messages.map((m) => m.role);
const injected = (payloads: TargetPayload[]) =>
  payloads.map((payload) => payload.meta?.injectedMemoryKeys);

/** What reaches the provider: the payload without `meta`. */
const wire = (payload: TargetPayload): Omit<TargetPayload, 'meta'> => {
  const { meta: _meta, ...rest } = payload;
  return rest;
};

const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);

const occurrences = (payload: TargetPayload, text: string): number =>
  JSON.stringify(wire(payload)).split(escaped(text)).length - 1;

/** Each of `texts` is sent exactly once, in this order, whatever the target's message shape. */
function expectSentInOrder(payload: TargetPayload, texts: string[]) {
  const sent = JSON.stringify(wire(payload));
  for (const text of texts) expect(occurrences(payload, text), text).toBe(1);
  const at = texts.map((text) => sent.indexOf(escaped(text)));
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

const createMemory = (key: string, value: string) => ({
  name: 'create_memory',
  arguments: JSON.stringify({ key, value }),
});

describe('appendOnly memory: one snapshot when the window starts', () => {
  it.each(
    THREE,
  )('keeps every turn the prefix of the next while memory changes (%s)', async (target) => {
    const { chef, breaks, invariants } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await chef.getMemory().set('session', 'abc', { ttl: 3 });

    const payloads = await converse(
      chef,
      [turn1, turn2, turn3, turn4, turn5],
      target,
      async (c, turn) => {
        if (turn === 2) await c.getMemory().set('style', 'terse');
        if (turn === 3) await c.handleTool(createMemory('tz', 'UTC'));
      },
    );

    expectAppendOnly(payloads);
    expect(breaks).toEqual([]);
    expect(invariants).toEqual([]);
    // Turn 4's sweep expired `session`; the model wrote `tz` itself.
    expect(injected(payloads)).toEqual([['lang', 'session'], ['style'], [], ['session'], []]);
  });

  it('pushes the snapshot right after the request, as a user message of its own', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const [first, second] = await converse(chef, [turn1, turn2]);

    expect(contents(first)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
    ]);
    expect(roles(first)).toEqual(['system', 'system', 'user', 'user']);
    expect(contents(second)).toEqual([...contents(first), ...TOOL_LOOP]);
    expect(injected([first, second])).toEqual([['lang'], []]);
  });

  it('never merges memory into a host message on Anthropic', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const [first, second] = (await converse(chef, [turn1, turn3], 'anthropic')) as [
      AnthropicPayload,
      AnthropicPayload,
    ];

    expect(first.system).toEqual([
      { type: 'text', text: 'You are terse.' },
      { type: 'text', text: Prompts.MEMORY_INSTRUCTION },
    ]);
    expect(first.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      { role: 'user', content: [{ type: 'text', text: SNAPSHOT }] },
    ]);
    expect(second.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'And the price?' }],
    });
    expectAppendOnly([first, second]);
  });

  it('pushes nothing more on a retry of the same request', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const [first, retried] = await converse(chef, [turn1, turn1]);

    expect(wire(retried)).toEqual(wire(first));
    expect(injected([first, retried])).toEqual([['lang'], []]);
  });

  it('pushes no snapshot while memory is empty, and one once the host writes', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2], 'openai', async (c, turn) => {
      if (turn === 2) await c.getMemory().set('lang', 'TypeScript');
    });

    expect(contents(payloads[0])).toEqual(['You are terse.', Prompts.MEMORY_INSTRUCTION, ...TURN1]);
    expect(contents(payloads[1])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      ...TOOL_LOOP,
      SNAPSHOT,
    ]);
    expect(injected(payloads)).toEqual([[], ['lang']]);
  });

  it('does one store scan per compile', async () => {
    const entries = new Map<string, Parameters<MemoryStore['set']>[1]>();
    let scans = 0;
    const store: MemoryStore = {
      get: (key) => entries.get(key) ?? null,
      set: (key, value) => {
        entries.set(key, value);
      },
      delete: (key) => entries.delete(key),
      keys: () => {
        scans++;
        return [...entries.keys()];
      },
    };
    const { chef } = chefWith({ memory: { store } });
    await chef.getMemory().set('lang', 'TypeScript');

    for (const [i, history] of [turn1, turn2, turn3].entries()) {
      if (i === 1) await chef.getMemory().set('style', 'terse');
      const before = scans;
      await chef.setHistory(history).compile({ target: 'openai' });
      expect(scans - before).toBe(1);
    }
  });
});

describe('appendOnly memory: a delta for what the host changed', () => {
  it('appends a write of the host after the turn it was made in, and keeps the snapshot', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) {
        await c.getMemory().set('style', 'terse');
        await c.getMemory().set('lang', 'Rust');
      }
    });

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      ...TOOL_LOOP,
      // In the order the selector lists them.
      delta([entry('lang', 'Rust', 2), STYLE]),
      ...ANSWERED,
    ]);
    expect(injected(payloads)).toEqual([['lang'], ['lang', 'style'], []]);
  });

  it.each(THREE)('says an entry the host deleted is gone (%s)', async (target) => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await chef.getMemory().set('style', 'terse');

    const payloads = await converse(chef, [turn1, turn3], target, async (c, turn) => {
      if (turn === 2) await c.getMemory().delete('style');
    });

    expectAppendOnly(payloads);
    expectSentInOrder(payloads[1], [
      'Find the release date.',
      snapshot([LANG, STYLE], ['lang', 'style']),
      'It is 2026-09-28.',
      'And the price?',
      delta([removed('style')]),
    ]);
    expect(injected(payloads)).toEqual([['lang', 'style'], ['style']]);
  });

  it.each(THREE)('says an entry that expired is gone (%s)', async (target) => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    // Swept by the third compile: it expires at turn 2, and each compile counts one.
    await chef.getMemory().set('session', 'abc', { ttl: 2 });

    const payloads = await converse(chef, [turn1, turn2, turn3], target);

    expectAppendOnly(payloads);
    expectSentInOrder(payloads[2], [
      'Find the release date.',
      snapshot([LANG, entry('session', 'abc')], ['lang', 'session']),
      'It is 2026-09-28.',
      'And the price?',
      delta([removed('session')]),
    ]);
    expect(payloads.map((p) => p.meta?.memoryExpiredKeys)).toEqual([[], [], ['session']]);
    expect(injected(payloads)).toEqual([['lang', 'session'], [], ['session']]);
  });
});

describe('appendOnly memory: what the model wrote itself is not pushed back', () => {
  const writes: Array<[string, { name: string; arguments: unknown }]> = [
    ['create_memory', createMemory('style', 'terse')],
    [
      'modify_memory update',
      { name: 'modify_memory', arguments: { action: 'update', key: 'lang', value: 'Rust' } },
    ],
    [
      'modify_memory delete',
      { name: 'modify_memory', arguments: { action: 'delete', key: 'lang' } },
    ],
    [
      'context create',
      {
        name: 'context',
        arguments: { command: 'create', path: 'context://memory/style', file_text: 'terse' },
      },
    ],
    [
      'context str_replace',
      {
        name: 'context',
        arguments: {
          command: 'str_replace',
          path: 'context://memory/lang',
          old_str: 'TypeScript',
          new_str: 'Rust',
        },
      },
    ],
    [
      'context rename',
      {
        name: 'context',
        arguments: {
          command: 'rename',
          path: 'context://memory/lang',
          new_path: 'context://memory/language',
        },
      },
    ],
  ];

  it.each(writes)('appends nothing after %s', async (_name, toolCall) => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) expect(await c.handleTool(toolCall)).not.toMatch(/^Error/);
    });

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      ...TOOL_LOOP,
      ...ANSWERED,
    ]);
    expect(injected(payloads)).toEqual([['lang'], [], []]);
  });

  it('appends what the host changed after the model wrote it', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) {
        await c.handleTool(createMemory('style', 'terse'));
        await c.getMemory().set('style', 'verbose');
      }
    });

    expect(contents(payloads[1]).at(-1)).toBe(delta([entry('style', 'verbose', 2)]));
    expect(injected(payloads)).toEqual([['lang'], ['style'], []]);
  });

  it('tells a host write made while a tool call runs from the write of that call', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2], 'openai', async (c, turn) => {
      if (turn === 2) {
        await Promise.all([
          c.handleTool(createMemory('style', 'terse')),
          c.getMemory().set('tz', 'UTC'),
        ]);
      }
    });

    expect(contents(payloads[1]).at(-1)).toBe(delta([entry('tz', 'UTC')]));
    expect(injected(payloads)).toEqual([['lang'], ['tz']]);
  });

  it('says a key the model created is gone once it expired', async () => {
    // Created after the first compile, it expires two compiles later: the fourth sweeps it.
    const { chef } = chefWith({ memory: { defaultTTL: 2 } });

    const payloads = await converse(
      chef,
      [turn1, turn2, turn3, turn4],
      'openai',
      async (c, turn) => {
        if (turn === 2) await c.handleTool(createMemory('scratch', 'x'));
      },
    );

    expect(payloads.map((p) => p.meta?.memoryExpiredKeys)).toEqual([[], [], [], ['scratch']]);
    expect(injected(payloads)).toEqual([[], [], [], ['scratch']]);
    expect(contents(payloads[3]).at(-1)).toBe(delta([removed('scratch')]));
  });
});

describe('appendOnly memory: the selector decides what is pushed', () => {
  it('pushes nothing while the selector picks nothing', async () => {
    const { chef } = chefWith({ memory: { selector: () => [] } });
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) await c.getMemory().set('style', 'terse');
      if (turn === 3) await c.getMemory().delete('lang');
    });

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      ...TOOL_LOOP,
      ...ANSWERED,
    ]);
    expect(injected(payloads)).toEqual([[], [], []]);
  });

  it("leaves the model to read memory through the 'context' tool under tools: 'unified'", async () => {
    const { chef } = chefWith({ tools: 'unified', memory: { selector: () => [] } });
    await chef.getMemory().set('lang', 'TypeScript');

    const [payload] = await converse(chef, [turn1]);

    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.CONTEXT_STORE_INSTRUCTION,
      ...TURN1,
    ]);
    expect(payload.tools?.map((tool) => tool.name)).toEqual(['context']);
    expect(
      await chef.handleTool({
        name: 'context',
        arguments: { command: 'view', path: 'context://memory/lang' },
      }),
    ).toBe('TypeScript');
  });

  it('never says an entry it stopped picking is gone', async () => {
    let hideLang = false;
    const { chef } = chefWith({
      memory: { selector: (all) => all.filter((e) => !(hideLang && e.key === 'lang')) },
    });
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) hideLang = true;
      // Changed while hidden: the selector keeps it out of the window.
      if (turn === 3) await c.getMemory().set('lang', 'Rust');
    });

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      ...TOOL_LOOP,
      ...ANSWERED,
    ]);
    expect(injected(payloads)).toEqual([['lang'], [], []]);
  });

  it('never says an entry is gone because the selector trimmed its argument in place', async () => {
    // The newest entry only, sorted and trimmed in place.
    const { chef } = chefWith({
      memory: {
        selector: (all) => {
          all.sort((a, b) => b.updatedAt - a.updatedAt);
          all.splice(1);
          return all;
        },
      },
    });
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2], 'openai', async (c, turn) => {
      if (turn === 2) {
        vi.setSystemTime(new Date(LATER));
        await c.getMemory().set('style', 'terse');
      }
    });

    expect(contents(payloads[1]).at(-1)).toBe(delta([entry('style', 'terse', 1, LATER)]));
    expect(injected(payloads)).toEqual([['lang'], ['style']]);
  });
});

describe('appendOnly memory: after a checkpoint, what the window lost is stated again', () => {
  it('pushes no second snapshot while the first is still in the window', async () => {
    const { chef, breaks } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1, turn2, turn3]);

    // The host rewrote the tool result, after the snapshot.
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited]);

    // [system ×2, user, snapshot, call, result*, …]: the edited result is window index 3.
    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 3]]);
    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      '',
      '2026-09-29',
      ...ANSWERED,
    ]);
    expect(payload.meta?.injectedMemoryKeys).toEqual([]);
  });

  it.each(THREE)('pushes the snapshot again once a checkpoint dropped it (%s)', async (target) => {
    const { chef, breaks } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1, turn2, turn3], target);

    // The host rewrote the first request, which the snapshot followed.
    const edited = [...turn3];
    edited[0] = user('Find the launch date.');
    const [restated] = await converse(chef, [edited], target);
    const [next] = await converse(
      chef,
      [[...edited, reply('About $40.', 'SIG_3'), user('Thanks.')]],
      target,
    );

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 0]]);
    expectSentInOrder(restated, [
      'Find the launch date.',
      'It is 2026-09-28.',
      'And the price?',
      SNAPSHOT,
    ]);
    expect(restated.meta?.injectedMemoryKeys).toEqual(['lang']);
    expectAppendOnly([restated, next]);
  });

  it('states a change again when the checkpoint dropped the delta that carried it', async () => {
    const { chef, breaks } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1, turn2, turn3], 'openai', async (c, turn) => {
      if (turn === 2) await c.getMemory().set('style', 'terse');
    });

    // The delta followed the tool result the host rewrote; the snapshot came before it.
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited]);

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 3]]);
    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      '',
      '2026-09-29',
      ...ANSWERED,
      delta([STYLE]),
    ]);
  });

  it("states the model's own write once a checkpoint may have dropped the turn that made it", async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1, turn2], 'openai', async (c, turn) => {
      if (turn === 2) await c.handleTool(createMemory('style', 'terse'));
    });

    const edited = [...turn2];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited]);

    expect(contents(payload).at(-1)).toBe(delta([STYLE]));
  });

  it('pushes the snapshot again after clearHistory()', async () => {
    const { chef, breaks } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1, turn3]);

    chef.clearHistory();
    const [payload] = await converse(chef, [[user('New topic.')]]);

    expect(breaks.map((b) => b.reason)).toEqual(['ledger']);
    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      'New topic.',
      SNAPSHOT,
    ]);
  });

  it('forgets what the model wrote after the snapshot it restores', async () => {
    const { chef, breaks } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    await converse(chef, [turn1]);
    const saved = chef.snapshot();

    // The model wrote `style`; restoring the snapshot takes it out of memory and the history.
    await chef.handleTool(createMemory('style', 'terse'));
    chef.restore(saved);
    const [payload] = await converse(chef, [turn2]);

    expect(breaks).toEqual([]);
    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      SNAPSHOT,
      ...TOOL_LOOP,
    ]);
    expect(payload.meta?.injectedMemoryKeys).toEqual([]);
  });
});

describe('appendOnly memory: placement', () => {
  it("compiles an unset memoryPlacement as 'before_history_tail'", async () => {
    const unset = chefWith();
    const explicit = chefWith({ memory: { memoryPlacement: 'before_history_tail' } });
    const turns = [turn1, turn2, turn3];
    const setup = async (c: ContextChef, turn: number) => {
      if (turn === 1) await c.getMemory().set('lang', 'TypeScript');
      if (turn === 2) await c.getMemory().set('style', 'terse');
    };

    const a = await converse(unset.chef, turns, 'anthropic', setup);
    const b = await converse(explicit.chef, turns, 'anthropic', setup);

    expect(a.map(wire)).toEqual(b.map(wire));
    expect(unset.chef.getMemory().placement).toBe('before_history_tail');
    // appendOnly changes the default only: without it, an unset placement is 'after_system'.
    expect(
      new ContextChef({ store: new InMemoryBackend(), memory: {} }).getMemory().placement,
    ).toBe('after_system');
  });

  it.each(
    TARGETS,
  )("keeps an explicit 'after_system' in the system prompt, each change a `system` checkpoint (%s)", async (target) => {
    const { chef, breaks } = chefWith({ memory: { memoryPlacement: 'after_system' } });
    await chef.getMemory().set('lang', 'TypeScript');
    const payloads = await converse(chef, [turn1, turn2], target);

    await chef.getMemory().set('style', 'terse');
    const [changed] = await converse(chef, [turn3], target);

    expectAppendOnly(payloads);
    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['system', 0]]);
    expect(changed.meta?.prefix?.break?.reason).toBe('system');
    // As without appendOnly: the system prompt carries the data on every compile.
    expect(injected([...payloads, changed])).toEqual([['lang'], ['lang'], ['lang', 'style']]);
    expect(occurrences(changed, STYLE)).toBe(1);
  });

  it("sends an explicit 'after_system' where 4.x does", async () => {
    const { chef } = chefWith({ memory: { memoryPlacement: 'after_system' } });
    const off = new ContextChef({
      logger: silent,
      store: new InMemoryBackend(),
      memory: { memoryPlacement: 'after_system' },
    }).setSystemPrompt([{ role: 'system', content: 'You are terse.' }]);
    for (const c of [chef, off]) await c.getMemory().set('lang', 'TypeScript');

    const [payload] = await converse(chef, [turn1], 'anthropic');
    const [expected] = await converse(off, [turn1], 'anthropic');

    expect(wire(payload)).toEqual(wire(expected));
  });
});

describe('appendOnly memory: the unified vocabulary', () => {
  it('speaks of context://memory/ in the snapshot and the delta, and of no legacy tool', async () => {
    const { chef } = chefWith({ tools: 'unified' });
    await chef.getMemory().set('lang', 'TypeScript');

    const payloads = await converse(chef, [turn1, turn2], 'openai', async (c, turn) => {
      if (turn === 2) await c.getMemory().set('style', 'terse');
    });

    expect(contents(payloads[1])).toEqual([
      'You are terse.',
      Prompts.CONTEXT_STORE_INSTRUCTION,
      ...TURN1,
      `${Prompts.CONTEXT_MEMORY_BLOCK_HEADER}\n${memoryXml([LANG])}\n\nExisting memory keys: lang. ` +
        'Each one is editable at context://memory/<key> with the context tool — prefer updating ' +
        'an existing key over creating a new one.',
      ...TOOL_LOOP,
      `${Prompts.CONTEXT_MEMORY_DELTA_HEADER}\n${memoryXml([STYLE])}`,
    ]);
    for (const name of ['create_memory', 'modify_memory', 'recall_context']) {
      expect(JSON.stringify(wire(payloads[1]))).not.toContain(name);
    }
  });

  it('words a delta in each vocabulary', () => {
    expect(Prompts.MEMORY_DELTA_HEADER).toBe(
      'Your memory changed. These entries replace what you recalled under the same keys:',
    );
    expect(Prompts.CONTEXT_MEMORY_DELTA_HEADER).toBe(
      'Memory (context://memory/*) changed. These entries replace the earlier ones under the same keys:',
    );
    expect(LEGACY_VOCABULARY.memoryDelta('<memory>\n</memory>')).toBe(
      `${Prompts.MEMORY_DELTA_HEADER}\n<memory>\n</memory>`,
    );
    expect(UNIFIED_VOCABULARY.memoryDelta('<memory>\n</memory>')).toBe(
      `${Prompts.CONTEXT_MEMORY_DELTA_HEADER}\n<memory>\n</memory>`,
    );
  });
});

describe('appendOnly skills: instructions are events', () => {
  const skillChef = (config: ChefConfig = {}) => chefWith({ memory: undefined, ...config });

  it.each(
    TARGETS,
  )('keeps every turn the prefix of the next across activate, switch and deactivate (%s)', async (target) => {
    const { chef, breaks, invariants } = skillChef();

    const payloads = await converse(
      chef,
      [turn1, turn2, turn3, turn4, turn5],
      target,
      (c, turn) => {
        if (turn === 1) c.activateSkill(RESEARCHER);
        if (turn === 3) c.activateSkill(WRITER);
        if (turn === 4) c.activateSkill(null);
      },
    );

    expectAppendOnly(payloads);
    expect(breaks).toEqual([]);
    expect(invariants).toEqual([]);
  });

  it('appends the instructions once, as a system message after the request', async () => {
    const { chef } = skillChef();
    chef.activateSkill(RESEARCHER);

    const [first, second] = await converse(chef, [turn1, turn3]);

    expect(roles(first)).toEqual(['system', 'user', 'system']);
    expect(contents(first)).toEqual([
      'You are terse.',
      ...TURN1,
      skillEvent('researcher', 'Cite sources.', 1),
    ]);
    expect(contents(second)).toEqual([...contents(first), ...TOOL_LOOP, ...ANSWERED]);
    expect(second.meta?.activeSkillName).toBe('researcher');
  });

  it('puts it in a positional system message on Anthropic, out of the top-level system', async () => {
    const { chef } = skillChef();
    chef.activateSkill(RESEARCHER);

    const [payload] = (await converse(chef, [turn1], 'anthropic')) as [AnthropicPayload];

    expect(payload.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
    expect(payload.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      {
        role: 'system',
        content: [{ type: 'text', text: skillEvent('researcher', 'Cite sources.', 1) }],
      },
    ]);
  });

  it.each(
    THREE,
  )('appends a switch as the next revision and a deactivation as a tombstone (%s)', async (target) => {
    const { chef } = skillChef();

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4], target, (c, turn) => {
      if (turn === 1) c.activateSkill(RESEARCHER);
      if (turn === 2) c.activateSkill(WRITER);
      if (turn === 4) c.activateSkill(null);
    });

    expectSentInOrder(payloads[3], [
      'Find the release date.',
      skillEvent('researcher', 'Cite sources.', 1),
      skillEvent('writer', 'Write short paragraphs.', 2),
      'It is 2026-09-28.',
      'And the price?',
      'About $40.',
      'Thanks.',
      skillWithdrawn(3),
    ]);
  });

  it('appends nothing when the same skill is activated again', async () => {
    const { chef } = skillChef();

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', (c) =>
      c.activateSkill(RESEARCHER),
    );

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      ...TURN1,
      skillEvent('researcher', 'Cite sources.', 1),
      ...TOOL_LOOP,
      ...ANSWERED,
    ]);
  });

  it('says the restatement and the withdrawal in plain words', () => {
    expect(Prompts.SKILL_RESTATED).toBe(
      'These skill instructions replace any given earlier in this conversation.',
    );
    expect(Prompts.SKILL_WITHDRAWN).toBe(
      'No skill is active any more: the skill instructions given earlier no longer apply.',
    );
  });

  it("compiles an unset skillPlacement as 'tail'", async () => {
    const unset = skillChef();
    const explicit = skillChef({ skillPlacement: 'tail' });
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.activateSkill(RESEARCHER);
      if (turn === 2) c.activateSkill(WRITER);
    };

    const a = await converse(unset.chef, [turn1, turn2, turn3], 'anthropic', setup);
    const b = await converse(explicit.chef, [turn1, turn2, turn3], 'anthropic', setup);

    expect(a.map(wire)).toEqual(b.map(wire));
  });

  it.each(
    TARGETS,
  )("keeps an explicit 'after_system' in the system prompt, each switch a `system` checkpoint (%s)", async (target) => {
    const { chef, breaks } = skillChef({ skillPlacement: 'after_system' });
    chef.activateSkill(RESEARCHER);
    const payloads = await converse(chef, [turn1, turn2], target);

    chef.activateSkill(WRITER);
    const [switched] = await converse(chef, [turn3], target);

    expectAppendOnly(payloads);
    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['system', 0]]);
    expect(occurrences(switched, 'Write short paragraphs.')).toBe(1);
    expect(occurrences(switched, '<skill_instructions')).toBe(0);
  });
});

describe('appendOnly: skill, memory and state appended in one compile', () => {
  it('puts memory before the state in the user event, and the skill in the system event', async () => {
    const { chef } = chefWith();
    await chef.getMemory().set('lang', 'TypeScript');
    chef.activateSkill(RESEARCHER).setDynamicState(State, { step: 1 });

    const [payload] = await converse(chef, [turn1]);

    expect(roles(payload)).toEqual(['system', 'system', 'user', 'user', 'system']);
    expect(contents(payload)).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      ...TURN1,
      // Memory introduces itself: the anchor line speaks for the state alone, as in 4.x.
      [SNAPSHOT, state(1, 1), ANCHOR].join('\n\n'),
      skillEvent('researcher', 'Cite sources.', 1),
    ]);
  });
});
