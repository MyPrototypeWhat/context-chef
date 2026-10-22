/**
 * `ChefConfig.appendOnly`, detection half: every compile rebuilds the window
 * from (host history, ledger), applies whatever rewrote what was already sent
 * as a checkpoint, reports it, and commits. Nothing is appended yet, so with
 * no rewrite the window is the host history and the wire is the 4.x wire.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type ChefConfig,
  type ChefEvents,
  type ChefSnapshot,
  ContextChef,
  checkPrefixContinuity,
  fromAnthropic,
  PrefixLedger,
  type PrefixLedgerSnapshot,
} from '../src/index';
import { Assembler } from '../src/modules/assembler';
import type { ChefLogger, Message, TargetPayload, ToolDefinition } from '../src/types';

const silent: ChefLogger = { warn: () => {} };
const TARGETS = ['anthropic', 'openai', 'gemini', 'openai-responses'] as const;
type Target = (typeof TARGETS)[number];

const user = (content: string): Message => ({ role: 'user', content });
const reply = (content: string, signature: string): Message => ({
  role: 'assistant',
  content,
  thinking: { thinking: `Thinking about "${content}"`, signature },
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

// An agent loop as the host records it, one history per compile.
const turn1: Message[] = [user('Find the release date.')];
const turn2: Message[] = [...turn1, call('t1', 'SIG_1'), result('t1', '2026-09-28')];
const turn3: Message[] = [...turn2, reply('It is 2026-09-28.', 'SIG_2'), user('And the price?')];
// Three replies: further along than a fresh chef should ever be.
const turn4: Message[] = [...turn3, reply('About $40.', 'SIG_3'), user('Thanks.')];

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

const chefWith = (config: ChefConfig = {}): ContextChef =>
  new ContextChef({ logger: silent, appendOnly: true, ...config }).setSystemPrompt([
    { role: 'system', content: 'You are terse.' },
  ]);

const compileAt = (chef: ContextChef, history: Message[], target: Target = 'anthropic') =>
  chef.setHistory(history).compile({ target });

/** Compiles each turn in order, as the agent loop does; the last payload. */
async function converse(
  chef: ContextChef,
  turns: Message[][],
  target: Target = 'anthropic',
): Promise<TargetPayload> {
  let payload: TargetPayload | undefined;
  for (const history of turns) payload = await compileAt(chef, history, target);
  if (!payload) throw new Error('converse() needs a turn');
  return payload;
}

function breaksOf(chef: ContextChef): ChefEvents['prefix:break'][] {
  const breaks: ChefEvents['prefix:break'][] = [];
  chef.on('prefix:break', (event) => {
    breaks.push(event);
  });
  return breaks;
}

const wire = (payload: TargetPayload): string => {
  const { meta: _meta, ...rest } = payload;
  return Assembler.stringifyPayload(rest);
};

/** The whole payload, meta included, minus the window id every chef draws for itself. */
const comparable = (payload: TargetPayload): string =>
  Assembler.stringifyPayload({ ...payload, meta: { ...payload.meta, windowId: undefined } });

/**
 * A session whose ledger holds an event sent with turn 1. Its source is the
 * handoff notice, which is never stated again or withdrawn: a source the chef
 * keeps state for would be compared with it on the next compile.
 */
function sessionWithEvent(): ChefSnapshot {
  const ledger = new PrefixLedger();
  ledger.reconcile(turn1);
  ledger.append([{ channel: 'user', content: '<state>step 1</state>', sources: ['handoff'] }]);
  ledger.commit(turn1);
  return { ...chefWith().setHistory(turn1).snapshot(), prefixLedger: ledger.snapshot() };
}

describe('appendOnly off', () => {
  const State = z.object({ step: z.number() });
  const configure = (chef: ContextChef) =>
    chef
      .setSystemPrompt([{ role: 'system', content: 'You are terse.' }])
      .registerTools([search])
      .setDynamicState(State, { step: 1 })
      .withGuardrails({ enforceXML: { outputTag: 'answer' } })
      .announce('tools', 'Tool search_v2 is available.');

  it.each(
    TARGETS,
  )('compiles what a chef without the option compiles, meta included (%s)', async (target) => {
    const plain = configure(new ContextChef({ logger: silent }));
    const off = configure(new ContextChef({ logger: silent, appendOnly: false }));

    for (const history of [turn1, turn2, turn3]) {
      const expected = await compileAt(plain, history, target);
      const actual = await compileAt(off, history, target);
      expect(comparable(actual)).toBe(comparable(expected));
      expect(actual.meta).not.toHaveProperty('prefix');
    }
    expect(off.snapshot()).not.toHaveProperty('prefixLedger');
    expect(plain.snapshot()).not.toHaveProperty('prefixLedger');
  });
});

describe('appendOnly on, nothing rewritten', () => {
  it.each(TARGETS)('repeats the previous payload and appends to it (%s)', async (target) => {
    const chef = chefWith().registerTools([search]);
    const off = new ContextChef({ logger: silent })
      .setSystemPrompt([{ role: 'system', content: 'You are terse.' }])
      .registerTools([search]);
    const breaks = breaksOf(chef);

    const payloads: TargetPayload[] = [];
    for (const history of [turn1, turn2, turn3]) {
      const payload = await compileAt(chef, history, target);
      // Nothing is appended in this mode yet: the window is the host history.
      expect(wire(payload)).toBe(wire(await compileAt(off, history, target)));
      payloads.push(payload);
    }

    expect(checkPrefixContinuity(payloads[0], payloads[1])).toEqual({ ok: true });
    expect(checkPrefixContinuity(payloads[1], payloads[2])).toEqual({ ok: true });
    // Every window message of the turn before is still there.
    expect(payloads.map((p) => p.meta?.prefix)).toEqual([
      { stable: 0 },
      { stable: turn1.length },
      { stable: turn2.length },
    ]);
    expect(breaks).toEqual([]);
  });

  it('reads a tool schema that serializes through toJSON as unchanged', async () => {
    class Schema {
      toJSON() {
        return { type: 'object', properties: { q: { type: 'string' } } };
      }
    }
    const chef = chefWith().registerTools([
      {
        name: 'search',
        description: 'Search the web',
        parameters: new Schema() as unknown as Record<string, unknown>,
      },
    ]);
    const breaks = breaksOf(chef);

    await compileAt(chef, turn1);
    const next = await compileAt(chef, turn2);

    expect(breaks).toEqual([]);
    expect(next.meta?.prefix).toEqual({ stable: turn1.length });
  });
});

describe('appendOnly on, the host rewrote its history', () => {
  it('reports an edit of an earlier message as a `history` checkpoint at that message', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2, turn3]);

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const payload = await compileAt(chef, edited);

    // Thinking after the edit no longer matches what it was signed over: the reply at host[3].
    const brk = { reason: 'history', at: 2, signed: false, strippedThinking: 1 };
    expect(breaks).toEqual([{ ...brk, windowId: payload.meta?.windowId }]);
    expect(payload.meta?.prefix).toEqual({ stable: 2, break: brk });
  });

  it('strips no thinking off Anthropic, so it reports none', async () => {
    const chef = chefWith();
    await converse(chef, [turn1, turn2, turn3], 'gemini');

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const payload = await compileAt(chef, edited, 'gemini');

    expect(payload.meta?.prefix?.break).toEqual({
      reason: 'history',
      at: 2,
      signed: false,
      strippedThinking: 0,
    });
  });

  it('counts the break in window messages, events included', async () => {
    const chef = chefWith();
    chef.restore(sessionWithEvent());
    const breaks = breaksOf(chef);
    await compileAt(chef, turn3, 'openai');

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const payload = await compileAt(chef, edited, 'openai');

    // [user, event, call, result*, …]: host[2] sits at window index 3.
    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 3]]);
    expect(payload.meta?.prefix).toMatchObject({ stable: 3, break: { at: 3 } });
  });

  it('reports the checkpoint again when the compile that met it was aborted', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2, turn3]);
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');

    const controller = new AbortController();
    const abort = () => controller.abort();
    chef.use('before-assemble', abort);
    await expect(
      chef.setHistory(edited).compile({ target: 'anthropic', signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    chef.unuse('before-assemble', abort);

    const payload = await compileAt(chef, edited);
    expect(breaks.map((b) => b.reason)).toEqual(['history', 'history']);
    expect(payload.meta?.prefix).toEqual({
      stable: 2,
      break: { reason: 'history', at: 2, signed: false, strippedThinking: 1 },
    });
  });
});

describe('appendOnly on, what is sent ahead of the window changed', () => {
  it.each(
    TARGETS,
  )('reports a new system prompt as a `system` checkpoint at 0 (%s)', async (target) => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2, turn3], target);

    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    const changed = await compileAt(chef, turn3, target);
    const again = await compileAt(chef, turn3, target);

    // Every thinking block in the window was signed over the old prompt: SIG_1 and SIG_2.
    const brk = {
      reason: 'system',
      at: 0,
      signed: false,
      strippedThinking: target === 'anthropic' ? 2 : 0,
    };
    expect(breaks).toEqual([{ ...brk, windowId: changed.meta?.windowId }]);
    expect(changed.meta?.prefix).toEqual({ stable: 0, break: brk });
    expect(again.meta?.prefix).toEqual({ stable: turn3.length });
  });

  it('reports a changed tool list as a `tools` checkpoint at 0', async () => {
    const chef = chefWith().registerTools([search]);
    await converse(chef, [turn1, turn2]);

    chef.registerTools([search, { name: 'fetch', description: 'Fetch a URL' }]);
    const payload = await compileAt(chef, turn3);

    expect(payload.meta?.prefix).toEqual({
      stable: 0,
      break: { reason: 'tools', at: 0, signed: false, strippedThinking: 2 },
    });
  });

  it('keeps what it compared, untouched by an after-adapt handler that edits the payload', async () => {
    const chef = chefWith().registerTools([search]);
    const breaks = breaksOf(chef);
    chef.use('after-adapt', (payload) => {
      payload.tools?.push({ name: 'debug', description: 'Added after the chef built the payload' });
    });

    const payloads: TargetPayload[] = [];
    for (const history of [turn1, turn2, turn3]) payloads.push(await compileAt(chef, history));

    expect(breaks).toEqual([]);
    expect(payloads.map((p) => p.meta?.prefix)).toEqual([
      { stable: 0 },
      { stable: turn1.length },
      { stable: turn2.length },
    ]);
  });

  it('rolls back a compile that failed after a `system` checkpoint, and reports it again', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2, turn3]);
    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);

    const fail = () => {
      throw new Error('after-adapt failed');
    };
    chef.use('after-adapt', fail);
    await expect(compileAt(chef, turn3)).rejects.toThrow('after-adapt failed');
    chef.unuse('after-adapt', fail);
    const retried = await compileAt(chef, turn3);
    const settled = await compileAt(chef, turn3);

    // The failed compile's checkpoint was never sent: the retry strips the same two blocks.
    const brk = { reason: 'system', at: 0, signed: false, strippedThinking: 2 };
    const windowId = retried.meta?.windowId;
    expect(breaks).toEqual([
      { ...brk, windowId },
      { ...brk, windowId },
    ]);
    expect(retried.meta?.prefix).toEqual({ stable: 0, break: brk });
    expect(settled.meta?.prefix).toEqual({ stable: turn3.length });
    expect(chef.snapshot().prefixLedger?.stripped).toEqual([[0, turn3.length]]);
  });

  it('counts only the thinking no earlier checkpoint stripped', async () => {
    const chef = chefWith();
    await converse(chef, [turn1, turn2, turn3]);
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    await compileAt(chef, edited); // strips host[2, 5): SIG_2

    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    const payload = await compileAt(chef, edited);

    expect(payload.meta?.prefix?.break).toEqual({
      reason: 'system',
      at: 0,
      signed: false,
      strippedThinking: 1,
    });
  });

  it('reports each checkpoint of a compile, and the one nearest the start in meta', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2, turn3]);

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    const payload = await compileAt(chef, edited);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['history', 2, 1],
      ['system', 0, 1],
    ]);
    expect(payload.meta?.prefix).toEqual({
      stable: 0,
      break: { reason: 'system', at: 0, signed: false, strippedThinking: 2 },
    });
  });

  it('leaves the ledger to the outer compile when a hook compiles inside it', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    await converse(chef, [turn1, turn2]);

    // A sub-payload for another target: had it touched the ledger, its system
    // prompt would read as a change, and the real request as another.
    let inner: TargetPayload | undefined;
    const compileInside = async () => {
      chef.off('compile:start', compileInside);
      inner = await chef.compile({ target: 'openai' });
    };
    chef.on('compile:start', compileInside);
    const outer = await compileAt(chef, turn3);

    expect(inner?.meta).not.toHaveProperty('prefix');
    expect(breaks).toEqual([]);
    expect(outer.meta?.prefix).toEqual({ stable: turn2.length });
  });
});

describe('appendOnly on, a ledger that never saw the conversation', () => {
  it('reports a history that already holds a reply as a `ledger` checkpoint at 0', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);

    // Those replies answered requests this ledger never saw: their thinking is stripped.
    const payload = await compileAt(chef, turn3);
    const next = await compileAt(chef, turn4);

    const brk = { reason: 'ledger', at: 0, signed: false, strippedThinking: 2 };
    expect(breaks).toEqual([{ ...brk, windowId: payload.meta?.windowId }]);
    expect(payload.meta?.prefix).toEqual({ stable: 0, break: brk });
    expect(next.meta?.prefix).toEqual({ stable: turn3.length });
  });

  it('starts a conversation nobody has answered yet with nothing to report', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);

    const payload = await compileAt(chef, turn1);

    expect(breaks).toEqual([]);
    expect(payload.meta?.prefix).toEqual({ stable: 0 });
  });

  it('starts one that opens on a prefill, or right after clearHistory(), with nothing to report', async () => {
    const prefilled = chefWith();
    const cleared = chefWith().clearHistory();
    const breaks = [breaksOf(prefilled), breaksOf(cleared)];

    await compileAt(prefilled, [...turn1, { role: 'assistant', content: '{"date":' }]);
    await compileAt(cleared, turn1);

    expect(breaks).toEqual([[], []]);
  });

  it.each([
    'anthropic',
    'openai',
  ] as const)('starts one resumed from a compaction block with nothing to report, until a reply follows it (%s)', async (target) => {
    // fromAnthropic puts its placeholder user in front of the block the session got back.
    const { history: resumed } = fromAnthropic([
      {
        role: 'assistant',
        content: [{ type: 'compaction', content: 'SUMMARY 0', signature: 'SIG_BLOCK_0' }],
      },
    ] as unknown as MessageParam[]);
    const fresh = chefWith();
    const kept = chefWith();
    const breaks = [breaksOf(fresh), breaksOf(kept)];

    await compileAt(fresh, [...resumed, ...turn1], target);
    await compileAt(kept, [...resumed, ...turn3], target);

    // The block answered nothing this ledger never saw; a reply after it did.
    expect(breaks[0]).toEqual([]);
    expect(breaks[1].map(({ reason, at }) => [reason, at])).toEqual([['ledger', 0]]);
  });
});

describe('appendOnly on, the ledger across sessions', () => {
  it('keeps the prefix through snapshot and restore', async () => {
    const before = chefWith();
    const first = await converse(before, [turn1, turn2]);
    const persisted = JSON.parse(JSON.stringify(before.snapshot())) as ChefSnapshot;
    expect(persisted.prefixLedger).toBeDefined();

    const after = chefWith();
    const breaks = breaksOf(after);
    after.restore(persisted);
    const second = await compileAt(after, turn3);

    expect(breaks).toEqual([]);
    expect(checkPrefixContinuity(first, second)).toEqual({ ok: true });
    expect(second.meta?.prefix).toEqual({ stable: turn2.length });
  });

  it('restores the events the ledger recorded with the history', async () => {
    const chef = chefWith();
    chef.restore(sessionWithEvent());
    const payload = await compileAt(chef, turn2, 'openai');

    expect(payload.messages.map((m) => m.content)).toEqual([
      'You are terse.',
      'Find the release date.',
      '<state>step 1</state>',
      '',
      '2026-09-28',
    ]);
  });

  it('reports a history restored without its ledger as a `ledger` checkpoint', async () => {
    const chef = chefWith();
    const breaks = breaksOf(chef);
    chef.restore({ ...sessionWithEvent(), prefixLedger: undefined });

    const payload = await compileAt(chef, turn3);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([['ledger', 0, 2]]);
    expect(payload.meta?.prefix).toMatchObject({ stable: 0, break: { reason: 'ledger' } });
    expect(JSON.stringify(payload.messages)).not.toContain('step 1');
  });

  it('refuses a snapshot whose ledger it cannot read, before restoring any of it', async () => {
    const chef = chefWith();
    await converse(chef, [turn1, turn2]);
    const unreadable = {
      ...chef.snapshot(),
      history: turn3,
      prefixLedger: { version: 2 } as unknown as PrefixLedgerSnapshot,
    };

    expect(() => chef.restore(unreadable)).toThrow(/version/);
    expect(chef.snapshot().history).toEqual(turn2);
    expect((await chef.compile({ target: 'anthropic' })).meta?.prefix).toEqual({
      stable: turn2.length,
    });
  });

  it('starts over on clearHistory(), reporting a `ledger` checkpoint', async () => {
    const chef = chefWith();
    chef.restore(sessionWithEvent());
    await compileAt(chef, turn2);
    const breaks = breaksOf(chef);

    chef.clearHistory();
    const fresh = [user('New topic.')];
    const payload = await compileAt(chef, fresh);
    const next = await compileAt(chef, [...fresh, reply('Sure.', 'SIG_9'), user('Go on.')]);

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['ledger', 0]]);
    expect(payload.meta?.prefix).toEqual({
      stable: 0,
      break: { reason: 'ledger', at: 0, signed: false, strippedThinking: 0 },
    });
    // The event belonged to the conversation that was cleared.
    expect(payload.messages).toHaveLength(1);
    expect(next.meta?.prefix).toEqual({ stable: 1 });
  });

  it('carries a clearHistory() the next compile has not reported through a snapshot', async () => {
    const chef = chefWith();
    await converse(chef, [turn1, turn2]);
    chef.clearHistory();

    const restored = chefWith();
    const breaks = breaksOf(restored);
    restored.restore(JSON.parse(JSON.stringify(chef.snapshot())));
    await compileAt(restored, [user('New topic.')]);

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['ledger', 0]]);
  });

  it('warns once when a fresh chef meets a conversation its ledger never saw', async () => {
    const warn = vi.fn();
    const ledgerWarnings = () =>
      warn.mock.calls.filter(([message]) => String(message).includes('prefixLedger'));

    const perRequest = chefWith({ logger: { warn } });
    await compileAt(perRequest, turn4);
    await compileAt(perRequest, turn4);
    expect(ledgerWarnings()).toHaveLength(1);
    expect(ledgerWarnings()[0][0]).toMatch(/thinking/);

    warn.mockClear();
    await compileAt(chefWith({ logger: { warn } }), turn3);
    const restored = chefWith({ logger: { warn } });
    restored.restore({ ...perRequest.snapshot(), history: turn4 });
    await compileAt(restored, turn4);
    expect(ledgerWarnings()).toEqual([]);
  });
});
