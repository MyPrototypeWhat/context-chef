/**
 * `appendOnly` for the framework integrations: one session per conversation
 * keeps a prefix ledger, so each call's window repeats what the previous call
 * sent and only appends — dynamic state as events, a landed compression as
 * the head every later call replays.
 *
 * The tokenizer counts 10 tokens a message against a trigger of 60 and a raw
 * window of 100, as the chef's own appendOnly overflow tests do: a window of 7
 * messages is over the trigger and one of 11 past the raw window. Every
 * expected message is worked out by hand.
 */

import { describe, expect, it, vi } from 'vitest';
import { type OverflowStrategy, onDemandCompaction, server, summarize } from '../overflow';
import { unchanged } from '../overflow/types';
import { checkSentPrefix, type SentPayload } from '../pipeline/checks';
import { isReply } from '../prefix';
import { Prompts } from '../prompts';
import type { Message } from '../types';
import { createJanitorPool } from './janitorPool';
import {
  createPrefixSessionPool,
  type PrefixSessionCall,
  type PrefixSessionPoolConfig,
} from './prefixSession';

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
  tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
});
const result = (id: string, content: string): Message => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

// q1 a1 q2 a2 …: reply i is signed SIG_i. One array, so every call shares the host's objects.
const qa: Message[] = [user('q1')];
for (let i = 1; i < 12; i++) qa.push(reply(`a${i}`, `SIG_${i}`), user(`q${i + 1}`));
/** The host history when question `n` is asked: q1 a1 q2 … qn. */
const asked = (n: number): Message[] => qa.slice(0, 2 * n - 1);

// q1, then tool round i: a call t_i signed SIG_i and its result r_i.
const loop: Message[] = [user('q1')];
for (let i = 1; i <= 8; i++) loop.push(call(`t${i}`, `SIG_${i}`), result(`t${i}`, `r${i}`));
/** The host history after `n` tool rounds. */
const rounds = (n: number): Message[] => loop.slice(0, 1 + 2 * n);

const SUMMARY = (n: number) => Prompts.getCompactSummaryWrapper(`SUMMARY ${n}`);
const ANCHOR = Prompts.EVENT_STATE_ANCHOR;
const stateXml = (step: number) => `<dynamic_state>\n  <step>${step}</step>\n</dynamic_state>`;
/** The user event one call appends for dynamic state `step` at revision `rev`. */
const stateEvent = (step: number, rev: number): Message => ({
  role: 'user',
  content: `${Prompts.getEventBlock(stateXml(step), rev)}\n\n${ANCHOR}`,
  _chef_event: true,
});

const tokenizer = (messages: Message[]): number => messages.length * 10;
type CompressionModel = (messages: Message[]) => Promise<string>;
const keepLast = (turns: number) => (compressionModel: CompressionModel) =>
  summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: turns });
/** The integration's own thinking removal; here the IR fields are all there is. */
const stripIR = ({ thinking: _thinking, redacted_thinking: _redacted, ...rest }: Message) => rest;
/**
 * The integration's signed thinking: here, IR thinking with a signature. A
 * reply whose thinking carries none was not signed, and stays as it is.
 */
const signedIR = {
  count: (m: Message) => (m.thinking?.signature ? 1 : 0) + (m.redacted_thinking ? 1 : 0),
  strip(m: Message): Message | undefined {
    if (signedIR.count(m) === 0) return m;
    const rest = stripIR(m);
    return rest.content || rest.tool_calls?.length ? rest : undefined;
  },
};

/** A pool whose compression model answers `SUMMARY 1`, `SUMMARY 2`, … in turn. */
function poolWith(
  overrides: Partial<PrefixSessionPoolConfig<string[]>> = {},
  strategy: (compressionModel: CompressionModel) => OverflowStrategy = keepLast(1),
) {
  let summaries = 0;
  const compressionModel = vi.fn(
    async (_messages: Message[]) => `<summary>SUMMARY ${++summaries}</summary>`,
  );
  const strip = vi.fn(signedIR.strip);
  const logger = { warn: vi.fn() };
  const pool = createPrefixSessionPool<string[]>({
    contextWindow: 100,
    compress: { triggerRatio: 0.6 },
    tokenizer,
    overflow: { strategy: strategy(compressionModel) },
    toHostMessages: (messages) => messages.map((m) => m.content),
    signedThinking: { count: signedIR.count, strip },
    logger,
    ...overrides,
  });
  return { pool, session: pool.get('s1'), compressionModel, strip, logger };
}

/** Nothing configured to compress: the session has no Janitor. */
const NO_COMPRESSION = { compress: undefined, overflow: undefined };

const SENT = { system: [{ role: 'system', content: 'You are terse.' }] };
const callWith = (history: Message[], extra: Partial<PrefixSessionCall> = {}) => ({
  history,
  sent: SENT,
  ...extra,
});

/** A window sent, as the cross-turn check compares the next one with it. */
function sentPayload(messages: Message[]): SentPayload {
  let replied = 0;
  messages.forEach((message, i) => {
    if (isReply(message)) replied = i + 1;
  });
  return { payload: { messages }, replied, asked: messages.length, hostLength: 0 };
}

/** Each window repeats the one before it and only appends: every call was answered. */
function expectAppendOnly(windows: Message[][]) {
  for (let i = 1; i < windows.length; i++) {
    expect(checkSentPrefix(sentPayload(windows[i - 1]), { messages: windows[i] }, true)).toEqual(
      [],
    );
  }
}

describe('PrefixSession: dynamic state as events', () => {
  it('appends the state once where it changed, so every window repeats the one before', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    const [q1, c1, r1] = rounds(1);
    const [a1, q2] = [reply('a1', 'SIG_A'), user('q2')];
    const windows: Message[][] = [];
    for (const [i, history] of [[q1], [q1, c1, r1], [q1, c1, r1, a1, q2]].entries()) {
      const state = stateXml(i + 1);
      windows.push((await session.compile(callWith(history, { dynamicState: state }))).messages);
    }

    expect(windows).toEqual([
      [q1, stateEvent(1, 1)],
      [q1, stateEvent(1, 1), c1, r1, stateEvent(2, 2)],
      [q1, stateEvent(1, 1), c1, r1, stateEvent(2, 2), a1, q2, stateEvent(3, 3)],
    ]);
    expectAppendOnly(windows);
  });

  it('appends nothing while the state stays the same', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    const first = await session.compile(callWith(asked(1), { dynamicState: stateXml(1) }));
    const second = await session.compile(callWith(asked(2), { dynamicState: stateXml(1) }));

    expect(first.messages).toEqual([qa[0], stateEvent(1, 1)]);
    expect(second.messages).toEqual([qa[0], stateEvent(1, 1), qa[1], qa[2]]);
  });

  it('holds a new state while tool calls wait for their results', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    const [q1, c1, r1] = rounds(1);
    await session.compile(callWith([q1], { dynamicState: stateXml(1) }));
    const waiting = await session.compile(callWith([q1, c1], { dynamicState: stateXml(2) }));
    const answered = await session.compile(callWith([q1, c1, r1], { dynamicState: stateXml(2) }));

    expect(waiting.messages).toEqual([q1, stateEvent(1, 1), c1]);
    expect(answered.messages).toEqual([q1, stateEvent(1, 1), c1, r1, stateEvent(2, 2)]);
  });
});

describe('PrefixSession: a compression lands once as the head', () => {
  it('replays the head on later calls instead of summarizing again', async () => {
    const { session, compressionModel, strip } = poolWith();
    const calls = [];
    for (const n of [1, 2, 3, 4, 5, 6]) calls.push(await session.compile(callWith(asked(n))));
    const summary: Message = { role: 'user', content: SUMMARY(1) };
    const [q4, a4, q5, a5, q6] = qa.slice(6, 11);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(calls[3].messages).toEqual([summary, q4]);
    expect(calls[3].breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 0 },
    ]);
    expect(calls[4].messages).toEqual([summary, q4, a4, q5]);
    expect(calls[5].messages).toEqual([summary, q4, a4, q5, a5, q6]);
    expect(calls[4].breaks).toEqual([]);
    expect(calls[5].breaks).toEqual([]);
    // a4 and a5 came after the checkpoint: their thinking was signed over the summary.
    expect(strip.mock.calls.map(([message]) => message)).not.toContain(a4);
    expect(calls[5].messages[2]).toBe(a4);
    expect(calls[5].messages[4]).toBe(a5);
    expectAppendOnly(calls.slice(3).map((c) => c.messages));
  });

  it('waits in a tool turn below the raw window, and collapses it past the window', async () => {
    const { session, compressionModel } = poolWith();
    const calls = [];
    for (const n of [0, 1, 2, 3, 4, 5, 6]) calls.push(await session.compile(callWith(rounds(n))));
    const summary: Message = { role: 'user', content: SUMMARY(1) };

    // Rounds 3 and 4 (7 and 9 messages) are over the trigger, in a tool turn: they wait.
    expect(calls[3].messages).toEqual(rounds(3));
    expect(calls[4].messages).toEqual(rounds(4));
    // Round 5 (11 messages) is past the raw window: the whole window collapses.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(calls[5].messages).toEqual([summary]);
    expect(calls[5].breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 0 },
    ]);
    expect(calls[6].messages).toEqual([summary, ...loop.slice(11, 13)]);
  });

  it("strips the kept turns' thinking through the integration, and states the state again", async () => {
    const { session, strip } = poolWith({}, keepLast(3));
    const calls = [];
    for (const n of [1, 2, 3, 4]) {
      calls.push(await session.compile(callWith(asked(n), { dynamicState: stateXml(1) })));
    }
    const [q3, a3, q4] = qa.slice(4, 7);

    // asked(4) with the event is 8 messages: q1 E a1 q2 a2 q3 a3 q4. The last
    // three turns stay; a3's thinking was signed over what was summarized.
    expect(calls[3].messages).toEqual([
      { role: 'user', content: SUMMARY(1) },
      q3,
      stripIR(a3),
      q4,
      stateEvent(1, 1),
    ]);
    expect(calls[3].breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 1 },
    ]);
    expect(strip).toHaveBeenCalledWith(a3);
  });

  it("reports only the host's messages to onCompress, never the events, and what to write back", async () => {
    const onCompress = vi.fn();
    const { session } = poolWith({ onCompress });
    for (const n of [1, 2, 3, 4]) {
      await session.compile(callWith(asked(n), { dynamicState: stateXml(1) }));
    }

    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress.mock.calls[0].slice(1)).toEqual([
      6,
      { compressedMessages: ['q1', 'a1', 'q2', 'a2', 'q3', 'a3'], replacement: [SUMMARY(1)] },
    ]);
  });

  it('runs an on-demand compaction through its fallback: a session has no wire', async () => {
    const compact = vi.fn();
    const { session, compressionModel } = poolWith({}, (model) =>
      onDemandCompaction({ compact, fallback: keepLast(1)(model) }),
    );
    const calls = [];
    for (const n of [1, 2, 3, 4]) calls.push(await session.compile(callWith(asked(n))));

    expect(compact).not.toHaveBeenCalled();
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(calls[3].messages).toEqual([{ role: 'user', content: SUMMARY(1) }, qa[6]]);
    expect(calls[3].breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 0 },
    ]);
  });

  it('leaves the window alone when told not to compress', async () => {
    const { session, compressionModel } = poolWith();
    for (const n of [1, 2, 3]) await session.compile(callWith(asked(n)));
    const last = await session.compile(callWith(asked(4), { overflow: false }));

    expect(compressionModel).not.toHaveBeenCalled();
    expect(last.messages).toEqual(asked(4));
  });
});

describe('PrefixSession: checkpoints', () => {
  it('strips thinking from a changed message on, for good, and reports it', async () => {
    const { session, strip } = poolWith(NO_COMPRESSION);
    for (const n of [1, 2, 3]) await session.compile(callWith(asked(n)));
    const edited = reply('a1, edited', 'SIG_1x');
    const [q1, , q2, a2, q3, a3, q4] = asked(4);
    const changed = await session.compile(callWith([q1, edited, q2, a2, q3]));
    const later = await session.compile(callWith([q1, edited, q2, a2, q3, a3, q4]));

    expect(changed.breaks).toEqual([
      { reason: 'history', at: 1, signed: false, strippedThinking: 2 },
    ]);
    expect(changed.messages).toEqual([q1, stripIR(edited), q2, stripIR(a2), q3]);
    expect(later.breaks).toEqual([]);
    expect(later.messages).toEqual([q1, stripIR(edited), q2, stripIR(a2), q3, a3, q4]);
    expect(strip).toHaveBeenCalledWith(edited);
  });

  it('reports a checkpoint over thinking nothing signed, and leaves that thinking in place', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    const unsigned: Message = { role: 'assistant', content: 'a1', thinking: { thinking: 'Hm.' } };
    const [q1, , q2] = asked(2);
    await session.compile(callWith([q1]));
    await session.compile(callWith([q1, unsigned, q2]));
    const changed = await session.compile(callWith([user('q1, edited'), unsigned, q2]));

    expect(changed.breaks).toEqual([
      { reason: 'history', at: 0, signed: false, strippedThinking: 0 },
    ]);
    expect(changed.messages).toEqual([user('q1, edited'), unsigned, q2]);
  });

  it('leaves out a reply its signed thinking was all of', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    const thoughtOnly: Message = {
      role: 'assistant',
      content: '',
      thinking: { thinking: 'Hm.', signature: 'SIG_T' },
    };
    const [q1, , q2] = asked(2);
    await session.compile(callWith([q1]));
    await session.compile(callWith([q1, thoughtOnly, q2]));
    const changed = await session.compile(callWith([user('q1, edited'), thoughtOnly, q2]));

    expect(changed.breaks).toEqual([
      { reason: 'history', at: 0, signed: false, strippedThinking: 1 },
    ]);
    expect(changed.messages).toEqual([user('q1, edited'), q2]);
  });

  it('treats a new system prompt or tool list as a checkpoint that strips every thinking block', async () => {
    const { session } = poolWith(NO_COMPRESSION);
    await session.compile(callWith(asked(1)));
    await session.compile(callWith(asked(2)));
    const system = await session.compile(callWith(asked(3), { sent: { system: 'other' } }));
    const tools = await session.compile(
      callWith(asked(4), { sent: { system: 'other', tools: [{ name: 'search' }] } }),
    );
    const same = await session.compile(
      callWith(asked(5), { sent: { system: 'other', tools: [{ name: 'search' }] } }),
    );

    expect(system.breaks).toEqual([
      { reason: 'system', at: 0, signed: false, strippedThinking: 2 },
    ]);
    expect(tools.breaks).toEqual([{ reason: 'tools', at: 0, signed: false, strippedThinking: 1 }]);
    expect(same.breaks).toEqual([]);
  });

  it('warns once when a fresh session meets a long history', async () => {
    const { pool, session, logger } = poolWith(NO_COMPRESSION);
    const first = await session.compile(callWith(asked(4)));
    await pool.get('s2').compile(callWith(asked(5)));
    await pool.get('s3').compile(callWith(asked(3)));

    expect(first.breaks).toEqual([{ reason: 'ledger', at: 0, signed: false, strippedThinking: 3 }]);
    const lost = logger.warn.mock.calls.filter(([m]) => String(m).includes('ledger is empty'));
    expect(lost).toHaveLength(1);
    expect(lost[0][0]).toContain('3 replies');
  });

  it('keeps nothing of a call that failed, so the next one meets the same checkpoint', async () => {
    let failing = true;
    const failOnce: OverflowStrategy = {
      name: 'failOnce',
      async apply(input) {
        if (failing) {
          failing = false;
          throw new Error('boom');
        }
        return unchanged(input, 'failOnce', 'nothing to do');
      },
    };
    const { session } = poolWith({}, () => failOnce);
    for (const n of [1, 2, 3]) await session.compile(callWith(asked(n)));
    const [q1, , q2, a2, q3, a3, q4] = asked(4);
    const edited = [q1, reply('a1, edited', 'SIG_1x'), q2, a2, q3, a3, q4];

    await expect(session.compile(callWith(edited))).rejects.toThrow('boom');
    const retried = await session.compile(callWith(edited));

    expect(retried.breaks).toEqual([
      { reason: 'history', at: 1, signed: false, strippedThinking: 3 },
    ]);
  });

  it('compiles a one-off request as a call would be, and keeps nothing of it', async () => {
    const { session, compressionModel } = poolWith();
    await session.compile(callWith(asked(1), { dynamicState: stateXml(1) }));
    await session.compile(callWith(asked(2), { dynamicState: stateXml(1) }));
    const [q1, a1, q2, a2, q3, a3, q4] = asked(4);
    // Sent without tools, the state changed, and 7 messages: over the trigger at a boundary.
    const oneOff = await session.compile(
      callWith(asked(4), {
        sent: { ...SENT, tools: [] },
        dynamicState: stateXml(2),
        oneOff: true,
      }),
    );
    const next = await session.compile(callWith(asked(3), { dynamicState: stateXml(2) }));

    expect(oneOff.breaks).toEqual([{ reason: 'tools', at: 0, signed: false, strippedThinking: 3 }]);
    expect(oneOff.messages).toEqual([
      q1,
      stateEvent(1, 1),
      stripIR(a1),
      q2,
      stripIR(a2),
      q3,
      stripIR(a3),
      q4,
      stateEvent(2, 2),
    ]);
    // A compression is the conversation's: a one-off lands none.
    expect(compressionModel).not.toHaveBeenCalled();
    // The conversation goes on from the last call, its thinking intact.
    expect(next.breaks).toEqual([]);
    expect(next.messages).toEqual([q1, stateEvent(1, 1), a1, q2, a2, q3, stateEvent(2, 2)]);
  });

  it('runs one call at a time, so a second call sees the head the first one landed', async () => {
    const { session, compressionModel } = poolWith();
    for (const n of [1, 2, 3]) await session.compile(callWith(asked(n)));
    const [first, second] = await Promise.all([
      session.compile(callWith(asked(4))),
      session.compile(callWith(asked(5))),
    ]);
    const summary: Message = { role: 'user', content: SUMMARY(1) };

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(first.messages).toEqual([summary, qa[6]]);
    expect(second.messages).toEqual([summary, ...qa.slice(6, 9)]);
  });
});

describe('PrefixSession: usage reports', () => {
  it('counts what the window gained since the reported request on top of the report', async () => {
    const { session, compressionModel } = poolWith();
    await session.compile(callWith(rounds(1)));
    session.reportTokenUsage(95);
    expect(session.ledger.reported).toBe(3);
    const next = await session.compile(callWith(rounds(2)));

    // 95 reported for the 3 messages sent, plus 20 for the 2 since: past the
    // raw window in a tool turn, so it collapses although 5 messages count 50.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(next.messages).toEqual([{ role: 'user', content: SUMMARY(1) }]);
  });
});

describe('createPrefixSessionPool', () => {
  it('keeps a session per key, with no Janitor when nothing compresses', () => {
    const { pool } = poolWith(NO_COMPRESSION);

    expect(pool.get('a')).toBe(pool.get('a'));
    expect(pool.get('a')).not.toBe(pool.get('b'));
    expect(pool.get('a').janitor).toBeNull();
  });

  it('never warns that the summary is not persisted: the session replays it', async () => {
    const { session, compressionModel, logger } = poolWith();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await session.compile(callWith(asked(n)));

    // At questions 4, 7 and 10: as often as the in-flight pool warns from.
    expect(compressionModel).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('server() with onDemandCompaction()', () => {
  const both = () =>
    server(undefined, {
      fallback: onDemandCompaction({
        compact: async () => ({ stop_reason: 'end_turn', content: [] }),
      }),
    });

  it('warns once per pool, whichever pool', () => {
    const janitorLogger = { warn: vi.fn() };
    const janitors = createJanitorPool<string[]>({
      contextWindow: 100,
      overflow: { strategy: both() },
      toHostMessages: (messages) => messages.map((m) => m.content),
      persistenceWarning: () => '',
      logger: janitorLogger,
    });
    janitors?.get('a');
    janitors?.get('b');
    const { pool, logger } = poolWith({}, both);
    pool.get('a');
    pool.get('b');

    for (const { warn } of [janitorLogger, logger]) {
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('onDemandCompaction()')),
      ).toHaveLength(1);
    }
  });
});
