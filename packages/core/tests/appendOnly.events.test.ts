/**
 * `ChefConfig.appendOnly`, concept one: every push source still renders what it
 * says now on each compile, but it reaches the window only when that differs
 * from the last thing the window holds from it — appended once, at the tail,
 * then replayed where it was sent. A source that goes quiet leaves a
 * tombstone; one that says the same again leaves nothing.
 *
 * Conversations are compiled turn by turn from the first request, as an agent
 * loop does. Every expected message below is worked out by hand from the host
 * history and the events each turn appends.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AnnouncementChannel,
  type ChefConfig,
  type ChefEvents,
  ContextChef,
  checkPrefixContinuity,
  OpenAIAdapter,
  Prompts,
} from '../src/index';
import type {
  AnthropicPayload,
  ChefLogger,
  ITargetAdapter,
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
  // Not the reply's own words: on Anthropic each text should be sent once.
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
const turn5: Message[] = [...turn4, reply('You are welcome.', 'SIG_4'), user('Bye.')];

const State = z.object({ step: z.number() });

const ANCHOR = Prompts.EVENT_STATE_ANCHOR;
const state = (step: number, rev: number) =>
  `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>`;
const announcement = (id: string, content: string, rev: number) =>
  `<announcement rev="${rev}" id="${id}">\n${content}\n</announcement>`;
const withdrawnAnnouncement = (id: string, rev: number) =>
  `<announcement rev="${rev}" id="${id}" withdrawn="true">${Prompts.ANNOUNCEMENT_WITHDRAWN}</announcement>`;
/** A last_user guardrail event; from its second revision on it says it replaces the one before. */
const outputFormat = (outputTag: string, rev: number) =>
  `<output_format rev="${rev}">\n${rev > 1 ? `${Prompts.GUARDRAIL_RESTATED}\n\n` : ''}` +
  `${Prompts.getXMLGuardrail(outputTag)}\n</output_format>`;
const withdrawnFormat = (rev: number, note: string) =>
  `<output_format rev="${rev}" withdrawn="true">${note}</output_format>`;
const SEARCH_V2 = 'Tool search_v2 is available.';

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

/** Compiles each turn in order, `setup` first, as the agent loop does. */
async function converse(
  chef: ContextChef,
  turns: Message[][],
  target: Target = 'openai',
  setup: (chef: ContextChef, turn: number) => void = () => {},
): Promise<TargetPayload[]> {
  const payloads: TargetPayload[] = [];
  for (const [i, history] of turns.entries()) {
    setup(chef, i + 1);
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

/** What reaches the provider: the payload without `meta`. */
const wire = (payload: TargetPayload): Omit<TargetPayload, 'meta'> => {
  const { meta: _meta, ...rest } = payload;
  return rest;
};

/** `text` as it appears inside the serialized wire. */
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);

/** How often `text` occurs anywhere in what is sent. */
const occurrences = (payload: TargetPayload, text: string): number =>
  JSON.stringify(wire(payload)).split(escaped(text)).length - 1;

/** Each of `texts` is sent exactly once, in this order, whatever the target's message shape. */
function expectSentInOrder(payload: TargetPayload, texts: string[]) {
  const sent = JSON.stringify(wire(payload));
  for (const text of texts) expect(occurrences(payload, text), text).toBe(1);
  const at = texts.map((text) => sent.indexOf(escaped(text)));
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

describe('appendOnly: what 4.x moved to the tail every turn stays where it was sent', () => {
  // The cases tests/prefixContinuity.test.ts pins for the default mode, where
  // a tail injection breaks the prefix at the turn it sat in last time, plus
  // dynamic state at 'system', which Anthropic hoists by default.
  const cases: Array<[string, (chef: ContextChef) => void]> = [
    ["dynamic state at 'last_user'", (chef) => chef.setDynamicState(State, { step: 1 })],
    [
      "dynamic state at 'system'",
      (chef) => chef.setDynamicState(State, { step: 1 }, { placement: 'system' }),
    ],
    ...(['system', 'user_tail'] satisfies AnnouncementChannel[]).map(
      (channel): [string, (chef: ContextChef) => void] => [
        `an announcement on the '${channel}' channel`,
        (chef) => chef.announce('tools', SEARCH_V2, { channel }),
      ],
    ),
    [
      "a guardrail at 'last_user'",
      (chef) => chef.withGuardrails({ enforceXML: { outputTag: 'out' }, placement: 'last_user' }),
    ],
    [
      "a guardrail at 'system'",
      (chef) => chef.withGuardrails({ enforceXML: { outputTag: 'out' } }),
    ],
  ];

  describe.each(cases)('%s', (_name, configure) => {
    it.each(TARGETS)('keeps every turn the prefix of the next (%s)', async (target) => {
      const { chef, breaks, invariants } = chefWith();
      configure(chef);

      const payloads = await converse(chef, [turn1, turn2, turn3, turn4], target);

      expectAppendOnly(payloads);
      expect(breaks).toEqual([]);
      expect(invariants).toEqual([]);
    });
  });

  it('sends the dynamic state once, right after the request it was set for', async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });

    const [first, , third] = await converse(chef, [turn1, turn2, turn3]);

    expect(contents(first)).toEqual([
      'You are terse.',
      'Find the release date.',
      `<dynamic_state rev="1">\n  <step>1</step>\n</dynamic_state>\n\n${ANCHOR}`,
    ]);
    expect(contents(third)).toEqual([
      'You are terse.',
      'Find the release date.',
      `${state(1, 1)}\n\n${ANCHOR}`,
      '',
      '2026-09-28',
      'It is 2026-09-28.',
      'And the price?',
    ]);
  });

  it('says which block counts in the anchor line', () => {
    expect(Prompts.EVENT_STATE_ANCHOR).toBe(
      'Above is the current system state. Each block supersedes any earlier block of its kind ' +
        '(same tag and id). Use it to guide your next action.',
    );
    // The 4.x line is what the default mode still sends.
    expect(Prompts.STATE_ANCHOR).toBe(
      'Above is the current system state. Use it to guide your next action.',
    );
  });

  it("puts dynamic state at 'system' in a positional system event, not the top-level system", async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 }, { placement: 'system' });

    const [first, second] = (await converse(chef, [turn1, turn2], 'anthropic')) as [
      AnthropicPayload,
      AnthropicPayload,
    ];

    expect(first.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
    expect(first.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      { role: 'system', content: [{ type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}` }] },
    ]);
    expect(second.system).toEqual(first.system);
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
  });

  it('appends implicit context as a user event of its own, apart from system-placed state', async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 }, { placement: 'system' });
    chef.use('before-assemble', (ctx) => ctx.inject('docs: v2'));

    const [payload] = await converse(chef, [turn1], 'anthropic');

    expect((payload as AnthropicPayload).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<implicit_context rev="1">\ndocs: v2\n</implicit_context>\n\n${ANCHOR}`,
          },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}` }] },
    ]);
  });

  it("keeps a 'system' guardrail at the end of the system layers", async () => {
    const guardrail = { enforceXML: { outputTag: 'out' } };
    const { chef } = chefWith();
    chef.withGuardrails(guardrail);
    const off = new ContextChef({ logger: silent })
      .setSystemPrompt([{ role: 'system', content: 'You are terse.' }])
      .withGuardrails(guardrail);

    const [anthropic] = await converse(chef, [turn1], 'anthropic');
    const [, openai] = await converse(chefWith().chef.withGuardrails(guardrail), [turn1, turn2]);

    // Anthropic hoisted it after the system prompt anyway: the same bytes as 4.x.
    expect((anthropic as AnthropicPayload).system).toEqual(
      ((await off.setHistory(turn1).compile({ target: 'anthropic' })) as AnthropicPayload).system,
    );
    // Chat Completions sent it after the history, where every turn moved it.
    expect(contents(openai)).toEqual([
      'You are terse.',
      Prompts.getXMLGuardrail('out'),
      'Find the release date.',
      '',
      '2026-09-28',
    ]);
  });

  it.each(
    TARGETS,
  )('reports new guardrail options as a `system` checkpoint (%s)', async (target) => {
    const { chef, breaks } = chefWith();
    chef.withGuardrails({ enforceXML: { outputTag: 'out' } });
    await converse(chef, [turn1, turn2], target);

    chef.withGuardrails({ enforceXML: { outputTag: 'answer' } });
    const [payload] = await converse(chef, [turn3], target);

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['system', 0]]);
    expect(payload.meta?.prefix?.break?.reason).toBe('system');
  });
});

describe('appendOnly: a source is appended again only when what it says changed', () => {
  it.each(
    THREE,
  )('appends a changed state with the next revision, and leaves the old one where it was (%s)', async (target) => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], target, (c, turn) =>
      c.setDynamicState(State, { step: turn === 1 ? 1 : 2 }),
    );

    expectAppendOnly(payloads);
    expectSentInOrder(payloads[2], [
      'Find the release date.',
      state(1, 1),
      state(2, 2),
      'It is 2026-09-28.',
      'And the price?',
    ]);
  });

  it('appends a state changed in the tool loop right after the tool result', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', (c, turn) =>
      c.setDynamicState(State, { step: turn === 1 ? 1 : 2 }),
    );

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      'Find the release date.',
      `${state(1, 1)}\n\n${ANCHOR}`,
      '',
      '2026-09-28',
      `${state(2, 2)}\n\n${ANCHOR}`,
      'It is 2026-09-28.',
      'And the price?',
    ]);
  });

  it('appends the same state again when its placement moves it to the other channel', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn3], 'anthropic', (c, turn) =>
      c.setDynamicState(State, { step: 1 }, { placement: turn === 1 ? 'last_user' : 'system' }),
    );

    expectAppendOnly(payloads);
    expect((payloads[1] as AnthropicPayload).messages.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'And the price?' }] },
      { role: 'system', content: [{ type: 'text', text: `${state(1, 2)}\n\n${ANCHOR}` }] },
    ]);
  });

  it.each(THREE)('appends nothing more while the state stays the same (%s)', async (target) => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4, turn5], target);

    expectAppendOnly(payloads);
    const last = payloads[payloads.length - 1];
    expect(occurrences(last, '<dynamic_state rev="1">')).toBe(1);
    expect(occurrences(last, '<dynamic_state rev="2"')).toBe(0);
    expect(occurrences(last, ANCHOR)).toBe(1);
  });

  it.each(
    THREE,
  )('appends a tombstone for a retracted announcement and leaves the statement in place (%s)', async (target) => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], target, (c, turn) => {
      if (turn === 1) c.announce('tools', SEARCH_V2, { channel: 'user_tail' });
      if (turn === 2) c.retractAnnouncement('tools');
    });

    expectAppendOnly(payloads);
    expectSentInOrder(payloads[2], [
      'Find the release date.',
      `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`,
      `${withdrawnAnnouncement('tools', 2)}\n\n${ANCHOR}`,
      'It is 2026-09-28.',
      'And the price?',
    ]);
  });

  it('sends exactly what it appends: one message per turn on Chat Completions', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', (c, turn) => {
      if (turn === 1) c.announce('tools', SEARCH_V2, { channel: 'user_tail' });
      if (turn === 2) c.retractAnnouncement('tools');
    });

    expect(contents(payloads[2])).toEqual([
      'You are terse.',
      'Find the release date.',
      `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`,
      '',
      '2026-09-28',
      `${withdrawnAnnouncement('tools', 2)}\n\n${ANCHOR}`,
      'It is 2026-09-28.',
      'And the price?',
    ]);
  });

  it.each(
    THREE,
  )('withdraws a cleared state and implicit context that stopped coming (%s)', async (target) => {
    const { chef } = chefWith();
    let retrieved = 'docs: v2';
    chef.use('before-assemble', (ctx) => ctx.inject(retrieved));

    const payloads = await converse(chef, [turn1, turn3], target, (c, turn) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 2) {
        c.setDynamicState(z.null(), null);
        retrieved = '';
      }
    });

    expectAppendOnly(payloads);
    expectSentInOrder(payloads[1], [
      'And the price?',
      `<dynamic_state rev="2" withdrawn="true">${Prompts.DYNAMIC_STATE_WITHDRAWN}</dynamic_state>` +
        `\n\n<implicit_context rev="2" withdrawn="true">${Prompts.IMPLICIT_CONTEXT_WITHDRAWN}</implicit_context>` +
        `\n\n${ANCHOR}`,
    ]);
  });

  it.each(
    THREE,
  )('restates a changed last_user guardrail as replacing the earlier one, and withdraws a cleared one (%s)', async (target) => {
    const { chef } = chefWith();
    const guardrail = (outputTag: string) => ({
      enforceXML: { outputTag },
      placement: 'last_user' as const,
    });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4], target, (c, turn) => {
      if (turn === 1) c.withGuardrails(guardrail('out'));
      if (turn === 3) c.withGuardrails(guardrail('answer'));
      if (turn === 4) c.withGuardrails(null);
    });

    expectAppendOnly(payloads);
    // An instruction, not system state: no anchor line of its own.
    expectSentInOrder(payloads[3], [
      `<output_format rev="1">\n${Prompts.getXMLGuardrail('out')}\n</output_format>`,
      'It is 2026-09-28.',
      'And the price?',
      `<output_format rev="2">\n${Prompts.GUARDRAIL_RESTATED}\n\n${Prompts.getXMLGuardrail('answer')}\n</output_format>`,
      'About $40.',
      'Thanks.',
      withdrawnFormat(3, Prompts.GUARDRAIL_WITHDRAWN),
    ]);
    expect(occurrences(payloads[3], ANCHOR)).toBe(0);
    expect(Prompts.GUARDRAIL_RESTATED).toBe(
      'These output format instructions replace any given earlier in this conversation.',
    );
  });

  it.each(
    THREE,
  )("withdraws the last_user guardrail event when the instructions move to 'system', pointing there (%s)", async (target) => {
    const { chef, breaks } = chefWith();

    const [, moved] = await converse(chef, [turn1, turn3], target, (c, turn) =>
      c.withGuardrails(
        turn === 1
          ? { enforceXML: { outputTag: 'out' }, placement: 'last_user' }
          : { enforceXML: { outputTag: 'answer' }, placement: 'system' },
      ),
    );

    // New options in the system prompt: a `system` checkpoint, and the event says where they went.
    expect(breaks.map((b) => b.reason)).toEqual(['system']);
    expect(occurrences(moved, Prompts.getXMLGuardrail('answer'))).toBe(1);
    expectSentInOrder(moved, [
      outputFormat('out', 1),
      'And the price?',
      withdrawnFormat(2, Prompts.GUARDRAIL_MOVED),
    ]);
    expect(Prompts.GUARDRAIL_MOVED).toBe(
      'The output format instructions given earlier are replaced by the ones in the system prompt.',
    );
  });

  it("carries a prefillMode 'instruction' prefill with the last_user guardrail, once", async () => {
    const { chef } = chefWith();
    chef.withGuardrails({
      enforceXML: { outputTag: 'out' },
      prefill: '<out>',
      prefillMode: 'instruction',
      placement: 'last_user',
    });

    const [first, second] = await converse(chef, [turn1, turn3], 'anthropic');

    expectAppendOnly([first, second]);
    const instructions = `${Prompts.getXMLGuardrail('out')}\n\n${Prompts.getPrefillEnforcement('<out>')}`;
    expect(occurrences(second, instructions)).toBe(1);
  });

  // Their adapters would fold it into whichever user message is last: a different one every turn.
  it.each([
    'openai',
    'gemini',
    'openai-responses',
  ] as const)('asks for a guardrail prefill with its instructions on %s, which has no native prefill', async (target) => {
    const { chef, breaks, invariants } = chefWith();
    chef.withGuardrails({ enforceXML: { outputTag: 'out' }, prefill: '<out>' });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4], target);

    expectAppendOnly(payloads);
    expect(breaks).toEqual([]);
    expect(invariants).toEqual([]);
    const instructions = `${Prompts.getXMLGuardrail('out')}\n\n${Prompts.getPrefillEnforcement('<out>')}`;
    for (const payload of payloads) expect(occurrences(payload, instructions)).toBe(1);
  });

  it("warns once when prefillMode 'native' is set explicitly on a target without native prefill", async () => {
    const warn = vi.fn();
    const { chef } = chefWith({ logger: { warn } });
    chef.withGuardrails({ prefill: '<out>', prefillMode: 'native' });

    const [, payload] = await converse(chef, [turn1, turn3]);

    const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('native'));
    expect(warned).toEqual([
      "[context-chef] appendOnly: the guardrail's prefillMode 'native' on a target without " +
        'native prefill: its adapter folds the prefill into the last user message of each ' +
        'request, a different message every turn, so each request stops repeating the one ' +
        "before. Leave prefillMode unset or set 'instruction' (warned once).",
    ]);
    expect(contents(payload).at(-1)).toBe(
      `And the price?\n\n${Prompts.getPrefillEnforcement('<out>')}`,
    );
  });

  it('leaves a guardrail prefill to the adapter with appendOnly off, as 4.x does', async () => {
    const chef = new ContextChef({ logger: silent })
      .setSystemPrompt([{ role: 'system', content: 'You are terse.' }])
      .withGuardrails({ prefill: '<out>' });

    const payload = await chef.setHistory(turn1).compile({ target: 'openai' });

    expect(contents(payload)).toEqual([
      'You are terse.',
      `Find the release date.\n\n${Prompts.getPrefillEnforcement('<out>')}`,
    ]);
  });

  // The adapter says whether it has a native prefill; the chef does not guess from its class.
  it.each([
    ['a subclass of a built-in adapter', new (class extends OpenAIAdapter {})()],
    [
      'a wrapper that says it has none',
      { nativePrefill: false, compile: (m: Message[]) => new OpenAIAdapter().compile(m) },
    ],
  ] as Array<
    [string, ITargetAdapter]
  >)('asks for the prefill with the instructions through %s', async (_name, target) => {
    const { chef } = chefWith();
    chef.withGuardrails({ prefill: '<out>' });

    const payloads: TargetPayload[] = [];
    for (const history of [turn1, turn2, turn3]) {
      payloads.push(await chef.setHistory(history).compile({ target }));
    }

    expectAppendOnly(payloads);
    for (const payload of payloads) {
      expect(occurrences(payload, Prompts.getPrefillEnforcement('<out>'))).toBe(1);
    }
  });

  it('leaves the prefill to a wrapper that does not say it has no native prefill', async () => {
    const { chef } = chefWith();
    chef.withGuardrails({ prefill: '<out>' });
    const wrapper: ITargetAdapter = { compile: (m) => new OpenAIAdapter().compile(m) };

    const payload = await chef.setHistory(turn1).compile({ target: wrapper });

    expect(contents(payload)).toEqual([
      'You are terse.',
      `Find the release date.\n\n${Prompts.getPrefillEnforcement('<out>')}`,
    ]);
  });

  it('puts the events of several sources one compile appends in one user message', async () => {
    const { chef } = chefWith();
    chef
      .setDynamicState(State, { step: 1 })
      .announce('tools', SEARCH_V2, { channel: 'user_tail' })
      .withGuardrails({ enforceXML: { outputTag: 'out' }, placement: 'last_user' });
    chef.use('before-assemble', (ctx) => ctx.inject('docs: v2'));

    const [payload] = await converse(chef, [turn1]);

    // 4.x's tail order: state, implicit context, announcements, anchor, guardrail.
    expect(contents(payload)).toEqual([
      'You are terse.',
      'Find the release date.',
      [
        state(1, 1),
        '<implicit_context rev="1">\ndocs: v2\n</implicit_context>',
        announcement('tools', SEARCH_V2, 1),
        ANCHOR,
        outputFormat('out', 1),
      ].join('\n\n'),
    ]);
  });

  it.each([
    ['anthropic', 'system'],
    ['openai', 'user'],
    ['gemini', 'user'],
    ['openai-responses', 'user'],
  ] as const)("appends an 'auto' announcement on the %s target as a %s event", async (target, channel) => {
    const { chef } = chefWith();
    chef.announce('tools', SEARCH_V2);

    await converse(chef, [turn1], target);

    const entries = chef.snapshot().prefixLedger?.entries ?? [];
    expect(
      entries.filter((e) => e.sources.includes('announcement:tools')).map((e) => e.channel),
    ).toEqual([channel]);
  });

  it('puts user events before system events, one message per channel', async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 }).announce('tools', SEARCH_V2);

    const [payload] = await converse(chef, [turn1], 'anthropic');

    expect((payload as AnthropicPayload).messages.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}` }] },
      {
        role: 'system',
        content: [{ type: 'text', text: `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}` }],
      },
    ]);
  });
});

describe('appendOnly: where events go', () => {
  it('appends after the tool results of a tool-loop turn and keeps them there once answered', async () => {
    const { chef } = chefWith();

    const [, inLoop, answered] = (await converse(
      chef,
      [turn1, turn2, turn3],
      'anthropic',
      (c, turn) => {
        if (turn === 2) c.announce('tools', SEARCH_V2, { channel: 'system' });
      },
    )) as AnthropicPayload[];

    const event = {
      role: 'system',
      content: [{ type: 'text', text: `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}` }],
    };
    expect(inLoop.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '2026-09-28' },
    ]);
    expect(inLoop.messages[3]).toEqual(event);
    expect(answered.messages[3]).toEqual(event);
    expect(answered.messages[4].role).toBe('assistant');
  });

  it('appends before an assistant prefill the history ends with', async () => {
    const { chef } = chefWith();
    const prefilled = [...turn1, { role: 'assistant' as const, content: 'The date is' }];

    const payloads = (await converse(
      chef,
      [turn1, prefilled, prefilled],
      'anthropic',
      (c, turn) => {
        c.setDynamicState(State, { step: turn === 1 ? 1 : 2 });
      },
    )) as AnthropicPayload[];

    // The prefill is not an answer: what is appended before it joins the event already there.
    expect(payloads[1].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}\n\n${state(2, 2)}\n\n${ANCHOR}` },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The date is' }] },
    ]);
    expect(wire(payloads[2])).toEqual(wire(payloads[1]));
  });

  it.each(
    THREE,
  )('appends after a signed reply the history ends with, never into the group it answered (%s)', async (target) => {
    const { chef, breaks, invariants } = chefWith();
    const answered = [...turn1, reply('It is 2026-09-28.', 'SIG_1')];

    // The reply arrived and the host compiled once more, to meter it, before the next question.
    const [first, , next] = await converse(
      chef,
      [turn1, answered, [...answered, user('And the price?')]],
      target,
      (c, turn) => c.setDynamicState(State, { step: turn === 1 ? 1 : 2 }),
    );

    expect(breaks).toEqual([]);
    expect(invariants).toEqual([]);
    expectAppendOnly([first, next]);
    expectSentInOrder(next, [
      'Find the release date.',
      `${state(1, 1)}\n\n${ANCHOR}`,
      'It is 2026-09-28.',
      'And the price?',
      `${state(2, 2)}\n\n${ANCHOR}`,
    ]);
  });

  it("adds to the group in front of the guardrail's prefill on a retry", async () => {
    const { chef } = chefWith();
    chef.withGuardrails({ prefill: '<out>' });

    const [, retried] = (await converse(chef, [turn1, turn1], 'anthropic', (c, turn) =>
      c.setDynamicState(State, { step: turn }),
    )) as AnthropicPayload[];

    expect(retried.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}\n\n${state(2, 2)}\n\n${ANCHOR}` },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '<out>' }] },
    ]);
  });

  it('appends before a prefill that follows a reply, and after the reply', async () => {
    const { chef } = chefWith();
    const prefilled = [
      ...turn1,
      reply('It is 2026-09-28.', 'SIG_1'),
      { role: 'assistant' as const, content: 'Also,' },
    ];

    const [, payload] = (await converse(chef, [turn1, prefilled], 'anthropic', (c, turn) =>
      c.setDynamicState(State, { step: turn }),
    )) as AnthropicPayload[];

    expect(payload.messages.map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(payload.messages[1].content).toEqual([
      { type: 'text', text: `${state(1, 1)}\n\n${ANCHOR}` },
    ]);
    expect(payload.messages.slice(3)).toEqual([
      { role: 'user', content: [{ type: 'text', text: `${state(2, 2)}\n\n${ANCHOR}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Also,' }] },
    ]);
  });

  it.each(
    THREE,
  )('replays the same bytes on a retry, and adds a change to the unanswered tail (%s)', async (target) => {
    const { chef, breaks } = chefWith();

    const [, , first, retried] = await converse(
      chef,
      [turn1, turn2, turn3, turn3],
      target,
      (c, turn) => {
        if (turn === 3) c.setDynamicState(State, { step: 1 });
      },
    );
    chef.setDynamicState(State, { step: 2 });
    const [changed] = await converse(chef, [turn3], target);
    const [next] = await converse(chef, [turn4], target);

    expect(breaks).toEqual([]);
    expect(wire(retried)).toEqual(wire(first));
    expectSentInOrder(changed, [
      'And the price?',
      `${state(1, 1)}\n\n${ANCHOR}\n\n${state(2, 2)}\n\n${ANCHOR}`,
    ]);
    expectAppendOnly([changed, next]);
  });

  it('adds only its own events, with a warning, when an after-assemble handler rewrote the ones before them', async () => {
    const warn = vi.fn();
    const { chef } = chefWith({ logger: { warn } });
    const rewritten = (content: string) => content.replace('rev=', 'revision=');
    chef.use('after-assemble', (messages) =>
      messages.map((m) =>
        m.content.startsWith('<dynamic_state') ? { ...m, content: rewritten(m.content) } : m,
      ),
    );
    chef.setDynamicState(State, { step: 1 });
    await converse(chef, [turn1]);

    chef.setDynamicState(State, { step: 2 });
    const [payload] = await converse(chef, [turn1]);

    const moved = warn.mock.calls.filter(([message]) =>
      String(message).includes('the events at the end of the window were moved or rewritten'),
    );
    expect(moved).toHaveLength(1);
    expect(contents(payload)).toEqual([
      'You are terse.',
      'Find the release date.',
      `${rewritten(state(1, 1))}\n\n${ANCHOR}`,
      `${state(2, 2)}\n\n${ANCHOR}`,
    ]);

    // A system event added on its own right after a user turn stays a system message.
    chef.announce('tools', SEARCH_V2, { channel: 'system' });
    const [third] = await converse(chef, [turn1]);
    expect((third as OpenAIPayload).messages.slice(-1)).toEqual([
      { role: 'system', content: `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}` },
    ]);
  });

  it.each(
    THREE,
  )('appends the handoff notice once in its window, and keeps it in place (%s)', async (target) => {
    const { chef } = chefWith({
      // 10 tokens per message; the notice is due with 50 or fewer left before 100.
      janitor: {
        contextWindow: 100,
        triggerRatio: 1,
        tokenizer: (messages) => messages.length * 10,
      },
      overflow: { handoff: { budgetTokens: 50, prompt: 'HANDOFF, {n_remaining} tokens left' } },
    });
    const turns = [
      [user('q1')],
      [user('q1'), reply('a1', 'S1'), user('q2')],
      [user('q1'), reply('a1', 'S1'), user('q2'), reply('a2', 'S2'), user('q3')],
      [
        ...[user('q1'), reply('a1', 'S1'), user('q2'), reply('a2', 'S2'), user('q3')],
        reply('a3', 'S3'),
        user('q4'),
      ],
    ];

    const payloads = await converse(chef, turns, target);

    expectAppendOnly(payloads);
    const notice = `<announcement id="__handoff__">\nHANDOFF, 50 tokens left\n</announcement>\n\n${ANCHOR}`;
    expect(occurrences(payloads[1], 'HANDOFF')).toBe(0);
    expectSentInOrder(payloads[2], ['q3', notice]);
    expectSentInOrder(payloads[3], ['q3', notice, 'q4']);
  });
});

describe('appendOnly: after a checkpoint, the current state is stated again', () => {
  it.each(
    THREE,
  )('appends what changed and withdraws what went quiet since the last word the window kept (%s)', async (target) => {
    const { chef, breaks } = chefWith();
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) {
        c.setDynamicState(State, { step: 1 });
        c.announce('tools', SEARCH_V2, { channel: 'user_tail' });
        c.announce('docs', 'Docs are indexed.', { channel: 'user_tail' });
      }
      if (turn === 2) {
        c.setDynamicState(State, { step: 2 });
        c.retractAnnouncement('tools');
      }
    };
    await converse(chef, [turn1, turn2, turn3], target, setup);

    // The host rewrote the tool result: what turn 2 appended after it is gone.
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [restated] = await converse(chef, [edited], target);

    // [user, events, call, result*, …]: the edited result sits at window index 3.
    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 3]]);
    expectSentInOrder(restated, [
      'Find the release date.',
      [
        state(1, 1),
        announcement('tools', SEARCH_V2, 1),
        announcement('docs', 'Docs are indexed.', 1),
        ANCHOR,
      ].join('\n\n'),
      'It is 2026-09-28.',
      'And the price?',
      // Step 2 is news again, `tools` is withdrawn again; `docs` still holds.
      [state(2, 2), withdrawnAnnouncement('tools', 2), ANCHOR].join('\n\n'),
    ]);
    const [next] = await converse(
      chef,
      [[...edited, reply('About $40.', 'SIG_3'), user('Thanks.')]],
      target,
    );
    expectAppendOnly([restated, next]);
  });

  it('restates on Chat Completions exactly what the window lost', async () => {
    const { chef } = chefWith();
    await converse(chef, [turn1, turn2, turn3], 'openai', (c, turn) => {
      if (turn === 1) {
        c.setDynamicState(State, { step: 1 });
        c.announce('tools', SEARCH_V2, { channel: 'user_tail' });
      }
      if (turn === 2) c.setDynamicState(State, { step: 2 });
    });

    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [restated] = await converse(chef, [edited]);

    expect(contents(restated)).toEqual([
      'You are terse.',
      'Find the release date.',
      [state(1, 1), announcement('tools', SEARCH_V2, 1), ANCHOR].join('\n\n'),
      '',
      '2026-09-29',
      'It is 2026-09-28.',
      'And the price?',
      [state(2, 2), ANCHOR].join('\n\n'),
    ]);
  });

  it.each(THREE)('states everything again after clearHistory() (%s)', async (target) => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    await converse(chef, [turn1, turn3], target);

    chef.clearHistory();
    const [payload] = await converse(chef, [[user('New topic.')]], target);

    expectSentInOrder(payload, ['New topic.', `${state(1, 1)}\n\n${ANCHOR}`]);
    expect(occurrences(payload, 'Find the release date.')).toBe(0);
  });
});

describe('appendOnly: a system event follows a user turn, or is said as a user message', () => {
  const noHoist = (warn: ReturnType<typeof vi.fn>) =>
    warn.mock.calls.filter(([message]) => String(message).includes('positional system message'));

  it('says an announcement in an empty window as a user message, then as a system one after the first turn', async () => {
    const warn = vi.fn();
    const { chef, breaks } = chefWith({ logger: { warn } });
    chef.announce('tools', SEARCH_V2);
    const event = `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`;

    const [empty, first, second] = (await converse(
      chef,
      [[], turn1, [...turn1, reply('It is 2026-09-28.', 'SIG_1'), user('And the price?')]],
      'anthropic',
    )) as AnthropicPayload[];

    // Nothing was hoisted into the top-level system prompt, so nothing changed there.
    expect(breaks).toEqual([]);
    expect(noHoist(warn)).toEqual([]);
    for (const payload of [empty, first, second]) {
      expect(payload.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
    }
    expect(empty.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: event }] }]);
    // Unanswered, the event moved past the first turn (Ruling E); answered, it stays.
    expect(first.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find the release date.' }] },
      { role: 'system', content: [{ type: 'text', text: event }] },
    ]);
    expectAppendOnly([first, second]);
  });

  it('says an event before an assistant greeting as a user message for the rest of the window', async () => {
    const warn = vi.fn();
    const { chef, breaks } = chefWith({ logger: { warn } });
    chef.announce('tools', SEARCH_V2);
    const greeting: Message = { role: 'assistant', content: 'Hi! What should I look up?' };
    const event = `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}`;

    const payloads = (await converse(
      chef,
      [
        [greeting],
        [greeting, ...turn1],
        [greeting, ...turn1, reply('It is 2026-09-28.', 'SIG_1'), user('And the price?')],
      ],
      'anthropic',
    )) as AnthropicPayload[];

    expect(breaks.filter((b) => b.reason === 'system')).toEqual([]);
    expect(noHoist(warn)).toEqual([]);
    expectAppendOnly(payloads);
    for (const payload of payloads) {
      expect(payload.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
      expect(payload.messages.slice(0, 2)).toEqual([
        { role: 'user', content: [{ type: 'text', text: event }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi! What should I look up?' }] },
      ]);
    }
  });

  it('says a system event appended right after a reply as a user message', async () => {
    const { chef } = chefWith();
    const answered = [...turn1, reply('It is 2026-09-28.', 'SIG_1')];

    const [, metered] = (await converse(chef, [turn1, answered], 'anthropic', (c, turn) => {
      if (turn === 2) c.announce('tools', SEARCH_V2);
    })) as AnthropicPayload[];

    expect(metered.system).toEqual([{ type: 'text', text: 'You are terse.' }]);
    expect(metered.messages.slice(-1)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: `${announcement('tools', SEARCH_V2, 1)}\n\n${ANCHOR}` }],
      },
    ]);
  });
});
