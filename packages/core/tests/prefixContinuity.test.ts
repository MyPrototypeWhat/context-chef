/**
 * `checkPrefixContinuity`: whether the payload sent on turn N is still the
 * prefix of the payload for turn N+1. Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5
 * / Haiku 5.5 sign every thinking block over everything before it, so a turn
 * that rewrites an earlier one fails that check when its thinking is replayed.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AnnouncementChannel,
  type ChefConfig,
  ContextChef,
  checkPrefixContinuity,
  type PrefixContinuity,
} from '../src/index';
import type { AnthropicPayload, Message } from '../src/types';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

describe('checkPrefixContinuity', () => {
  it('accepts a payload that only appends', () => {
    const prev = { system: [{ type: 'text', text: 'sys' }], messages: [user('q1')] };
    const next = { ...prev, messages: [user('q1'), assistant('a1'), user('q2')] };

    expect(checkPrefixContinuity(prev, next)).toEqual({ ok: true });
  });

  it('points at the first earlier message that changed', () => {
    const prev = { messages: [user('q1'), assistant('a1'), user('q2')] };
    const next = { messages: [user('q1'), assistant('a1 (edited)'), user('q2'), assistant('a2')] };

    const result = checkPrefixContinuity(prev, next);

    expect(result.ok).toBe(false);
    expect(result.firstDivergence?.path).toBe('messages[1]');
    expect(result.firstDivergence?.before).toEqual(assistant('a1'));
    expect(result.firstDivergence?.after).toEqual(assistant('a1 (edited)'));
  });

  it('reports a dropped message', () => {
    const result = checkPrefixContinuity(
      { messages: [user('q1'), assistant('a1')] },
      { messages: [user('q1')] },
    );

    expect(result.firstDivergence).toEqual({
      path: 'messages[1]',
      before: assistant('a1'),
      after: undefined,
    });
  });

  it('reports a changed system prompt before any message', () => {
    const result = checkPrefixContinuity(
      { system: [{ type: 'text', text: 'v1' }], messages: [user('q1')] },
      { system: [{ type: 'text', text: 'v2' }], messages: [user('q1'), assistant('a1')] },
    );

    expect(result.firstDivergence?.path).toBe('system');
  });

  it('reports a changed tool list', () => {
    const tool = { name: 'search', description: 'Search the web' };
    const result = checkPrefixContinuity(
      { tools: [tool], messages: [user('q1')] },
      { tools: [tool, { name: 'fetch', description: 'Fetch a URL' }], messages: [user('q1')] },
    );

    expect(result.firstDivergence?.path).toBe('tools');
  });

  it('ignores cache breakpoints and key order', () => {
    const prev = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'q1', cache_control: { type: 'ephemeral' } }],
        },
      ],
    };
    const next = {
      messages: [{ content: [{ text: 'q1', type: 'text' }], role: 'user' }, assistant('a1')],
    };

    expect(checkPrefixContinuity(prev, next).ok).toBe(true);
  });

  it('reads the OpenAI Responses shape (instructions + input)', () => {
    const prev = { instructions: 'sys', input: [user('q1')] };

    expect(
      checkPrefixContinuity(prev, { instructions: 'sys', input: [user('q1'), assistant('a1')] }).ok,
    ).toBe(true);
    expect(
      checkPrefixContinuity(prev, { instructions: 'sys v2', input: [user('q1')] }).firstDivergence
        ?.path,
    ).toBe('instructions');
  });
});

const turnN = (): Message[] => [
  { role: 'user', content: 'Find the release date.' },
  {
    role: 'assistant',
    content: '',
    thinking: { thinking: '', signature: 'SIG_1' },
    tool_calls: [
      { id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    ],
  },
  { role: 'tool', content: 'result text', tool_call_id: 'toolu_1' },
];
const nextTurn = (): Message[] => [
  ...turnN(),
  {
    role: 'assistant',
    content: 'It is 2026-09-28.',
    thinking: { thinking: '', signature: 'SIG_2' },
  },
  { role: 'user', content: 'Thanks. And the price?' },
];

/** Turn N, then turn N+1, on Anthropic; `setup` runs before each. */
async function twoTurns(
  setup: (chef: ContextChef, turn: 1 | 2) => void,
  config: ChefConfig = {},
): Promise<{ result: PrefixContinuity; second: AnthropicPayload }> {
  const chef = new ContextChef({ logger: { warn: () => {} }, ...config }).setSystemPrompt([
    { role: 'system', content: 'sys' },
  ]);
  chef.setHistory(turnN());
  setup(chef, 1);
  const first = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
  chef.setHistory(nextTurn());
  setup(chef, 2);
  const second = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;
  return { result: checkPrefixContinuity(first, second), second };
}

const State = z.object({ step: z.number() });

/** The injections the default mode re-renders at the tail every turn. */
const tailInjections: Array<[string, (chef: ContextChef, turn: 1 | 2) => void]> = [
  ['dynamic state at the tail', (chef) => chef.setDynamicState(State, { step: 1 })],
  [
    "guardrail placement 'last_user'",
    (chef) => chef.withGuardrails({ enforceXML: { outputTag: 'out' }, placement: 'last_user' }),
  ],
  ...(['system', 'user_tail'] satisfies AnnouncementChannel[]).map(
    (channel): [string, (chef: ContextChef, turn: 1 | 2) => void] => [
      `an announcement on the '${channel}' channel`,
      (chef, turn) => {
        if (turn === 1) chef.announce('tools', 'Tool search_v2 is available.', { channel });
      },
    ],
  ),
];

// Today's default ("rewrite") behavior: every tail injection is re-rendered at
// the new tail on each compile, so the turn it sat in last time changes. These
// pin that down so nobody mistakes it for fixed; the append-only mode is what
// changes them.
describe('turn N vs turn N+1 under the default injection model', () => {
  it('keeps the prefix with no injections', async () => {
    expect((await twoTurns(() => {})).result.ok).toBe(true);
  });

  it('keeps the prefix with a guardrail in the static system prompt', async () => {
    const { result } = await twoTurns((chef) =>
      chef.withGuardrails({ enforceXML: { outputTag: 'out' } }),
    );
    expect(result.ok).toBe(true);
  });

  it.each(tailInjections)('breaks the prefix with %s', async (_, setup) => {
    const { result } = await twoTurns(setup);
    expect(result.firstDivergence?.path).toBe('messages[3]');
  });
});

// The same cases with `appendOnly`: what changed is appended once where it
// became true, and only a rewrite of what was sent is a break — reported.
describe('turn N vs turn N+1 with appendOnly', () => {
  const appendOnly: ChefConfig = { appendOnly: true };

  it('keeps the prefix with no injections', async () => {
    const { result, second } = await twoTurns(() => {}, appendOnly);
    expect(result).toEqual({ ok: true });
    expect(second.meta?.prefix?.break).toBeUndefined();
  });

  it('keeps the prefix with a guardrail in the static system prompt', async () => {
    const { result, second } = await twoTurns(
      (chef) => chef.withGuardrails({ enforceXML: { outputTag: 'out' } }),
      appendOnly,
    );
    expect(result).toEqual({ ok: true });
    expect(second.meta?.prefix?.break).toBeUndefined();
  });

  it.each(tailInjections)('keeps the prefix with %s', async (_, setup) => {
    const { result, second } = await twoTurns(setup, appendOnly);
    expect(result).toEqual({ ok: true });
    expect(second.meta?.prefix?.break).toBeUndefined();
  });

  it('reports a guardrail changed in the system prompt as a checkpoint', async () => {
    const { result, second } = await twoTurns(
      (chef, turn) =>
        chef.withGuardrails({ enforceXML: { outputTag: turn === 1 ? 'out' : 'answer' } }),
      appendOnly,
    );
    expect(result.firstDivergence?.path).toBe('system');
    expect(second.meta?.prefix?.break).toEqual({
      reason: 'system',
      at: 0,
      signed: false,
      strippedThinking: 1,
    });
  });
});
