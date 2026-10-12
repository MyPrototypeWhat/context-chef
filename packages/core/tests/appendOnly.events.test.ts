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
  Prompts,
} from '../src/index';
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

/** How often `text` occurs anywhere in what is sent. */
const occurrences = (payload: TargetPayload, text: string): number =>
  JSON.stringify(wire(payload)).split(JSON.stringify(text).slice(1, -1)).length - 1;

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
  it('appends a changed state with the next revision, and leaves the old one where it was', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', (c, turn) =>
      c.setDynamicState(State, { step: turn === 1 ? 1 : 2 }),
    );

    expectAppendOnly(payloads);
    // Changed in the tool loop: the new block follows the tool result it was set after.
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

  it('appends nothing more while the state stays the same', async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4, turn5], 'anthropic');

    expectAppendOnly(payloads);
    const last = payloads[payloads.length - 1];
    expect(occurrences(last, '<dynamic_state rev="1">')).toBe(1);
    expect(occurrences(last, '<dynamic_state rev="2"')).toBe(0);
    expect(occurrences(last, ANCHOR)).toBe(1);
  });

  it('appends a tombstone for a retracted announcement and leaves the statement in place', async () => {
    const { chef } = chefWith();

    const payloads = await converse(chef, [turn1, turn2, turn3], 'openai', (c, turn) => {
      if (turn === 1) c.announce('tools', SEARCH_V2, { channel: 'user_tail' });
      if (turn === 2) c.retractAnnouncement('tools');
    });

    expectAppendOnly(payloads);
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

  it('withdraws a cleared state and implicit context that stopped coming', async () => {
    const { chef } = chefWith();
    let retrieved = 'docs: v2';
    chef.use('before-assemble', (ctx) => ctx.inject(retrieved));

    const payloads = await converse(chef, [turn1, turn3], 'openai', (c, turn) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 2) {
        c.setDynamicState(z.null(), null);
        retrieved = '';
      }
    });

    expectAppendOnly(payloads);
    expect(contents(payloads[1]).slice(-1)).toEqual([
      `<dynamic_state rev="2" withdrawn="true">${Prompts.DYNAMIC_STATE_WITHDRAWN}</dynamic_state>` +
        `\n\n<implicit_context rev="2" withdrawn="true">${Prompts.IMPLICIT_CONTEXT_WITHDRAWN}</implicit_context>` +
        `\n\n${ANCHOR}`,
    ]);
  });

  it('withdraws a last_user guardrail that was cleared, and restates a changed one', async () => {
    const { chef } = chefWith();
    const guardrail = (outputTag: string) => ({
      enforceXML: { outputTag },
      placement: 'last_user' as const,
    });

    const payloads = await converse(chef, [turn1, turn2, turn3, turn4], 'openai', (c, turn) => {
      if (turn === 1) c.withGuardrails(guardrail('out'));
      if (turn === 3) c.withGuardrails(guardrail('answer'));
      if (turn === 4) c.withGuardrails(null);
    });

    expectAppendOnly(payloads);
    // An instruction, not system state: no anchor line of its own.
    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      'Find the release date.',
      Prompts.getXMLGuardrail('out'),
      '',
      '2026-09-28',
      'It is 2026-09-28.',
      'And the price?',
      Prompts.getXMLGuardrail('answer'),
      'About $40.',
      'Thanks.',
      Prompts.GUARDRAIL_WITHDRAWN,
    ]);
  });

  it("leaves a last_user guardrail event alone once the instructions move to 'system'", async () => {
    const { chef, breaks } = chefWith();

    const [, moved] = await converse(chef, [turn1, turn3], 'openai', (c, turn) =>
      c.withGuardrails({
        enforceXML: { outputTag: 'out' },
        placement: turn === 1 ? 'last_user' : 'system',
      }),
    );

    // The same instructions, static now: a `system` checkpoint, and nothing withdrawn.
    expect(breaks.map((b) => b.reason)).toEqual(['system']);
    expect(contents(moved)).toEqual([
      'You are terse.',
      Prompts.getXMLGuardrail('out'),
      'Find the release date.',
      Prompts.getXMLGuardrail('out'),
      '',
      '2026-09-28',
      'It is 2026-09-28.',
      'And the price?',
    ]);
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
        Prompts.getXMLGuardrail('out'),
      ].join('\n\n'),
    ]);
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

  it('replays the same bytes on a retry, and adds a change to the unanswered tail', async () => {
    const { chef, breaks } = chefWith();

    const [, , first, retried] = await converse(
      chef,
      [turn1, turn2, turn3, turn3],
      'openai',
      (c, turn) => {
        if (turn === 3) c.setDynamicState(State, { step: 1 });
      },
    );
    chef.setDynamicState(State, { step: 2 });
    const [changed] = await converse(chef, [turn3]);
    const [next] = await converse(chef, [turn4]);

    expect(breaks).toEqual([]);
    expect(wire(retried)).toEqual(wire(first));
    expect(contents(changed).slice(-1)).toEqual([
      `${state(1, 1)}\n\n${ANCHOR}\n\n${state(2, 2)}\n\n${ANCHOR}`,
    ]);
    expectAppendOnly([changed, next]);
  });

  it('warns, and drops nothing, when an after-assemble handler moved the events it adds to', async () => {
    const warn = vi.fn();
    const { chef } = chefWith({ logger: { warn } });
    chef.use('after-assemble', (messages) =>
      messages.filter((m) => !m.content.startsWith('<dynamic_state')),
    );
    chef.setDynamicState(State, { step: 1 });
    await converse(chef, [turn1]);

    chef.setDynamicState(State, { step: 2 });
    const [payload] = await converse(chef, [turn1]);

    const moved = warn.mock.calls.filter(([message]) =>
      String(message).includes('appendOnly: the events at the end of the window'),
    );
    expect(moved).toHaveLength(1);
    expect(contents(payload)).toEqual([
      'You are terse.',
      'Find the release date.',
      `${state(1, 1)}\n\n${ANCHOR}\n\n${state(2, 2)}\n\n${ANCHOR}`,
    ]);
  });

  it('appends the handoff notice once in its window, and keeps it in place', async () => {
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

    const payloads = await converse(chef, turns);

    expectAppendOnly(payloads);
    const notice = `<announcement id="__handoff__">\nHANDOFF, 50 tokens left\n</announcement>\n\n${ANCHOR}`;
    expect(contents(payloads[2]).slice(-1)).toEqual([notice]);
    expect(contents(payloads[3]).slice(1)).toEqual([
      'q1',
      'a1',
      'q2',
      'a2',
      'q3',
      notice,
      'a3',
      'q4',
    ]);
  });
});

describe('appendOnly: after a checkpoint, the current state is stated again', () => {
  it('appends what changed and withdraws what went quiet since the last word the window kept', async () => {
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
    await converse(chef, [turn1, turn2, turn3], 'openai', setup);

    // The host rewrote the tool result: what turn 2 appended after it is gone.
    const edited = [...turn3];
    edited[2] = result('t1', '2026-09-29');
    const [restated] = await converse(chef, [edited]);

    expect(breaks.map((b) => [b.reason, b.at])).toEqual([['history', 3]]);
    expect(contents(restated)).toEqual([
      'You are terse.',
      'Find the release date.',
      [
        state(1, 1),
        announcement('tools', SEARCH_V2, 1),
        announcement('docs', 'Docs are indexed.', 1),
        ANCHOR,
      ].join('\n\n'),
      '',
      '2026-09-29',
      'It is 2026-09-28.',
      'And the price?',
      // Step 2 is news again, `tools` is withdrawn again; `docs` still holds.
      [state(2, 2), withdrawnAnnouncement('tools', 2), ANCHOR].join('\n\n'),
    ]);
    const [next] = await converse(chef, [
      [...edited, reply('About $40.', 'SIG_3'), user('Thanks.')],
    ]);
    expectAppendOnly([restated, next]);
  });

  it('states everything again after clearHistory()', async () => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    await converse(chef, [turn1, turn3]);

    chef.clearHistory();
    const [payload] = await converse(chef, [[user('New topic.')]]);

    expect(contents(payload)).toEqual([
      'You are terse.',
      'New topic.',
      `${state(1, 1)}\n\n${ANCHOR}`,
    ]);
  });
});
