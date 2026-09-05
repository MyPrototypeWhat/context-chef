import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type ChefEvents, ContextChef } from '../src/index';
import { checkTailInvariants, tailInsertionIndex } from '../src/pipeline/checks';
import type { Message } from '../src/types';

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
