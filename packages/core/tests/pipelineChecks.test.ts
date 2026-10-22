import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type ChefConfig, type ChefEvents, ContextChef } from '../src/index';
import { checkTailInvariants, tailInsertionIndex } from '../src/pipeline/checks';
import type { AnthropicPayload, Message } from '../src/types';

type Invariant = ChefEvents['pipeline:invariant'];

const invariantWarnings = (warn: ReturnType<typeof vi.fn>): string[] =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('pipeline invariant'));

const toolTurn = (): Message[] => [
  { role: 'user', content: 'read the file' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
  { role: 'user', content: 'now explain' },
];

describe('pipelineChecks', () => {
  it('reports a pinned message dropped by an after-assemble handler', async () => {
    const warn = vi.fn();
    const events: Invariant[] = [];
    const chef = new ContextChef({ pipelineChecks: true, logger: { warn } });

    chef
      .setHistory([
        { role: 'user', content: 'never violate the safety rules', pinned: true },
        { role: 'user', content: 'go' },
      ])
      .on('pipeline:invariant', (event) => {
        events.push(event);
      })
      .use('after-assemble', (messages) => messages.filter((m) => !m.pinned));

    await chef.compile({ target: 'openai' });

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('assemble');
    expect(events[0].message).toContain('pinned');
    expect(invariantWarnings(warn)).toHaveLength(1);
  });

  it('reports a tool_call/tool_result pair split by an after-assemble handler', async () => {
    const warn = vi.fn();
    const events: Invariant[] = [];
    const chef = new ContextChef({ pipelineChecks: true, logger: { warn } });

    chef
      .setHistory(toolTurn())
      .on('pipeline:invariant', (event) => {
        events.push(event);
      })
      .use('after-assemble', (messages) => messages.filter((m) => m.role !== 'tool'));

    await chef.compile({ target: 'openai' });

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('call_1');
    expect(invariantWarnings(warn)).toHaveLength(1);
  });

  it('stays quiet for a well-behaved handler', async () => {
    const warn = vi.fn();
    const events: Invariant[] = [];
    const chef = new ContextChef({ pipelineChecks: true, logger: { warn } });

    chef
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'standing rule', pinned: true }, ...toolTurn()])
      .setDynamicState(z.object({ file: z.string() }), { file: 'a.ts' })
      .announce('tools:added', 'Tools newly available: grep')
      .on('pipeline:invariant', (event) => {
        events.push(event);
      })
      // Clones every message: identity changes, content does not.
      .use('after-assemble', (messages) => messages.map((m) => ({ ...m })));

    await chef.compile({ target: 'anthropic' });

    expect(events).toEqual([]);
    expect(invariantWarnings(warn)).toEqual([]);
  });

  it('never runs the checks when pipelineChecks is off (the default)', async () => {
    const warn = vi.fn();
    const events: Invariant[] = [];
    const chef = new ContextChef({ logger: { warn } });

    chef
      .setHistory([
        { role: 'user', content: 'pinned rule', pinned: true },
        { role: 'user', content: 'go' },
      ])
      .on('pipeline:invariant', (event) => {
        events.push(event);
      })
      .use('after-assemble', (messages) => messages.filter((m) => !m.pinned));

    const payload = await chef.compile({ target: 'openai' });

    expect(events).toEqual([]);
    expect(invariantWarnings(warn)).toEqual([]);
    // The violation still happened — checks report, they never enforce.
    expect(payload.messages).toHaveLength(1);
  });

  it('never throws: a violating compile still returns its payload', async () => {
    const chef = new ContextChef({ pipelineChecks: true, logger: { warn: vi.fn() } });
    chef
      .setHistory([{ role: 'user', content: 'pinned', pinned: true }])
      .use('after-assemble', () => []);

    await expect(chef.compile({ target: 'openai' })).resolves.toBeDefined();
  });
});

describe('pipelineChecks — appendOnly across turns', () => {
  const State = z.object({ step: z.number() });
  const user = (content: string): Message => ({ role: 'user', content });
  const reply = (content: string, signature: string): Message => ({
    role: 'assistant',
    content,
    thinking: { thinking: `Reasoning signed ${signature}.`, signature },
  });
  const turn1: Message[] = [user('q1')];
  const turn2: Message[] = [...turn1, reply('a1', 'SIG_1'), user('q2')];
  const turn3: Message[] = [...turn2, reply('a2', 'SIG_2'), user('q3')];

  function chefWith(config: ChefConfig = {}) {
    const warn = vi.fn();
    const chef = new ContextChef({
      appendOnly: true,
      pipelineChecks: true,
      logger: { warn },
      ...config,
    }).setSystemPrompt([{ role: 'system', content: 'sys' }]);
    const events: Invariant[] = [];
    chef.on('pipeline:invariant', (event) => {
      events.push(event);
    });
    return { chef, events, warn };
  }

  /** From the `from`th compile on, the first user message reaches the payload rewritten. */
  const rewritesFirstQuestion = (chef: ContextChef, from: number) => {
    let compiles = 0;
    chef.use('after-assemble', (messages) => {
      compiles++;
      return messages.map((m) =>
        compiles >= from && m.content === 'q1' ? { ...m, content: 'q1, rewritten' } : m,
      );
    });
  };

  it.each([
    'anthropic',
    'openai',
    'gemini',
  ])('reports an answered message a handler rewrote with no checkpoint (%s)', async (target) => {
    const { chef, events, warn } = chefWith();
    rewritesFirstQuestion(chef, 2);

    await chef.setHistory(turn1).compile({ target });
    const second = await chef.setHistory(turn2).compile({ target });

    expect(second.meta?.prefix?.break).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('audit');
    expect(events[0].message).toContain('no checkpoint');
    expect(invariantWarnings(warn)).toHaveLength(1);
  });

  it('names the first place the payload stopped repeating the one sent before it', async () => {
    const { chef, events } = chefWith();
    rewritesFirstQuestion(chef, 2);

    await chef.setHistory(turn1).compile({ target: 'openai' });
    await chef.setHistory(turn2).compile({ target: 'openai' });

    // [sys, q1]: the question is the second message.
    expect(events.map((e) => e.message)).toEqual([expect.stringContaining('messages[1]')]);
  });

  it('reports a thinking signature sent before and missing now', async () => {
    const { chef, events } = chefWith();
    let compiles = 0;
    // From the third compile on, the first reply goes out without its thinking.
    chef.use('after-assemble', (messages) =>
      ++compiles >= 3
        ? messages.map((m) =>
            m.thinking?.signature === 'SIG_1' ? { ...m, thinking: undefined } : m,
          )
        : messages,
    );

    await chef.setHistory(turn1).compile({ target: 'anthropic' });
    await chef.setHistory(turn2).compile({ target: 'anthropic' });
    await chef.setHistory(turn3).compile({ target: 'anthropic' });

    expect(events.map((e) => e.message)).toEqual([
      expect.stringContaining('messages[1]'),
      expect.stringContaining('SIG_1'),
    ]);
  });

  it('stays quiet across turns that only append, events and all', async () => {
    const { chef, events, warn } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    chef.announce('tools', 'Tool search_v2 is available.', { channel: 'system' });

    for (const [i, history] of [turn1, turn2, turn3].entries()) {
      chef.setDynamicState(State, { step: i + 1 });
      await chef.setHistory(history).compile({ target: 'anthropic' });
    }

    expect(events).toEqual([]);
    expect(invariantWarnings(warn)).toEqual([]);
  });

  it('stays quiet for a divergence it reported as a checkpoint', async () => {
    const { chef, events } = chefWith();
    const edited = turn2.map((m) => (m.content === 'q1' ? user('q1, edited') : m));

    await chef.setHistory(turn1).compile({ target: 'anthropic' });
    const second = await chef.setHistory(edited).compile({ target: 'anthropic' });

    expect(second.meta?.prefix?.break?.reason).toBe('history');
    expect(events).toEqual([]);
  });

  it('lets the unanswered tail change on a retry at the same length', async () => {
    const { chef, events } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    await chef.setHistory(turn2).compile({ target: 'gemini' });

    // Nothing answered the request yet: its events are said again as one group.
    chef.setDynamicState(State, { step: 2 });
    const retry = await chef.setHistory(turn2).compile({ target: 'gemini' });

    expect(retry.meta?.prefix?.break).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('lets the unanswered tail move behind a user turn the host appended to it', async () => {
    const { chef, events } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    await chef.setHistory(turn2).compile({ target: 'openai' });

    const appended = await chef
      .setHistory([...turn2, user('q2, continued')])
      .compile({ target: 'openai' });

    expect(appended.meta?.prefix?.break).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('holds the unanswered tail to what was sent once a reply answered it', async () => {
    const { chef, events } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    let compiles = 0;
    // The second compile sends the request's events without the state's anchor line.
    chef.use('after-assemble', (messages) =>
      ++compiles === 2
        ? messages.map((m) => (m._chef_event ? { ...m, content: m.content.split('\n\n')[0] } : m))
        : messages,
    );

    await chef.setHistory(turn1).compile({ target: 'openai' });
    await chef.setHistory(turn1).compile({ target: 'openai' });
    await chef.setHistory(turn2).compile({ target: 'openai' });

    // The retry may change the tail; the reply to it was signed over what the retry sent.
    expect(events.map((e) => e.message)).toEqual([expect.stringContaining('messages[2]')]);
  });

  it('leaves out the prefill a request ended with: the reply took its place', async () => {
    const { chef, events } = chefWith();
    chef.withGuardrails({ prefill: '<out>' });

    const first = (await chef
      .setHistory(turn1)
      .compile({ target: 'anthropic' })) as AnthropicPayload;
    await chef.setHistory(turn2).compile({ target: 'anthropic' });

    expect(first.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '<out>' }],
    });
    expect(events).toEqual([]);
  });

  it('compares with the last payload committed, never one whose compile failed after the check', async () => {
    let failed = false;
    const { chef, events } = chefWith({
      logger: {
        // The first violation's warning throws: that compile fails, and commits nothing.
        warn: (message) => {
          if (failed || !String(message).includes('pipeline invariant')) return;
          failed = true;
          throw new Error('logger down');
        },
      },
    });
    let compiles = 0;
    chef.use('after-assemble', (messages) =>
      ++compiles === 2
        ? messages.map((m) => (m.content === 'q1' ? { ...m, content: 'q1, rewritten' } : m))
        : messages,
    );

    await chef.setHistory(turn1).compile({ target: 'openai' });
    await expect(chef.setHistory(turn2).compile({ target: 'openai' })).rejects.toThrow(
      'logger down',
    );
    await chef.setHistory(turn2).compile({ target: 'openai' });

    expect(events).toEqual([]);
  });

  it('never compares without appendOnly, where every turn rewrites the tail', async () => {
    const { chef, events } = chefWith({ appendOnly: false });
    rewritesFirstQuestion(chef, 2);
    chef.setDynamicState(State, { step: 1 });

    await chef.setHistory(turn1).compile({ target: 'anthropic' });
    await chef.setHistory(turn2).compile({ target: 'anthropic' });

    expect(events).toEqual([]);
  });

  it('never compares with pipelineChecks off', async () => {
    const { chef, events } = chefWith({ pipelineChecks: false });
    rewritesFirstQuestion(chef, 2);

    await chef.setHistory(turn1).compile({ target: 'anthropic' });
    await chef.setHistory(turn2).compile({ target: 'anthropic' });

    expect(events).toEqual([]);
  });
});

describe('pipelineChecks — tail invariant', () => {
  const sandwich: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];

  it('accepts the stitch merged into the tail user message', () => {
    const after = sandwich.map((m, i) =>
      i === 3 ? { ...m, content: 'q2\n\n<dynamic_state/>' } : { ...m },
    );
    expect(checkTailInvariants(sandwich, after, tailInsertionIndex(sandwich))).toEqual([]);
  });

  it('flags a rewrite ahead of the insertion point', () => {
    const after = sandwich.map((m, i) => (i === 1 ? { ...m, content: 'REWRITTEN' } : { ...m }));
    const violations = checkTailInvariants(sandwich, after, tailInsertionIndex(sandwich));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('message 1');
  });

  it('accepts a new user message inserted after a tool-result tail', () => {
    const withToolTail: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ];
    const after: Message[] = [...withToolTail, { role: 'user', content: '<dynamic_state/>' }];
    expect(checkTailInvariants(withToolTail, after, tailInsertionIndex(withToolTail))).toEqual([]);
  });

  it('puts the insertion point before a trailing assistant prefill', () => {
    const noConversationalTail: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'prefill' },
    ];
    expect(tailInsertionIndex(noConversationalTail)).toBe(1);
  });
});
