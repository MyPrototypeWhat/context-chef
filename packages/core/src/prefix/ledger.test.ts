/**
 * The window is rebuilt from (host history, ledger) on every compile:
 * `head.replacement`, then host messages from `head.cut` on, with each entry
 * placed immediately before `host[anchor]`. Every expectation below is
 * worked out by hand from those host indices.
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

/** One compile as the pipeline runs it: reconcile, append at the tail, render, commit. */
function compile(
  ledger: PrefixLedger,
  history: Message[],
  events: PrefixCandidate[] = [],
  sent?: PrefixSent,
) {
  const { break: brk } = ledger.reconcile(history, sent);
  if (events.length > 0) ledger.append(events);
  const window = ledger.window(history);
  ledger.commit(history, sent);
  return { window, break: brk };
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

  it('keeps an appended entry at its anchor while the host history grows', () => {
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

  it('appends a second entry at the same anchor when state changed between two compiles', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [state('<state>A</state>')]);

    ledger.reconcile(history);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
    ledger.append([state('<state>B</state>')]);

    expect(shape(ledger.window(history))).toEqual([
      'user:q1',
      'assistant:r1',
      'user:q2',
      'user:<state>A</state>',
      'user:<state>B</state>',
    ]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>B</state>');
  });

  it('renders one append as at most one message per channel, keeping each source’s text', () => {
    const ledger = new PrefixLedger();
    const history = [user('q1')];
    ledger.reconcile(history);
    ledger.append([
      state('<state>A</state>'),
      { channel: 'user', content: '<guardrail/>', sources: ['guardrail'] },
      { channel: 'system', content: '<skill name="x"/>', sources: ['skill'] },
    ]);

    expect(ledger.window(history)).toEqual([
      user('q1'),
      { role: 'user', content: '<state>A</state>\n\n<guardrail/>' },
      { role: 'system', content: '<skill name="x"/>', _positional: true },
    ]);
    expect(ledger.lastAppended('guardrail')?.content).toBe('<guardrail/>');
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>A</state>');
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
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // entry @3
    compile(ledger, turns.slice(0, 5), [state('<state>B</state>')]); // entry @5

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
    // The entry before the break stays in the window but no longer speaks for
    // its source: the caller re-states current state at the tail.
    expect(ledger.lastAppended('dynamic-state')).toBeUndefined();
  });

  it('reports a `history` break when the host history is shorter than what was seen', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 3), [state('<state>A</state>')]); // entry @3
    compile(ledger, turns.slice(0, 5), [state('<state>B</state>')]); // entry @5

    const next = compile(ledger, turns.slice(0, 3));

    expect(next.break).toEqual({ reason: 'history', at: 3, signed: false });
    expect(shape(next.window)).toEqual(['user:q1', 'assistant:r1', 'user:q2']);
  });

  it('reports `system` and `tools` breaks, ignoring key order and cache_control', () => {
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
    expect(shape(changed.window)).toEqual(['user:q1', 'assistant:r1', 'user:q2']);
    expect(compile(ledger, history, [], newSystem).break).toBeUndefined();

    const newTools: PrefixSent = { ...newSystem, tools: [] };
    expect(compile(ledger, history, [], newTools).break).toEqual({
      reason: 'tools',
      at: 0,
      signed: false,
      stripped: [0, 3],
    });
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

  it('reports a `ledger` break when a system event is followed by a user message', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [announce]);
    const next = compile(ledger, [...history, user('q2 again')]);

    expect(next.break).toEqual({ reason: 'ledger', at: 3, signed: false, stripped: [3, 4] });
    expect(shape(next.window)).toEqual(['user:q1', 'assistant:r1', 'user:q2', 'user:q2 again']);
  });

  it('lets a turn-scoped (clearAt) system event be followed by a user message', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 3);
    compile(ledger, history, [{ ...announce, clearAt: true }]);
    const next = compile(ledger, [...history, user('q2 again')]);

    expect(next.break).toBeUndefined();
    expect(shape(next.window).slice(-2)).toEqual([
      'system:<announcement id="a"/>',
      'user:q2 again',
    ]);
  });

  it('ignores key order and chef bookkeeping fields when comparing host messages', () => {
    const ledger = new PrefixLedger();
    compile(ledger, [
      user('q1'),
      { role: 'assistant', content: 'r1', _cache_breakpoint: true },
      { role: 'user', content: 'q2', extra: { v: 1, cache_control: { type: 'ephemeral' } } },
    ]);

    const replayed: Message[] = [
      { content: 'q1', role: 'user', pinned: true },
      { role: 'assistant', content: 'r1', _anthropic_origin: { part: 0, parts: 1, hash: 'h' } },
      { role: 'user', content: 'q2', extra: { v: 1 } },
    ];
    expect(ledger.reconcile(replayed).break).toBeUndefined();

    // A provider field reaches its wire, so it counts.
    const resigned = [...replayed];
    resigned[1] = { ...replayed[1], _gemini_thought_signature: 'sig' };
    expect(ledger.reconcile(resigned).break).toMatchObject({ reason: 'history', at: 1 });
  });
});

describe('PrefixLedger — checkpoints', () => {
  it('drops entries at or after the break and resets every source’s last content', () => {
    const ledger = new PrefixLedger();
    compile(ledger, turns.slice(0, 1), [state('<state>A</state>')]); // @1
    compile(ledger, turns.slice(0, 3), [
      state('<state>B</state>'),
      { ...announce, channel: 'user' },
    ]); // @3
    const history = turns.slice(0, 5);
    ledger.reconcile(history);

    // host[2] lands at window index 3, behind the surviving entry @1.
    expect(ledger.checkpoint('ledger', 2)).toEqual({
      reason: 'ledger',
      at: 3,
      signed: false,
      stripped: [2, 5],
    });
    expect(shape(ledger.window(history))).toEqual([
      'user:q1',
      'user:<state>A</state>',
      'assistant:r1',
      'user:q2',
      'assistant:r2',
      'user:q3',
    ]);
    expect(ledger.lastAppended('dynamic-state')).toBeUndefined();
    expect(ledger.lastAppended('announcement:a')).toBeUndefined();

    ledger.append([state('<state>C</state>')]);
    expect(ledger.lastAppended('dynamic-state')?.content).toBe('<state>C</state>');
    expect(shape(ledger.window(history)).at(-1)).toBe('user:<state>C</state>');
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
    expect(shape(ledger.window(history))).toEqual([
      'user:<summary/>',
      'assistant:r2',
      'user:q3',
      'user:E3',
      'assistant:r3',
      'user:q4',
      'user:E4',
    ]);
    expect(ledger.lastAppended('dynamic-state')).toBeUndefined();
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

  it('records no stripped range for a signed compaction', () => {
    const ledger = new PrefixLedger();
    const history = turns.slice(0, 5);
    compile(ledger, history);
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

  it('accumulates stripped ranges and never uncovers a message that is still there', () => {
    const ledger = new PrefixLedger();
    const six = [...turns.slice(0, 6)];
    compile(ledger, six);
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
    const ledger = new PrefixLedger();
    const six = [...turns.slice(0, 6)];
    compile(ledger, six);
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

describe('PrefixLedger — snapshot', () => {
  it('round-trips through JSON to the same window and the same validation', () => {
    const sent: PrefixSent = { system: [{ type: 'text', text: 'S' }], tools: [] };
    const ledger = new PrefixLedger();
    compile(
      ledger,
      turns.slice(0, 3),
      [
        state('<state>A</state>'),
        { channel: 'user', content: '<guardrail/>', sources: ['guardrail'] },
        { ...announce, clearAt: true },
      ],
      sent,
    );
    compile(
      ledger,
      turns.slice(0, 5),
      [{ ...announce, content: '<announcement id="a" withdrawn="true"/>', withdrawn: true }],
      sent,
    );
    const history = turns.slice(0, 7);
    ledger.reconcile(history, sent);
    ledger.checkpoint('history', 6);
    // Cut before both events, so the joined, turn-scoped and tombstone entries all survive.
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
    const original = ledger.reconcile(history, sent);
    const replayed = restored.reconcile(history, sent);
    expect(replayed.break).toBeUndefined();
    expect(Assembler.stringifyPayload(replayed.window)).toBe(
      Assembler.stringifyPayload(original.window),
    );
    expect(restored.lastAppended('dynamic-state')?.content).toBe('<state>C</state>');

    const edited = [...history];
    edited[5] = assistant('r3 (edited)');
    expect(restored.reconcile(edited, sent).break).toMatchObject({ reason: 'history' });
  });

  it('refuses a snapshot version it does not know', () => {
    const future = { version: 2, entries: [], stripped: [], seen: [] } as unknown;
    expect(() => PrefixLedger.fromSnapshot(future as PrefixLedgerSnapshot)).toThrow(/version/);
  });
});
