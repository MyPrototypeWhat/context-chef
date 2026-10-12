/**
 * The window is rebuilt from (host history, ledger) on every compile:
 * `head.replacement`, then host messages from `head.cut` on, with each entry
 * rendered before the first assistant message at or after its anchor — the
 * reply to the request that carried it — or at the tail while unanswered.
 * Every expectation below is worked out by hand from those host indices.
 */

import { describe, expect, it } from 'vitest';
import { Assembler } from '../modules/assembler';
import type { Message } from '../types';
import { PrefixLedger } from './ledger';
import type { PrefixCandidate, PrefixLedgerSnapshot, PrefixSent } from './types';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

/** `role:content` per message — enough to read a window at a glance. */
const shape = (messages: Message[]) => messages.map((m) => `${m.role}:${m.content}`);

const state = (content: string): PrefixCandidate => ({
  channel: 'user',
  content,
  sources: ['dynamic-state'],
});

const guardrail: PrefixCandidate = {
  channel: 'user',
  content: '<guardrail/>',
  sources: ['guardrail'],
};

const announce: PrefixCandidate = {
  channel: 'system',
  content: '<announcement id="a"/>',
  sources: ['announcement:a'],
};

// q1 r1 q2 r2 q3 r3 q4 — user turns sit at even host indices.
const turns = [
  user('q1'),
  assistant('r1'),
  user('q2'),
  assistant('r2'),
  user('q3'),
  assistant('r3'),
  user('q4'),
];

/**
 * One compile as the pipeline runs it: reconcile, append at the tail, compare
 * what is sent ahead of the window once the payload exists, render, commit.
 */
function compile(
  ledger: PrefixLedger,
  history: Message[],
  events: PrefixCandidate[] = [],
  sent?: PrefixSent,
) {
  const { break: brk } = ledger.reconcile(history);
  if (events.length > 0) ledger.append(events);
  const sentBreak = sent && ledger.reconcileSent(sent);
  const window = ledger.window();
  const stable = ledger.stable();
  ledger.commit(history, sent);
  return { window, break: brk ?? sentBreak, stable };
}

/** A ledger that has followed the conversation from its first request to `history`. */
function following(history: Message[]): PrefixLedger {
  const ledger = new PrefixLedger();
  compile(ledger, history.slice(0, 1));
  compile(ledger, history);
  return ledger;
}

describe('PrefixLedger — events are appended once', () => {
  it('replays the same window on a recompile at the same history length', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    const first = compile(ledger, history, [state('<state>A</state>')]);
    const again = compile(ledger, history);

    expect(again.break).toBeUndefined();
    expect(shape(again.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
    ]);
    expect(again.window).toEqual(first.window);
    // Host messages are the host's own objects — the ledger never copies them.
    expect(again.window[0]).toBe(history[0]);
  });

  it('keeps an appended entry in place once the model answered it', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]);
    const next = compile(ledger, turns.slice(0, 5));

    expect(next.break).toBeUndefined();
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
      'assistant:r2',
      'user:q3',
    ]);
  });

  it('adds a state change at the same length to the unanswered tail', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [state('<state>A</state>')]);

    ledger.reconcile(history);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
    ledger.append([state('<state>B</state>')]);

    expect(shape(ledger.window())).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>\n\n<state>B</state>',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>B</state>');
  });

  it('renders user events, then system events, then turn-scoped ones, one message each', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile([user('q1')]);
    ledger.append([
      { channel: 'system', content: '<skill name="x"/>', sources: ['skill'] },
      state('<state>A</state>'),
      { ...announce, clearAt: true },
      guardrail,
    ]);

    expect(ledger.window()).toEqual([
      user('q1'),
      { role: 'user', content: '<state>A</state>\n\n<guardrail/>' },
      { role: 'system', content: '<skill name="x"/>', _positional: true },
      { role: 'system', content: '<announcement id="a"/>', _positional: true },
    ]);
    expect(ledger.lastAppended('guardrail')?.content).toBe('<guardrail/>');
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
  });

  it('puts a user event appended after a system one before it while the request is unanswered', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [announce]);

    ledger.reconcile(history);
    ledger.append([state('<state>A</state>')]);

    expect(shape(ledger.window()).slice(-2)).toEqual([
      'user:<state>A</state>',
      'system:<announcement id="a"/>',
    ]);
  });

  it('moves unanswered events past a user turn the host appended, with no break', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [announce]);
    const next = compile(ledger, [...history, user('q2 again')]);

    expect(next.break).toBeUndefined();
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:q2 again',
      'system:<announcement id="a"/>',
    ]);
  });

  it('freezes the tail the model answered, byte for byte', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [state('<state>A</state>')]); // @3
    const unanswered = [...history, user('q2 again')];
    const sent = compile(ledger, unanswered, [guardrail, announce]); // @4
    expect(shape(sent.window).slice(-2)).toEqual([
      'user:<state>A</state>\n\n<guardrail/>',
      'system:<announcement id="a"/>',
    ]);

    const answered = [...unanswered, assistant('r2'), user('q3')];
    const next = compile(ledger, answered, [state('<state>C</state>')]); // @6

    expect(next.break).toBeUndefined();
    expect(next.window.slice(0, sent.window.length)).toEqual(sent.window);
    expect(shape(next.window.slice(sent.window.length))).toEqual([
      'assistant:r2',
      'user:q3',
      'user:<state>C</state>',
    ]);
  });

  it('records a withdrawal as a tombstone entry, the source’s last word', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile([user('q1')]);
    ledger.append([announce]);
    ledger.append([
      {
        channel: 'system',
        content: '<announcement id="a" withdrawn="true"/>',
        sources: ['announcement:a'],
        withdrawn: true,
      },
    ]);

    expect(ledger.lastAppended('announcement:a')).toMatchObject({
      content: '<announcement id="a" withdrawn="true"/>',
      withdrawn: true,
    });
    expect(ledger.lastAppended('announcement:b')).toBeUndefined();
  });

  it('lists the sources the window still holds entries for, first appearance first', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [announce, state('<state>A</state>')]); // @1, answered by r1
    compile(ledger, turns.slice(0, 3), [guardrail, announce]); // @3

    expect(ledger.sources()).toEqual(['announcement:a', 'dynamic-state', 'guardrail']);

    // Editing q2 drops what renders after it: the guardrail is gone, the announcement stays.
    const edited = [...turns.slice(0, 2), user('q2, edited')];
    ledger.reconcile(edited);
    expect(ledger.sources()).toEqual(['announcement:a', 'dynamic-state']);
  });

  it('renders the group an entry anchored somewhere would join', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('<state>A</state>')]); // @1, answered by r1
    const history = [...turns.slice(0, 3), assistant('prefill')];
    ledger.reconcile(history);

    expect(ledger.renderedAt(1)).toEqual([user('<state>A</state>')]);
    expect(ledger.renderedAt(3)).toEqual([]);
    ledger.append([announce, state('<state>B</state>')], 3);
    // Before the prefill at host[3], user events first.
    expect(ledger.renderedAt(3)).toEqual([
      user('<state>B</state>'),
      { role: 'system', content: '<announcement id="a"/>', _positional: true },
    ]);
    expect(ledger.renderedAt(4)).toEqual([]);
  });

  it('says a system event with no user turn before it as a user message, keeping its channel', () => {
    const ledger = new PrefixLedger();
    const empty = compile(ledger, [], [announce]); // @0: nothing before it

    expect(empty.window).toEqual([user('<announcement id="a"/>')]);
    expect(ledger.lastAppended('announcement:a')?.channel).toBe('system');

    // Still unanswered, it moves past the first turn and follows a user turn now.
    const next = compile(ledger, [user('q1')]);
    expect(next.window).toEqual([
      user('q1'),
      { role: 'system', content: '<announcement id="a"/>', _positional: true },
    ]);
  });

  it('keeps a system event positional behind the user event of its own group', () => {
    const ledger = new PrefixLedger();
    const history = [assistant('Hi!')];
    ledger.reconcile(history);
    ledger.append([announce, state('<state>A</state>')]);

    expect(ledger.window()).toEqual([
      assistant('Hi!'),
      user('<state>A</state>'),
      { role: 'system', content: '<announcement id="a"/>', _positional: true },
    ]);
  });

  it('rebuilds a group said as a user message the same way from what it saw', () => {
    const ledger = new PrefixLedger();
    const history = [assistant('Hi!')];
    compile(ledger, history, [announce]); // after a reply: no user turn before it

    const restored = PrefixLedger.fromSnapshot(ledger.snapshot());
    const again = compile(restored, history);

    expect(again.window).toEqual([assistant('Hi!'), user('<announcement id="a"/>')]);
    expect(again.stable).toBe(2);
  });

  it('rejects an anchor outside the window', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile(turns.slice(0, 3));
    expect(() => ledger.append([state('A')], 4)).toThrow(RangeError);

    ledger.checkpoint('compaction', 2, {
      cut: 2,
      replacement: [user('<summary/>')],
      signed: false,
    });
    expect(() => ledger.append([state('A')], 1)).toThrow(RangeError);
  });
});

describe('PrefixLedger — reconcile reports a break and checkpoints it', () => {
  it('reports a `history` break where the host edited an earlier message', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // @3, answered by r2
    compile(ledger, turns.slice(0, 5), [state('<state>B</state>')]); // @5, unanswered

    const edited = turns.slice(0, 5);
    edited[4] = user('q3 (edited)');
    const next = compile(ledger, edited);

    // host[4] sits at window index 5, behind the surviving entry @3.
    expect(next.break).toEqual({ reason: 'history', at: 5, signed: false, stripped: [4, 5] });
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
      'assistant:r2',
      'user:q3 (edited)',
    ]);
    // Still visible, so still the source's last word.
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
  });

  it('reports a `history` break when the host history is shorter than what was seen', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // @3
    compile(ledger, turns.slice(0, 5), [state('<state>B</state>')]); // @5

    const next = compile(ledger, turns.slice(0, 3));

    // Back at length 3, the window is the one sent at length 3: A is unanswered again.
    expect(next.break).toEqual({ reason: 'history', at: 4, signed: false });
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
  });

  it('reports `system` and `tools` breaks that keep the entries, ignoring key order and cache_control', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    const sent: PrefixSent = {
      system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'search', input_schema: { type: 'object' } }],
    };
    compile(ledger, history, [state('<state>A</state>')], sent);

    const reordered: PrefixSent = {
      tools: [{ input_schema: { type: 'object' }, name: 'search' }],
      system: [{ text: 'S', type: 'text' }],
    };
    expect(compile(ledger, history, [], reordered).break).toBeUndefined();

    const newSystem: PrefixSent = { ...sent, system: [{ type: 'text', text: 'S2' }] };
    const changed = compile(ledger, history, [], newSystem);
    expect(changed.break).toEqual({ reason: 'system', at: 0, signed: false, stripped: [0, 3] });
    // Only the signatures died: the event is still valid content, so it stays and still counts.
    expect(shape(changed.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
    expect(compile(ledger, history, [], newSystem).break).toBeUndefined();

    const newTools: PrefixSent = { ...newSystem, tools: [] };
    expect(compile(ledger, history, [], newTools).break).toEqual({
      reason: 'tools',
      at: 0,
      signed: false,
      stripped: [0, 3],
    });
  });

  it('compares what was sent as the plain JSON it keeps', () => {
    class Schema {
      toJSON() {
        return { type: 'object' };
      }
    }
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    const sent: PrefixSent = {
      system: 'S',
      tools: [{ name: 'search', input_schema: new Schema() }],
    };
    compile(ledger, history, [], sent);

    expect(compile(ledger, history, [], sent).break).toBeUndefined();
  });

  it('has nothing to compare what is sent with before a compile committed one', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile(turns.slice(0, 1));

    expect(ledger.reconcileSent({ system: 'S', tools: [] })).toBeUndefined();
    expect(ledger.stripped).toEqual([]);
  });

  it.each([
    { signed: false, replacement: [user('<summary/>')] },
    {
      signed: true,
      replacement: [
        { role: 'assistant', content: '', _anthropic_compaction: 'summary' } as Message,
      ],
    },
  ])('strips everything after a head (signed: $signed) when the system changes', ({
    signed,
    replacement,
  }) => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 7);
    const sent: PrefixSent = { system: 'S', tools: [] };
    ledger.reconcile(history);
    ledger.checkpoint('compaction', 3, { cut: 3, replacement, signed });
    ledger.append([state('<state>A</state>')]); // @7
    ledger.commit(history, sent);

    const system = compile(ledger, history, [], { ...sent, system: 'S2' });
    expect(system.break).toEqual({ reason: 'system', at: 0, signed: false, stripped: [3, 7] });
    // The head and the entries stay; every signature after the head is gone.
    expect(ledger.head).toMatchObject({ cut: 3, signed });
    expect(shape(system.window)).toEqual([
      ...shape(replacement),
      'assistant:r2',
      'user:q3',
      'assistant:r3',
      'user:q4',
      'user:<state>A</state>',
    ]);

    const tools = compile(ledger, history, [], { system: 'S2', tools: [{ name: 'search' }] });
    expect(tools.break).toEqual({ reason: 'tools', at: 0, signed: false, stripped: [3, 7] });
  });

  it('reports a `ledger` break when the history is shorter than head.cut', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 6);
    ledger.reconcile(history);
    ledger.checkpoint('compaction', 4, {
      cut: 4,
      replacement: [user('<summary/>')],
      signed: false,
    });
    ledger.commit(history);

    const next = compile(ledger, [user('fresh')]);

    expect(next.break).toEqual({ reason: 'ledger', at: 0, signed: false, stripped: [0, 1] });
    expect(shape(next.window)).toEqual(['user:fresh']);
    expect(ledger.head).toBeUndefined();
  });

  it('reports a `ledger` break when a ledger that saw nothing meets a reply', () => {
    // r1 answered a request this ledger never saw: whatever it was sent with is unknown.
    expect(compile(new PrefixLedger(), turns.slice(0, 3)).break).toEqual({
      reason: 'ledger',
      at: 0,
      signed: false,
      stripped: [0, 3],
    });
    expect(compile(new PrefixLedger(), turns.slice(0, 1)).break).toBeUndefined();
  });

  it('reports a `ledger` break for an entry anchored past the end of the history', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile(turns.slice(0, 3));
    ledger.append([state('<state>A</state>')]); // @3, never committed

    const next = compile(ledger, turns.slice(0, 1));

    expect(next.break).toEqual({ reason: 'ledger', at: 1, signed: false });
    expect(shape(next.window)).toEqual(['user:q1']);
  });

  it('keeps a system event the model answered', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [announce]);
    const next = compile(ledger, turns.slice(0, 5));

    expect(next.break).toBeUndefined();
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'system:<announcement id="a"/>',
      'assistant:r2',
      'user:q3',
    ]);
  });
});

describe('PrefixLedger — what counts as an edit of a host message', () => {
  const origin = { blocks: [{ type: 'text', text: 'r1' }], part: 0, parts: 1, hash: 'h' };
  const answered = (r1: Message): Message[] => [user('q1'), r1, user('q2')];

  it('ignores key order, breakpoints, pinning and host metadata', () => {
    const ledger = new PrefixLedger();
    compile(ledger, [
      { role: 'user', content: 'q1', id: 'm1' },
      { role: 'assistant', content: 'r1', _cache_breakpoint: true },
      { role: 'user', content: 'q2', meta: { at: 1 } },
    ]);

    const replayed: Message[] = [
      { content: 'q1', role: 'user', id: 'm1-renamed', pinned: true },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2', meta: { at: 2 }, savedBy: 'host' },
    ];
    expect(ledger.reconcile(replayed).break).toBeUndefined();
  });

  it('counts a provider field, since it reaches its wire', () => {
    const ledger = new PrefixLedger();
    compile(ledger, answered(assistant('r1')));

    const resigned = answered({ ...assistant('r1'), _gemini_thought_signature: 'sig' });
    expect(ledger.reconcile(resigned).break).toMatchObject({ reason: 'history', at: 1 });
  });

  it('counts the Anthropic origin by identity, not by its stored blocks', () => {
    const withOrigin = { ...assistant('r1'), _anthropic_origin: origin };
    const ledger = () => {
      const fresh = new PrefixLedger();
      compile(fresh, answered(withOrigin));
      return fresh;
    };

    const breakpointInBlocks = {
      ...withOrigin,
      _anthropic_origin: {
        ...origin,
        blocks: [{ type: 'text', text: 'r1', cache_control: { type: 'ephemeral' } }],
      },
    };
    expect(ledger().reconcile(answered(breakpointInBlocks)).break).toBeUndefined();

    // Same IR fields, but the Anthropic target now rebuilds the message instead of replaying it.
    expect(ledger().reconcile(answered(assistant('r1'))).break).toMatchObject({
      reason: 'history',
      at: 1,
    });
    const reparsed = { ...withOrigin, _anthropic_origin: { ...origin, hash: 'h2' } };
    expect(ledger().reconcile(answered(reparsed)).break).toMatchObject({
      reason: 'history',
      at: 1,
    });
  });
});

describe('PrefixLedger — checkpoints', () => {
  it('drops entries after the break; the ones kept before it still count', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('<state>A</state>')]); // @1, answered by r1
    compile(ledger, turns.slice(0, 3), [
      state('<state>B</state>'),
      { ...announce, channel: 'user' },
    ]); // @3, answered by r2
    const history = turns.slice(0, 5);
    ledger.reconcile(history);

    // host[2] lands at window index 3, behind the surviving entry @1.
    expect(ledger.checkpoint('ledger', 2)).toEqual({
      reason: 'ledger',
      at: 3,
      signed: false,
      stripped: [2, 5],
    });
    expect(shape(ledger.window())).toEqual([
      'user:q1',
      'user:<state>A</state>',
      'assistant:r1',
      'user:q2',
      'assistant:r2',
      'user:q3',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
    expect(ledger.lastAppended('announcement:a')).toBeUndefined();
  });

  it('drops an entry that moved past the edited message to the reply after it', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [announce]); // @3
    // Two follow-ups before the reply: the event renders after both, right before r2.
    const followUps = [...history, user('q2 again'), user('q2 once more'), assistant('r2')];
    compile(ledger, followUps);

    const edited = [...followUps];
    edited[4] = user('q2 once more (edited)');
    const next = compile(ledger, edited);

    expect(next.break).toEqual({ reason: 'history', at: 4, signed: false, stripped: [4, 6] });
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:q2 again',
      'user:q2 once more (edited)',
      'assistant:r2',
    ]);
    expect(ledger.lastAppended('announcement:a')).toBeUndefined();
  });

  it('leaves a withdrawn source’s statement as its last word when the tombstone is dropped', () => {
    const skill: PrefixCandidate = {
      channel: 'system',
      content: '<skill name="x"/>',
      sources: ['skill'],
    };
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [skill]); // @1
    compile(ledger, turns.slice(0, 3), [
      { ...skill, content: '<skill name="x" withdrawn="true"/>', withdrawn: true },
    ]); // @3
    compile(ledger, turns.slice(0, 5));

    const edited = turns.slice(0, 5);
    edited[2] = user('q2 (edited)');
    const next = compile(ledger, edited);

    expect(next.break).toMatchObject({ reason: 'history', at: 3 });
    expect(shape(next.window)).toEqual([
      'user:q1',
      'system:<skill name="x"/>',
      'assistant:r1',
      'user:q2 (edited)',
      'assistant:r2',
      'user:q3',
    ]);
    // The caller sees the skill still stated, and appends a fresh tombstone.
    expect(ledger.lastAppended('skill')).toMatchObject({ content: '<skill name="x"/>' });
    expect(ledger.lastAppended('skill')?.withdrawn).toBeUndefined();
  });

  it('reports the break index in rendered messages, two events in one message counting once', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('<state>A</state>'), guardrail]); // @1, one message
    compile(ledger, turns.slice(0, 5));

    const edited = turns.slice(0, 5);
    edited[2] = user('q2 (edited)');
    const next = compile(ledger, edited);

    expect(next.break).toEqual({ reason: 'history', at: 3, signed: false, stripped: [2, 5] });
    expect(next.window[3]).toBe(edited[2]);
  });

  it('replaces host [0, cut) with a compaction head and re-bases the entries after the cut', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('E1')]); // @1
    compile(ledger, turns.slice(0, 3), [state('E2')]); // @3
    compile(ledger, turns.slice(0, 5), [state('E3')]); // @5
    const history = turns.slice(0, 7);
    compile(ledger, history, [state('E4')]); // @7
    ledger.reconcile(history);

    const brk = ledger.checkpoint('compaction', 3, {
      cut: 3,
      replacement: [user('<summary/>')],
      signed: false,
    });

    expect(brk).toEqual({ reason: 'compaction', at: 0, signed: false, stripped: [3, 7] });
    // E1 and E2 sat inside the summarized span (E2 right before host[3]).
    expect(shape(ledger.window())).toEqual([
      'user:<summary/>',
      'assistant:r2',
      'user:q3',
      'user:E3',
      'assistant:r3',
      'user:q4',
      'user:E4',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('E4');
    ledger.commit(history);

    // A summarized message is no longer in the window: editing it is no break.
    const summarizedEdit = [...history];
    summarizedEdit[2] = user('q2 (edited)');
    expect(ledger.reconcile(summarizedEdit).break).toBeUndefined();

    // A kept one still is: host[4] now sits at window index 2.
    const keptEdit = [...history];
    keptEdit[4] = user('q3 (edited)');
    expect(ledger.reconcile(keptEdit).break).toEqual({
      reason: 'history',
      at: 2,
      signed: false,
      stripped: [4, 7],
    });
  });

  it('keeps an entry that renders after the cut, wherever it was anchored', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // @3
    const history = [...turns.slice(0, 3), user('q2 again'), assistant('r2')];
    compile(ledger, history); // A renders after "q2 again", before r2
    ledger.reconcile(history);

    ledger.checkpoint('compaction', 3, {
      cut: 3,
      replacement: [user('<summary/>')],
      signed: false,
    });

    expect(shape(ledger.window())).toEqual([
      'user:<summary/>',
      'user:q2 again',
      'user:<state>A</state>',
      'assistant:r2',
    ]);
  });

  it('records no stripped range for a signed compaction', () => {
    const history = turns.slice(0, 5);
    const ledger = following(history);
    ledger.reconcile(history);

    const brk = ledger.checkpoint('compaction', 3, {
      cut: 3,
      replacement: [{ role: 'assistant', content: '', _anthropic_compaction: 'summary' }],
      signed: true,
    });

    expect(brk).toEqual({ reason: 'compaction', at: 0, signed: true });
    expect(ledger.stripped).toEqual([]);
    expect(ledger.head?.signed).toBe(true);
  });

  it('refuses a checkpoint it cannot apply', () => {
    const ledger = new PrefixLedger();
    ledger.reconcile(turns.slice(0, 3));
    const head = { cut: 2, replacement: [user('<summary/>')], signed: false };

    expect(() => ledger.checkpoint('compaction', 2)).toThrow(/head/);
    expect(() => ledger.checkpoint('history', 2, head)).toThrow(/head/);
    expect(() => ledger.checkpoint('history', 4)).toThrow(RangeError);
    expect(() => ledger.checkpoint('compaction', 2, { ...head, cut: 4 })).toThrow(RangeError);
    expect(ledger.head).toBeUndefined();
  });

  it('accumulates stripped ranges and never uncovers a message that is still there', () => {
    const six = [...turns.slice(0, 6)];
    const ledger = following(six);
    six[2] = user('q2 (edited)');
    compile(ledger, six);
    expect(ledger.stripped).toEqual([[2, 6]]);

    const nine = [...six, user('q4'), assistant('r4'), user('q5')];
    compile(ledger, nine);
    nine[7] = assistant('r4 (edited)');
    compile(ledger, nine);
    expect(ledger.stripped).toEqual([
      [2, 6],
      [7, 9],
    ]);

    nine[4] = user('q3 (edited)');
    compile(ledger, nine);
    expect(ledger.stripped).toEqual([[2, 9]]);
  });

  it('forgets stripped indices past the host history, so later messages keep their thinking', () => {
    const six = [...turns.slice(0, 6)];
    const ledger = following(six);
    six[2] = user('q2 (edited)');
    compile(ledger, six);
    expect(ledger.stripped).toEqual([[2, 6]]);

    // The host rolls back to four messages, then the conversation continues.
    const rolledBack = six.slice(0, 4);
    compile(ledger, rolledBack);
    expect(ledger.stripped).toEqual([[2, 4]]);
    compile(ledger, [...rolledBack, user('q3 (new)'), assistant('r3 (new)')]);
    expect(ledger.stripped).toEqual([[2, 4]]);
  });
});

describe('PrefixLedger — stable', () => {
  it('counts the leading messages the window last committed also had', () => {
    const ledger = new PrefixLedger();
    expect(compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]).stable).toBe(0);
    // [q1 r1 q2 A] → [q1 r1 q2 A r2 q3]
    expect(compile(ledger, turns.slice(0, 5)).stable).toBe(4);
    expect(compile(ledger, turns.slice(0, 5)).stable).toBe(6);
  });

  it('stops where the unanswered tail was rendered again', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [announce]); // [q1 r1 q2 S]

    // A user event renders before the system one: [q1 r1 q2 A S].
    const next = compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]);
    expect(next.break).toBeUndefined();
    expect(next.stable).toBe(3);
  });

  it('stops at a kept event that moved in front of the changed message, before `at`', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // @3
    compile(ledger, [...turns.slice(0, 3), user('q2 again'), assistant('r2')]);

    // Rolled back to three messages, A is unanswered again and renders at the tail, where
    // "q2 again" was. `at` is where host[3] would be; A already differs.
    const next = compile(ledger, turns.slice(0, 3));
    expect(next.break).toEqual({ reason: 'history', at: 4, signed: false });
    expect(shape(next.window)).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
    ]);
    expect(next.stable).toBe(3);
  });

  it('is 0 once what is sent ahead of the window changed', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [], { system: 'S' });

    expect(compile(ledger, history, [], { system: 'S2' }).stable).toBe(0);
    expect(compile(ledger, history, [], { system: 'S2' }).stable).toBe(3);
  });

  it('rebuilds the committed window from a snapshot, which holds no messages', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]);
    const answered = [...turns.slice(0, 3), user('q2 again'), assistant('r2')];
    compile(ledger, answered); // [q1 r1 q2 "q2 again" A r2]
    const restored = () => PrefixLedger.fromSnapshot(JSON.parse(JSON.stringify(ledger.snapshot())));

    // Where A rendered depends on which host message was the reply.
    expect(compile(restored(), answered).stable).toBe(6);
    expect(compile(restored(), turns.slice(0, 3)).stable).toBe(3);
  });
});

describe('PrefixLedger — a compile that failed', () => {
  it('rolls back to what was last committed', () => {
    const ledger = new PrefixLedger();
    const sent: PrefixSent = { system: 'S' };
    compile(ledger, turns.slice(0, 1), [], sent);
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')], sent);
    const edited = turns.slice(0, 3);
    edited[2] = user('q2 (edited)');

    const failed = ledger.reconcile(edited);
    ledger.append([state('<state>B</state>')]);
    ledger.reconcileSent({ system: 'S2' });
    ledger.rollback();

    expect(ledger.stripped).toEqual([]);
    expect(ledger.lastSent).toEqual(sent);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
    // None of it was sent, so the next compile meets the same checkpoint.
    const retried = compile(ledger, edited, [], { system: 'S2' });
    expect(retried.break).toEqual(failed.break);
    expect(retried.window).toEqual(failed.window);
  });

  it('keeps a committed compile, with nothing to roll back', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]);
    ledger.rollback();

    expect(compile(ledger, turns.slice(0, 5)).break).toBeUndefined();
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
  });
});

describe('PrefixLedger — reset', () => {
  it('starts over, and the next compile reports a `ledger` checkpoint at 0', () => {
    const ledger = new PrefixLedger();
    const sent: PrefixSent = { system: 'S' };
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')], sent);

    ledger.reset();
    const fresh = [user('new topic')];
    // A compile that fails right after does not use the reset up.
    ledger.reconcile(fresh);
    ledger.rollback();
    const next = compile(ledger, fresh, [], sent);

    // What was sent ahead of the window is not part of the conversation: no `system` break.
    expect(next.break).toEqual({ reason: 'ledger', at: 0, signed: false, stripped: [0, 1] });
    expect(shape(next.window)).toEqual(['user:new topic']);
    expect(next.stable).toBe(0);
    expect(ledger.lastAppended('dynamic-state')).toBeUndefined();
    expect(
      compile(ledger, [...fresh, assistant('ok'), user('more')], [], sent).break,
    ).toBeUndefined();
  });

  it('carries a reset the next compile has not met through a snapshot', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('<state>A</state>')]);
    ledger.reset();

    const restored = PrefixLedger.fromSnapshot(JSON.parse(JSON.stringify(ledger.snapshot())));
    expect(compile(restored, [user('new topic')]).break).toMatchObject({ reason: 'ledger', at: 0 });
  });
});

describe('PrefixLedger — snapshot', () => {
  it('round-trips through JSON to the same window and the same validation', () => {
    const sent: PrefixSent = { system: [{ type: 'text', text: 'S' }], tools: [] };
    const ledger = new PrefixLedger();
    compile(
      ledger,
      turns.slice(0, 3),
      [state('<state>A</state>'), guardrail, { ...announce, clearAt: true }],
      sent,
    );
    compile(
      ledger,
      turns.slice(0, 5),
      [{ ...announce, content: '<announcement id="a" withdrawn="true"/>', withdrawn: true }],
      sent,
    );
    const history = turns.slice(0, 7);
    ledger.reconcile(history);
    ledger.checkpoint('history', 6);
    // Cut before both events, so the grouped, turn-scoped and tombstone entries all survive.
    ledger.checkpoint('compaction', 1, {
      cut: 1,
      replacement: [{ role: 'assistant', content: '', _anthropic_compaction: 'summary' }],
      signed: true,
    });
    ledger.append([state('<state>C</state>')]);
    ledger.commit(history, sent);

    const snapshot = ledger.snapshot();
    const restored = PrefixLedger.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(restored.snapshot()).toEqual(snapshot);
    const original = ledger.reconcile(history);
    const replayed = restored.reconcile(history);
    expect(replayed.break).toBeUndefined();
    expect(Assembler.stringifyPayload(replayed.window)).toBe(
      Assembler.stringifyPayload(original.window),
    );
    expect(restored.lastAppended('dynamic-state')?.content).toBe('<state>C</state>');

    const edited = [...history];
    edited[5] = assistant('r3 (edited)');
    expect(restored.reconcile(edited).break).toMatchObject({ reason: 'history' });
  });

  it('keeps what was sent as plain JSON', () => {
    const ledger = new PrefixLedger();
    const history = [user('q1')];
    ledger.reconcile(history);
    const tools = [{ name: 'search', execute: () => 'result' }];

    expect(() => ledger.commit(history, { system: 'S', tools })).not.toThrow();
    expect(ledger.lastSent).toEqual({ system: 'S', tools: [{ name: 'search' }] });
    expect(JSON.parse(JSON.stringify(ledger.snapshot())).lastSent).toEqual(ledger.lastSent);
  });

  it('refuses a snapshot version it does not know', () => {
    const future = { version: 2, entries: [], stripped: [], seen: [] } as unknown;
    expect(() => PrefixLedger.fromSnapshot(future as PrefixLedgerSnapshot)).toThrow(/version/);
  });
});
