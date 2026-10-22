/**
 * `ChefConfig.appendOnly` on the Anthropic target, where every thinking block
 * is signed over everything before it.
 *
 * An unsigned checkpoint strips the thinking it invalidated, as one
 * contiguous run, and never puts it back; a signed compaction head keeps it.
 * With `clearAt`, the system-channel sources say their state again in every
 * request as a turn-scoped reminder (`clear_at: 'next_user_message'`), which
 * stays where it was sent once the next user message clears it.
 *
 * Conversations are compiled turn by turn from the first request, as an agent
 * loop does; every expected message is worked out by hand.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditAnthropicCachePlacement } from '../src/adapters/anthropicCacheAudit';
import {
  AnthropicAdapter,
  anthropicCompactionMessage,
  type ChefConfig,
  type ChefEvents,
  type ChefSnapshot,
  ContextChef,
  checkPrefixContinuity,
  compactMessages,
  fromAnthropic,
  InMemoryBackend,
  type ITargetAdapter,
  OpenAIAdapter,
  Prompts,
} from '../src/index';
import { PrefixLedger } from '../src/prefix';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  TargetPayload,
  ToolDefinition,
} from '../src/types';

const silent: ChefLogger = { warn: () => {} };

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

// An agent loop as the host records it, one history per compile.
const turn1: Message[] = [user('Find the release date.')];
const turn2: Message[] = [...turn1, call('t1', 'SIG_1'), result('t1', '2026-09-28')];
const turn3: Message[] = [...turn2, reply('It is 2026-09-28.', 'SIG_2'), user('And the price?')];
const turn4: Message[] = [...turn3, reply('About $40.', 'SIG_3'), user('Thanks.')];

// The same turns as the Anthropic target sends them.
const text = (role: 'user' | 'assistant', content: string) => ({
  role,
  content: [{ type: 'text', text: content }],
});
const Q1 = text('user', 'Find the release date.');
const CALL_1 = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Search first.', signature: 'SIG_1' },
    { type: 'text', text: '' },
    { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
  ],
};
const RESULT_1 = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 't1', content: '2026-09-28' }],
};
const REPLY_2 = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'Reasoning signed SIG_2.', signature: 'SIG_2' },
    { type: 'text', text: 'It is 2026-09-28.' },
  ],
};
const Q2 = text('user', 'And the price?');

const State = z.object({ step: z.number() });
const ANCHOR = Prompts.EVENT_STATE_ANCHOR;
const state = (step: number, rev: number) =>
  `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>`;
const SEARCH_V2 = 'Tool search_v2 is available.';
const announcement = (id: string, content: string, rev: number) =>
  `<announcement rev="${rev}" id="${id}">\n${content}\n</announcement>`;
const withdrawnAnnouncement = (id: string, rev: number) =>
  `<announcement rev="${rev}" id="${id}" withdrawn="true">${Prompts.ANNOUNCEMENT_WITHDRAWN}</announcement>`;
const RESEARCHER = { name: 'researcher', description: 'Research', instructions: 'Cite sources.' };
const skillEvent = (rev: number) =>
  `<skill_instructions rev="${rev}" skill="researcher">\nCite sources.\n</skill_instructions>`;

const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21';
/** A turn-scoped system message as the Anthropic target sends it. */
const reminder = (...blocks: string[]) => ({
  role: 'system',
  clear_at: 'next_user_message',
  content: [{ type: 'text', text: blocks.join('\n\n') }],
});

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

/** Every chef here checks the pipeline invariants and records what it reports. */
function chefWith(config: ChefConfig = {}) {
  const chef = new ContextChef({
    logger: silent,
    appendOnly: true,
    pipelineChecks: true,
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

const clearAt = (config: ChefConfig = {}) => chefWith({ appendOnly: { clearAt: true }, ...config });

/** Compiles each turn in order, `setup` first, as the agent loop does. */
async function converse(
  chef: ContextChef,
  turns: Message[][],
  target: string | ITargetAdapter = 'anthropic',
  setup: (chef: ContextChef, turn: number) => void = () => {},
): Promise<AnthropicPayload[]> {
  const payloads: AnthropicPayload[] = [];
  for (const [i, history] of turns.entries()) {
    setup(chef, i + 1);
    payloads.push((await chef.setHistory(history).compile({ target })) as AnthropicPayload);
  }
  return payloads;
}

function expectAppendOnly(payloads: TargetPayload[]) {
  for (let i = 1; i < payloads.length; i++) {
    expect(checkPrefixContinuity(payloads[i - 1], payloads[i])).toEqual({ ok: true });
  }
}

/** The signatures of the thinking blocks sent, in order. */
const signatures = (payload: AnthropicPayload): string[] =>
  payload.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .flatMap((b) => (b.type === 'thinking' ? [b.signature] : []));

/** What reaches the provider: the payload without `meta`. */
const wire = (payload: TargetPayload): Omit<TargetPayload, 'meta'> => {
  const { meta: _meta, ...rest } = payload;
  return rest;
};

/** How often `text` occurs anywhere in what is sent. */
const occurrences = (payload: TargetPayload, text: string): number =>
  JSON.stringify(wire(payload)).split(JSON.stringify(text).slice(1, -1)).length - 1;

describe('appendOnly on Anthropic: an unsigned checkpoint strips the thinking it invalidated', () => {
  it('strips the thinking in the range the checkpoint stripped, only there, and never puts it back', async () => {
    const { chef, breaks, invariants } = chefWith();
    await converse(chef, [turn1, turn2, turn3]);

    // The host rewrote the tool result: the reply after it was signed over the old one.
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const later = [...edited, reply('About $40.', 'SIG_3'), user('Thanks.')];
    const [atBreak, next, retried] = await converse(chef, [edited, later, later]);

    expect(atBreak.meta?.prefix?.break).toEqual({
      reason: 'history',
      at: 2,
      signed: false,
      strippedThinking: 1,
    });
    expect(signatures(atBreak)).toEqual(['SIG_1']);
    expect(atBreak.messages[3]).toEqual(text('assistant', 'It is 2026-09-28.'));
    expect(signatures(next)).toEqual(['SIG_1', 'SIG_3']);
    expect(signatures(retried)).toEqual(['SIG_1', 'SIG_3']);
    expectAppendOnly([atBreak, next, retried]);
    expect(breaks.map((b) => b.reason)).toEqual(['history']);
    expect(invariants).toEqual([]);
  });

  it('strips through an adapter that wraps the Anthropic one and passes on what it is', async () => {
    const inner = new AnthropicAdapter();
    const wrapper: ITargetAdapter = {
      anthropicWire: inner.anthropicWire,
      compile: (messages) => inner.compile(messages),
    };
    const { chef, breaks } = chefWith();
    await converse(chef, [turn1, turn2, turn3], wrapper);

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited], wrapper);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([['history', 2, 1]]);
    expect(signatures(payload)).toEqual(['SIG_1']);
  });

  it('strips every block of a turn fromAnthropic parsed, and leaves the host history alone', async () => {
    const { history } = fromAnthropic([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_A' },
          { type: 'thinking', thinking: '', signature: 'SIG_B' },
          { type: 'text', text: 'Answer.' },
        ],
      },
      { role: 'user', content: 'next' },
    ]);
    const { chef, breaks } = chefWith();

    // A chef that never saw this conversation cannot vouch for what the replies were signed over.
    const [payload] = await converse(chef, [history]);

    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([['ledger', 2]]);
    expect(payload.messages[1]).toEqual(text('assistant', 'Answer.'));
    expect(JSON.stringify(payload)).not.toContain('SIG_');
    expect(history[1].thinking).toEqual({ thinking: '', signature: 'SIG_B' });
  });

  describe('a stripped turn fromAnthropic parsed', () => {
    const toolUse = { type: 'tool_use', id: 't1', name: 'search', input: { q: 'release' } };
    const toolResult = { type: 'tool_result', tool_use_id: 't1', content: '2026-09-28' };
    const searched = [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'price' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Price' }],
      },
      { type: 'text', text: 'Found ' },
      {
        type: 'text',
        text: 'it.',
        citations: [
          { type: 'web_search_result_location', url: 'https://example.com', cited_text: '$40' },
        ],
      },
    ];
    const sent = [
      { role: 'user', content: 'Find the release date.' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIG_A' }, toolUse],
      },
      { role: 'user', content: [toolResult] },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIG_B' }, ...searched],
      },
      { role: 'user', content: 'And the price?' },
    ] as unknown as MessageParam[];
    const later = [
      ...sent,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_C' },
          { type: 'text', text: 'About $40.' },
        ],
      },
      { role: 'user', content: 'Thanks.' },
    ] as unknown as MessageParam[];

    it('sends every block but the thinking as it was sent, from then on', async () => {
      const { chef, breaks } = chefWith();

      // A chef that never saw the conversation: the replies' thinking is stripped.
      const payloads = await converse(chef, [
        fromAnthropic(sent).history,
        fromAnthropic(later).history,
      ]);

      expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([['ledger', 2]]);
      for (const payload of payloads) {
        expect(payload.messages.slice(1, 4)).toEqual([
          { role: 'assistant', content: [toolUse] },
          { role: 'user', content: [toolResult] },
          { role: 'assistant', content: searched },
        ]);
      }
      expect(signatures(payloads[1])).toEqual(['SIG_C']);
      expectAppendOnly(payloads);
    });

    it('rebuilds one whose IR the host changed since from IR, as before', async () => {
      const { chef } = chefWith();
      const { history } = fromAnthropic(later);
      await converse(chef, [history.slice(0, 1), history]);

      // The edit is a checkpoint at the reply; its original blocks no longer say what it says.
      const edited = [...history];
      edited[5] = { ...history[5], content: 'About $45.' };
      const [payload] = await converse(chef, [edited]);

      expect(payload.messages[5]).toEqual(text('assistant', 'About $45.'));
    });
  });

  describe('a reply that held only thinking', () => {
    const conversation = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'SIG_A' }] },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_B' },
          { type: 'text', text: 'a2' },
        ],
      },
      { role: 'user', content: 'q3' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_C' },
          { type: 'text', text: 'a3' },
        ],
      },
      { role: 'user', content: 'q4' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_D' },
          { type: 'text', text: 'a4' },
        ],
      },
      { role: 'user', content: 'q5' },
    ] as MessageParam[];
    const { history } = fromAnthropic(conversation);
    const asked = (n: number) => history.slice(0, 2 * n - 1);

    it('is left out once a checkpoint stripped it, on every compile since, unflagged', async () => {
      const { chef, breaks, invariants } = chefWith();
      const [, sent, atBreak, next, last] = await converse(
        chef,
        [1, 2, 3, 4, 5].map(asked),
        'anthropic',
        (chef, turn) => {
          if (turn === 3) chef.setSystemPrompt([{ role: 'system', content: 'You are brief.' }]);
        },
      );

      expect(sent.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIG_A' }],
      });
      expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([['system', 2]]);
      // q1 and q2 are now adjacent user turns; a2 goes without its thinking.
      expect(atBreak.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
      expect(atBreak.messages[2]).toEqual(text('assistant', 'a2'));
      for (const payload of [atBreak, next, last]) {
        expect(payload.messages.filter((m) => m.role === 'assistant')).not.toContainEqual(
          text('assistant', ''),
        );
        expect(occurrences(payload, 'SIG_A')).toBe(0);
      }
      expect(signatures(last)).toEqual(['SIG_C', 'SIG_D']);
      expectAppendOnly([atBreak, next, last]);
      expect(invariants).toEqual([]);
    });

    it('is sent as 4.x sent it with appendOnly off', async () => {
      // A host that cleared the thinking itself: the reply is left with nothing.
      const cleared = compactMessages(asked(2), { clear: ['thinking'] });
      const payload = (await new ContextChef({ logger: silent }).setHistory(cleared).compile({
        target: 'anthropic',
      })) as AnthropicPayload;

      expect(payload.messages[1]).toEqual(text('assistant', ''));
    });
  });

  it('counts only what a checkpoint newly strips when the host dropped a message ahead of an older one', async () => {
    const { chef, breaks } = chefWith();
    const history = [
      user('q1'),
      reply('a1', 'SIG_1'),
      user('q2'),
      reply('a2', 'SIG_2'),
      user('q3'),
    ];
    await converse(chef, [history.slice(0, 1), history]);
    // An edit of q2 strips [2, 5): SIG_2.
    history[2] = user('q2 (edited)');
    await converse(chef, [history]);
    history.push(reply('a3', 'SIG_3'), user('q4'));
    await converse(chef, [history]);

    // Dropping q1 moves SIG_2 off the old range: SIG_1 and SIG_3 are what is newly stripped.
    const [payload] = await converse(chef, [history.slice(1)]);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['history', 2, 1],
      ['history', 0, 2],
    ]);
    expect(signatures(payload)).toEqual([]);
  });

  it('strips a redacted thinking block, known by its data', async () => {
    const { chef } = chefWith();
    const answered: Message = {
      role: 'assistant',
      content: 'It is 2026-09-28.',
      redacted_thinking: { data: 'OPAQUE_1' },
    };

    const [payload] = await converse(chef, [[...turn1, answered, user('And the price?')]]);

    expect(payload.meta?.prefix?.break).toMatchObject({ reason: 'ledger', strippedThinking: 1 });
    expect(payload.messages[1]).toEqual(text('assistant', 'It is 2026-09-28.'));
  });

  it.each([
    'system',
    'tools',
  ] as const)('strips every thinking block on a %s checkpoint, from that compile on', async (reason) => {
    const { chef } = chefWith();
    chef.registerTools([search]);
    await converse(chef, [turn1, turn2, turn3]);

    if (reason === 'system')
      chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    else chef.registerTools([search, { name: 'fetch', description: 'Fetch a URL' }]);
    const [changed, next] = await converse(chef, [turn3, turn4]);

    expect(changed.meta?.prefix?.break).toEqual({
      reason,
      at: 0,
      signed: false,
      strippedThinking: 2,
    });
    expect(signatures(changed)).toEqual([]);
    expect(signatures(next)).toEqual(['SIG_3']);
    expectAppendOnly([changed, next]);
  });

  it('snapshots what was last sent from inside a compile, so a restore still sees the next change', async () => {
    const { chef } = chefWith();
    await converse(chef, [turn1, turn2, turn3]);
    let saved: ChefSnapshot | undefined;
    chef.on('prefix:break', () => {
      saved = chef.snapshot();
    });
    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    await converse(chef, [turn3]);
    if (!saved) throw new Error('the system checkpoint was reported');

    // SIG_3 is signed over "You are thorough.", which the next request changes again.
    const { chef: next, breaks } = chefWith();
    next.restore(saved);
    next.setSystemPrompt([{ role: 'system', content: 'You are brief.' }]);
    const [payload] = await converse(next, [turn4]);

    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([['system', 3]]);
    expect(signatures(payload)).toEqual([]);
  });

  it('strips nothing on other targets, which have no signature check', async () => {
    const target = new OpenAIAdapter({ preserveThinkingAsText: true });
    const { chef } = chefWith();
    await converse(chef, [turn1, turn2, turn3], target);

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited], target);

    expect(payload.meta?.prefix?.break).toMatchObject({ reason: 'history', strippedThinking: 0 });
    expect(occurrences(payload, 'Reasoning signed SIG_2.')).toBe(1);
  });

  it.each([
    ['gemini', 'GSIG_2'],
    ['openai-responses', 'ENC_2'],
  ])('leaves the signed reasoning %s replays alone after a checkpoint', async (target, kept) => {
    const signed: Message = {
      ...reply('It is 2026-09-28.', 'SIG_2'),
      _gemini_thought_signature: 'GSIG_2',
      _openai_reasoning: [
        { type: 'reasoning', id: 'rs_2', encrypted_content: 'ENC_2', summary: [] },
      ],
    };
    const history = [...turn2, signed, user('And the price?')];
    const { chef } = chefWith();
    await converse(chef, [turn1, turn2, history], target);

    const edited = [...history];
    edited[2] = result('t1', '2026-09-29');
    const [payload] = await converse(chef, [edited], target);

    expect(payload.meta?.prefix?.break).toMatchObject({ reason: 'history', strippedThinking: 0 });
    expect(occurrences(payload, kept)).toBe(1);
  });

  it.each([
    [true, ['SIG_2', 'SIG_3']],
    [false, ['SIG_3']],
  ])('keeps the thinking after a compaction head when it is signed (signed: %s)', async (signed, kept) => {
    const { chef } = chefWith();
    await converse(chef, [turn1, turn2, turn3]);
    const block = { type: 'compaction', content: 'Summary so far.', signature: 'SIG_C' } as const;

    // Compacted [0, 3) before the reply: what the overflow phase records (P6, P8).
    const session = chef.snapshot();
    if (!session.prefixLedger) throw new Error('an appendOnly snapshot carries its ledger');
    const ledger = PrefixLedger.fromSnapshot(session.prefixLedger);
    ledger.reconcile(turn3);
    const replacement = signed ? [anthropicCompactionMessage(block)] : [user('<summary/>')];
    ledger.checkpoint('compaction', 3, { cut: 3, replacement, signed });
    ledger.commit(turn3);
    chef.restore({ ...session, prefixLedger: ledger.snapshot() });

    const [payload] = await converse(chef, [turn4]);

    expect(payload.messages[0]).toEqual(
      signed ? { role: 'assistant', content: [block] } : text('user', '<summary/>'),
    );
    expect(signatures(payload)).toEqual(kept);
    if (signed) expect(payload.betas).toEqual(['compact-2026-09-04']);
    else expect(payload).not.toHaveProperty('betas');
  });
});

describe('appendOnly clearAt: a system-channel source is a turn-scoped reminder in every request', () => {
  const R = reminder(announcement('tools', SEARCH_V2, 1), ANCHOR);

  it('restates it after every user turn, turn-scoped, with its beta', async () => {
    const { chef, breaks, invariants } = clearAt();
    chef.announce('tools', SEARCH_V2);

    const payloads = await converse(chef, [turn1, turn2, turn3]);

    expect(payloads[2].messages).toEqual([Q1, R, CALL_1, RESULT_1, R, REPLY_2, Q2, R]);
    expectAppendOnly(payloads);
    expect(payloads.map((p) => p.betas)).toEqual([
      [CLEAR_AT_BETA],
      [CLEAR_AT_BETA],
      [CLEAR_AT_BETA],
    ]);
    expect(breaks).toEqual([]);
    expect(invariants).toEqual([]);
  });

  it('stops restating a retracted source, with no tombstone, and leaves the reminders sent', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2);

    const payloads = await converse(chef, [turn1, turn2, turn3], 'anthropic', (c, turn) => {
      if (turn === 3) c.retractAnnouncement('tools');
    });

    expect(payloads[2].messages).toEqual([Q1, R, CALL_1, RESULT_1, R, REPLY_2, Q2]);
    expect(occurrences(payloads[2], 'withdrawn')).toBe(0);
    expectAppendOnly(payloads);
    // The cleared reminders are still sent, and the API still has to read clear_at on them.
    expect(payloads[2].betas).toEqual([CLEAR_AT_BETA]);
  });

  it('adds nothing on a retry, and restates a change at its next revision', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2);

    const [first, retried, next] = await converse(
      chef,
      [turn1, turn1, turn2],
      'anthropic',
      (c, turn) => {
        if (turn === 3) c.announce('tools', 'Tool search_v3 is available.');
      },
    );

    expect(wire(retried)).toEqual(wire(first));
    expect(next.messages).toEqual([
      Q1,
      R,
      CALL_1,
      RESULT_1,
      reminder(announcement('tools', 'Tool search_v3 is available.', 2), ANCHOR),
    ]);
  });

  it('withdraws a source in the reminder still showing in the request being retried', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2);

    const [, retried, next] = await converse(
      chef,
      [turn1, turn1, turn2],
      'anthropic',
      (c, turn) => {
        if (turn === 2) c.retractAnnouncement('tools');
      },
    );

    const withdrawn = reminder(
      announcement('tools', SEARCH_V2, 1),
      ANCHOR,
      withdrawnAnnouncement('tools', 2),
      ANCHOR,
    );
    expect(retried.messages).toEqual([Q1, withdrawn]);
    expect(next.messages).toEqual([Q1, withdrawn, CALL_1, RESULT_1]);
  });

  it('withdraws a statement that stays in place before restating its source turn-scoped', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2, { channel: 'user_tail' });

    const payloads = await converse(chef, [turn1, turn2], 'anthropic', (c, turn) => {
      if (turn === 2) c.announce('tools', SEARCH_V2, { channel: 'system' });
    });

    // Left alone, the user-channel statement would outlive every reminder.
    expect(payloads[1].messages).toEqual([
      Q1,
      text('user', `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`),
      CALL_1,
      RESULT_1,
      text('user', `${withdrawnAnnouncement('tools', 2)}\n\n${ANCHOR}`),
      reminder(announcement('tools', SEARCH_V2, 3), ANCHOR),
    ]);
    expectAppendOnly(payloads);
  });

  it('leaves the user-channel sources to events appended once', async () => {
    const { chef } = clearAt();
    chef.setDynamicState(State, { step: 1 }).announce('tools', SEARCH_V2);

    const [, payload] = await converse(chef, [turn1, turn2]);

    expect(payload.messages).toEqual([
      Q1,
      text('user', `${state(1, 1)}\n\n${ANCHOR}`),
      R,
      CALL_1,
      RESULT_1,
      R,
    ]);
  });

  it("restates skill instructions and dynamic state at 'system' as well, and withdraws neither", async () => {
    const { chef } = clearAt();
    chef.activateSkill(RESEARCHER).setDynamicState(State, { step: 1 }, { placement: 'system' });

    const payloads = await converse(chef, [turn1, turn2, turn3], 'anthropic', (c, turn) => {
      if (turn === 3)
        c.activateSkill(null).setDynamicState(z.null(), null, { placement: 'system' });
    });

    const both = reminder(skillEvent(1), state(1, 1), ANCHOR);
    expect(payloads[2].messages).toEqual([Q1, both, CALL_1, RESULT_1, both, REPLY_2, Q2]);
    expectAppendOnly(payloads);
  });

  it.each([
    'openai',
    'gemini',
    'openai-responses',
  ])('is ignored on %s: a system-channel source is appended once and withdrawn by a tombstone', async (target) => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2, { channel: 'system' });

    const payloads = await converse(chef, [turn1, turn2, turn3], target, (c, turn) => {
      if (turn === 3) c.retractAnnouncement('tools');
    });

    expectAppendOnly(payloads);
    expect(occurrences(payloads[2], announcement('tools', SEARCH_V2, 1))).toBe(1);
    expect(occurrences(payloads[2], withdrawnAnnouncement('tools', 2))).toBe(1);
    expect(occurrences(payloads[2], 'clear_at')).toBe(0);
    expect(payloads[2]).not.toHaveProperty('betas');
  });

  it('never sends a reminder followed by a user message, or with a breakpoint on it', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2);
    // A host that makes whatever comes last its cache breakpoint.
    chef.use('before-adapt', (messages) => {
      messages[messages.length - 1]._cache_breakpoint = true;
    });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4], 'anthropic', (c, turn) => {
      c.setDynamicState(State, { step: turn });
    });

    for (const payload of payloads) {
      const messages = payload.messages as Array<{ role: string; clear_at?: string }>;
      messages.forEach((message, i) => {
        if (message.clear_at === undefined) return;
        expect(messages[i + 1]?.role ?? 'assistant').toBe('assistant');
        expect(JSON.stringify(message)).not.toContain('cache_control');
      });
    }
    // The breakpoint went on the message in front of the reminder: this turn's state.
    expect(payloads[3].messages.slice(-2)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${state(4, 4)}\n\n${ANCHOR}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      R,
    ]);
  });

  it('merges its beta with the ones server-side context management needs', async () => {
    const { chef } = clearAt({ contextManagement: { strategy: 'server' } });
    chef.announce('tools', SEARCH_V2);

    const [payload] = await converse(chef, [turn1]);

    expect(payload.betas).toEqual([CLEAR_AT_BETA, 'compact-2026-01-12']);
  });
});

describe('appendOnly clearAt: a reminder waits for a user turn right before it', () => {
  const R = reminder(announcement('tools', SEARCH_V2, 1), ANCHOR);

  it('sends none in a request with no user turn yet, and one after the first', async () => {
    const warn = vi.fn();
    const { chef, breaks } = clearAt({ logger: { warn } });
    chef.announce('tools', SEARCH_V2);

    const [empty, first] = await converse(chef, [[], turn1]);

    // Said as a user message instead, it could not be turn-scoped; hoisted, it would change system.
    expect(empty.messages).toEqual([]);
    expect(empty.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
    expect(first.messages).toEqual([Q1, R]);
    expect(breaks).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('positional'))).toEqual([]);
  });

  it('sends none after a reply the host compiles again before the next question', async () => {
    const { chef } = clearAt();
    chef.announce('tools', SEARCH_V2);
    const answered = [...turn1, reply('It is 2026-09-28.', 'SIG_1')];
    const REPLY_1 = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Reasoning signed SIG_1.', signature: 'SIG_1' },
        { type: 'text', text: 'It is 2026-09-28.' },
      ],
    };

    const payloads = await converse(chef, [turn1, answered, [...answered, user('And the price?')]]);

    expect(payloads[1].messages).toEqual([Q1, R, REPLY_1]);
    expect(payloads[2].messages).toEqual([Q1, R, REPLY_1, Q2, R]);
    expectAppendOnly(payloads);
  });

  it('sends one behind a user event of its own group when no user turn comes before', async () => {
    const { chef } = clearAt();
    chef.setDynamicState(State, { step: 1 }).announce('tools', SEARCH_V2);

    const [empty, first] = await converse(chef, [[], turn1]);

    const event = text('user', `${state(1, 1)}\n\n${ANCHOR}`);
    expect(empty.messages).toEqual([event, R]);
    // Unanswered, the group moved behind the first turn.
    expect(first.messages).toEqual([Q1, event, R]);
  });
});

describe("appendOnly and the host's own system messages", () => {
  const NOTE: Message = { role: 'system', content: 'The repo uses pnpm.', _positional: true };
  const NOTE_SENT = { role: 'system', content: [{ type: 'text', text: 'The repo uses pnpm.' }] };

  it('appends events in front of a system message the history ends with', async () => {
    // A user message right after a mid-conversation system message is a 400.
    const { chef, breaks } = chefWith();
    const answered = [...turn1, NOTE, reply('On it.', 'SIG_1'), user('Go on.'), NOTE];

    const payloads = await converse(chef, [[...turn1, NOTE], answered], 'anthropic', (c, turn) =>
      c.setDynamicState(State, { step: turn }),
    );

    const event = (step: number) => text('user', `${state(step, step)}\n\n${ANCHOR}`);
    expect(payloads[1].messages).toEqual([
      Q1,
      event(1),
      NOTE_SENT,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning signed SIG_1.', signature: 'SIG_1' },
          { type: 'text', text: 'On it.' },
        ],
      },
      text('user', 'Go on.'),
      event(2),
      NOTE_SENT,
    ]);
    expectAppendOnly(payloads);
    expect(breaks).toEqual([]);
  });

  it('leaves events after a system message that follows a reply, which is hoisted anyway', async () => {
    // In front of it, the event would make it positional, and the next turn hoist it again:
    // two `system` checkpoints, each stripping every thinking block.
    const { chef, breaks } = chefWith();
    const answered = [...turn1, reply('It is 2026-09-28.', 'SIG_1'), NOTE];
    // Hoisting the host's note changes the system prompt once: a `system` checkpoint.
    await converse(chef, [turn1, answered]);
    expect(breaks.map((b) => b.reason)).toEqual(['system']);

    chef.announce('tools', SEARCH_V2);
    const payloads = await converse(chef, [answered, [...answered, user('And the price?')]]);

    expect(breaks.map((b) => b.reason)).toEqual(['system']);
    for (const payload of payloads) {
      expect(payload.system).toEqual([
        { type: 'text', text: 'You are terse.' },
        { type: 'text', text: 'The repo uses pnpm.' },
      ]);
    }
    const event = `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`;
    expect(payloads[0].messages.slice(2)).toEqual([text('user', event)]);
    // Unanswered, it moved behind the next turn.
    expect(payloads[1].messages.slice(2)).toEqual([
      Q2,
      { role: 'system', content: [{ type: 'text', text: event }] },
    ]);
  });

  it('keeps one parsed with keepPositionalSystem where it was, turn scope included', async () => {
    const sent = [
      { role: 'user', content: 'Fix the failing test.' },
      { role: 'system', clear_at: 'next_user_message', content: 'Read both files at once.' },
    ] as unknown as MessageParam[];
    const answered = [
      ...sent,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'SIG_1' },
          { type: 'text', text: 'Reading both files.' },
        ],
      },
      { role: 'user', content: 'Go on.' },
    ] as MessageParam[];
    const parse = (messages: MessageParam[]) =>
      fromAnthropic(messages, undefined, { keepPositionalSystem: true }).history;
    const { chef, breaks } = chefWith();

    const payloads = await converse(chef, [parse(sent), parse(answered)]);

    expect(payloads[1].messages[1]).toEqual(reminder('Read both files at once.'));
    expect(signatures(payloads[1])).toEqual(['SIG_1']);
    expect(payloads[1].betas).toEqual([CLEAR_AT_BETA]);
    expectAppendOnly(payloads);
    expect(breaks).toEqual([]);
  });
});

describe('appendOnly and the cache audit', () => {
  it('does not read the events appended before a breakpoint as volatile', async () => {
    const warn = vi.fn();
    const { chef } = chefWith({
      logger: { warn },
      cacheAudit: true,
      store: new InMemoryBackend(),
      memory: {},
    });
    await chef.getMemory().set('lang', 'TypeScript');
    chef.activateSkill(RESEARCHER);
    const marked = [...turn3.slice(0, 4), { ...user('And the price?'), _cache_breakpoint: true }];

    const [, , payload] = await converse(chef, [turn1, turn2, marked]);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('cache audit'))).toEqual([]);
    // The same payload read as 4.x tail content: both events sit before the breakpoint.
    expect(auditAnthropicCachePlacement(payload).map((i) => i.dedupeKey)).toEqual([
      'memory data block@prefix',
      'skill tail instructions@prefix',
    ]);
  });
});
