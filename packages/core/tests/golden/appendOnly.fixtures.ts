/**
 * `appendOnly` golden sequences — the byte-stability guard for the mode.
 *
 * Each sequence is an agent loop compiled request by request from its first
 * one, as a host runs it: a question, the model's tool call (with thinking),
 * the tool result, its answer (with thinking), the next question… Something
 * changes along the way — state, announcements, memory, a skill, the
 * guardrail, the system prompt, an overflow — and every compile's payload and
 * `meta.prefix` are snapshotted on each golden target.
 *
 * Everything that could drift between runs is pinned: `Date` is frozen by the
 * test file; compression models and on-demand compactors are stubs that
 * answer `SUMMARY 1`, `SUMMARY 2`, … and block 1, 2, … in turn; tokens are a
 * flat 10 per message. Nothing here renders a window id.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  background,
  type ChefConfig,
  ContextChef,
  chain,
  fromAnthropic,
  type OnDemandCompactor,
  type OverflowStrategy,
  onDemandCompaction,
  summarize,
} from '../../src/index';
import { InMemoryStore } from '../../src/modules/memory/inMemoryStore';
import type { ChefLogger, Message, ToolDefinition } from '../../src/types';

/** One compile of a sequence. */
export interface AppendOnlyStep {
  /** The host history it compiles. */
  history: Message[];
  /** What the host or the model changes first. */
  before?: (chef: ContextChef) => unknown;
  /** Let a background job finish before the next step. */
  settle?: true;
}

export interface AppendOnlySequence {
  name: string;
  /** A fresh chef per target: warn-once flags and strategy state are per instance. */
  build: () => ContextChef | Promise<ContextChef>;
  steps: AppendOnlyStep[];
}

const silent: ChefLogger = { warn: () => {} };
const SYSTEM_PROMPT: Message[] = [{ role: 'system', content: 'You are a careful agent.' }];

const user = (content: string): Message => ({ role: 'user', content });
const call = (turn: number, signature: string): Message => ({
  role: 'assistant',
  content: '',
  thinking: { thinking: `Look up ${turn}.`, signature },
  tool_calls: [
    {
      id: `call_${turn}`,
      type: 'function',
      function: { name: 'search', arguments: `{"q":"topic ${turn}"}` },
    },
  ],
});
const result = (turn: number): Message => ({
  role: 'tool',
  tool_call_id: `call_${turn}`,
  content: `found ${turn}`,
});
const reply = (turn: number, signature: string): Message => ({
  role: 'assistant',
  content: `answer ${turn}`,
  thinking: { thinking: `Answer ${turn} from what was found.`, signature },
});

/**
 * An agent loop of `turns` turns, each `[q, tool call, result, answer]`. One
 * array, so every step shares the host's objects; `pinned` marks questions.
 */
function agentLoop(turns: number, pinned: number[] = []): Message[] {
  const loop: Message[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const question = user(`question ${turn}`);
    if (pinned.includes(turn)) question.pinned = true;
    loop.push(question, call(turn, `SIG_CALL_${turn}`), result(turn), reply(turn, `SIG_${turn}`));
  }
  return loop;
}

/**
 * The requests an agent loop makes, in order: after each question, and after
 * each tool result — `2 * turns` compiles.
 */
const requests = (loop: Message[]): Message[][] =>
  Array.from({ length: loop.length / 2 }, (_, i) =>
    loop.slice(0, 4 * Math.floor(i / 2) + (i % 2 === 0 ? 1 : 3)),
  );

/** The steps of a loop's requests, `before` run ahead of the ones it names (0-based). */
function steps(
  loop: Message[],
  before: Record<number, (chef: ContextChef) => unknown> = {},
  settle = false,
): AppendOnlyStep[] {
  return requests(loop).map((history, i) => ({
    history,
    ...(before[i] ? { before: before[i] } : {}),
    ...(settle ? { settle: true as const } : {}),
  }));
}

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the knowledge base.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};
const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch a document by id.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

const State = z.object({ step: z.number(), file: z.string() });

/** 10 tokens a message: over the trigger past 6 messages, past the raw window past 10. */
const JANITOR = {
  contextWindow: 100,
  triggerRatio: 0.6,
  tokenizer: (messages: Message[]) => messages.length * 10,
} as const;
/** Over the trigger past 7 messages: the 9 of the third question, not the 7 of a tool step before. */
const TRIGGER_AT_QUESTION_3 = { janitor: { ...JANITOR, triggerRatio: 0.7 } };
/** The same trigger, but a raw window of 200: a background job is not overtaken by a collapse. */
const ROOMY = { janitor: { ...JANITOR, contextWindow: 200, triggerRatio: 0.3 } };

/** A compression model answering `SUMMARY 1`, `SUMMARY 2`, … */
function summaries() {
  let n = 0;
  return async () => `<summary>SUMMARY ${++n}</summary>`;
}

/** An on-demand compactor answering block 1, 2, …; the calls in `declines` (1-based) are no compaction. */
function compactor(declines: number[] = []): OnDemandCompactor {
  let calls = 0;
  let blocks = 0;
  return async () =>
    declines.includes(++calls)
      ? { stop_reason: 'end_turn', content: [] }
      : {
          stop_reason: 'compaction',
          content: [
            {
              type: 'compaction',
              content: `SUMMARY ${++blocks}`,
              signature: `SIG_BLOCK_${blocks}`,
            },
          ],
        };
}

const keepLastTurn = (compressionModel: () => Promise<string>) =>
  summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 });

/** A chef as every sequence starts it: appendOnly, the invariant checks on. */
function chef(config: ChefConfig = {}): ContextChef {
  return new ContextChef({
    logger: silent,
    appendOnly: true,
    pipelineChecks: true,
    ...config,
  }).setSystemPrompt(SYSTEM_PROMPT);
}

const overflowing = (strategy: OverflowStrategy, config: ChefConfig = {}): ContextChef =>
  chef({ janitor: JANITOR, overflow: { strategy }, ...config });

export const appendOnlySequences: AppendOnlySequence[] = [
  {
    // State on the user channel, with implicit context, changed then cleared.
    name: 'dynamic-state-user',
    build: () => {
      let retrieved = 'docs: v1';
      const built = chef().use('before-assemble', (ctx) => ctx.inject(retrieved));
      built.setDynamicState(State, { step: 1, file: 'a.ts' });
      // The retrieval changes once, then stops.
      built.on('compile:done', () => {
        retrieved = retrieved === 'docs: v1' ? 'docs: v2' : '';
      });
      return built;
    },
    steps: steps(agentLoop(3), {
      2: (c) => c.setDynamicState(State, { step: 2, file: 'b.ts' }),
      4: (c) => c.setDynamicState(z.null(), null),
    }),
  },
  {
    // State on the system channel: a positional system message, never the top-level prompt.
    name: 'dynamic-state-system',
    build: () => chef().setDynamicState(State, { step: 1, file: 'a.ts' }, { placement: 'system' }),
    steps: steps(agentLoop(3), {
      1: (c) => c.setDynamicState(State, { step: 2, file: 'b.ts' }, { placement: 'system' }),
      4: (c) => c.setDynamicState(z.null(), null, { placement: 'system' }),
    }),
  },
  {
    name: 'announcements',
    build: () => chef().announce('tools', 'Tool fetch is available.', { channel: 'system' }),
    steps: steps(agentLoop(3), {
      2: (c) => c.announce('docs', 'The docs index was rebuilt.', { channel: 'user_tail' }),
      3: (c) => c.retractAnnouncement('tools'),
      5: (c) => c.retractAnnouncement('docs'),
    }),
  },
  {
    // Turn-scoped reminders on Anthropic; the other targets ignore clearAt.
    name: 'announcements-clear-at',
    build: () =>
      chef({ appendOnly: { clearAt: true } }).announce('tools', 'Tool fetch is available.', {
        channel: 'system',
      }),
    steps: steps(agentLoop(3), {
      2: (c) => c.announce('docs', 'The docs index was rebuilt.', { channel: 'user_tail' }),
      3: (c) => c.retractAnnouncement('tools'),
      5: (c) => c.retractAnnouncement('docs'),
    }),
  },
  {
    // A snapshot first, then a delta for the host's write and the expiry, never the model's write.
    name: 'memory',
    build: async () => {
      const built = chef({ memory: { store: new InMemoryStore() } });
      await built.getMemory().set('language', 'TypeScript');
      // Swept by the fifth compile: each compile counts one turn.
      await built.getMemory().set('session', 'abc123', { ttl: 4 });
      return built;
    },
    steps: steps(agentLoop(3), {
      2: async (c) => {
        await c.getMemory().set('editor', 'Neovim');
      },
      3: async (c) => {
        await c.handleTool({
          name: 'create_memory',
          arguments: JSON.stringify({ key: 'style', value: 'terse' }),
        });
      },
    }),
  },
  {
    name: 'skill-switch',
    build: () =>
      chef().activateSkill({
        name: 'research',
        description: 'Research mode',
        instructions: 'Cite every source you use.',
      }),
    steps: steps(agentLoop(3), {
      2: (c) =>
        c.activateSkill({
          name: 'writing',
          description: 'Writing mode',
          instructions: 'Write short paragraphs.',
        }),
      4: (c) => c.activateSkill(null),
    }),
  },
  {
    // An output format on the user channel, restated, then moved into the system prompt.
    name: 'guardrail',
    build: () =>
      chef().withGuardrails({ enforceXML: { outputTag: 'answer' }, placement: 'last_user' }),
    steps: steps(agentLoop(3), {
      2: (c) => c.withGuardrails({ enforceXML: { outputTag: 'report' }, placement: 'last_user' }),
      4: (c) => c.withGuardrails({ enforceXML: { outputTag: 'report' }, placement: 'system' }),
    }),
  },
  {
    name: 'system-and-tools-checkpoints',
    build: () => chef().registerTools([search]),
    steps: steps(agentLoop(3), {
      2: (c) =>
        c.setSystemPrompt([{ role: 'system', content: 'You are a careful agent. Be brief.' }]),
      4: (c) => c.registerTools([search, fetchTool]),
    }),
  },
  {
    // Over the trigger in a tool turn: the summary waits for the next question, then lands.
    name: 'summarize-at-boundary',
    build: () =>
      overflowing(keepLastTurn(summaries())).setDynamicState(State, { step: 1, file: 'a.ts' }),
    steps: steps(agentLoop(3)),
  },
  {
    // A tool turn that outgrows the raw window cannot wait: the whole window becomes one summary.
    name: 'collapse-mid-tool-turn',
    build: () => overflowing(keepLastTurn(summaries())),
    steps: (() => {
      const loop = agentLoop(1);
      const turn = [...loop.slice(0, 3)];
      for (let k = 2; k <= 5; k++) turn.push(call(k, `SIG_CALL_${k}`), result(k));
      // question 1, then five tool calls with their results: 11 messages at the last one.
      return [1, 3, 5, 7, 9, 11].map((n) => ({ history: turn.slice(0, n) }));
    })(),
  },
  {
    // The job starts when the window is over the trigger at a question; it lands at the next
    // question, with the turn that arrived meanwhile.
    name: 'background-landing',
    build: () => overflowing(background(keepLastTurn(summaries())), ROOMY),
    steps: steps(agentLoop(4), {}, true),
  },
  {
    // The model asks for a new window at a question, then again in a tool turn.
    name: 'new-context',
    build: () => overflowing(keepLastTurn(summaries())),
    steps: steps(agentLoop(3), {
      2: (c) => c.handleTool({ name: 'new_context', arguments: '{}' }),
      5: (c) => c.handleTool({ name: 'new_context', arguments: '{}' }),
    }),
  },
  {
    // Signed on Anthropic; on OpenAI and Gemini the fallback summarizes. Both at the question.
    name: 'signed-at-boundary',
    build: () =>
      overflowing(
        onDemandCompaction({ compact: compactor(), fallback: keepLastTurn(summaries()) }),
        TRIGGER_AT_QUESTION_3,
      ),
    steps: steps(agentLoop(3)),
  },
  {
    // Over the trigger at a tool result: signed, it lands there, and the turn keeps its thinking;
    // and again over the block. The fallback waits for the question.
    name: 'signed-mid-tool-turn',
    build: () =>
      overflowing(
        onDemandCompaction({ compact: compactor(), fallback: keepLastTurn(summaries()) }),
      ),
    steps: steps(agentLoop(3)),
  },
  {
    // Question 2 is pinned: said again after a signed landing, and again after the next one.
    name: 'signed-recompaction-pinned',
    build: () =>
      overflowing(
        onDemandCompaction({ compact: compactor(), fallback: keepLastTurn(summaries()) }),
        TRIGGER_AT_QUESTION_3,
      ),
    steps: steps(agentLoop(4, [2])),
  },
  {
    // The job asks for the request its window answered; the turns after it arrive meanwhile.
    name: 'background-signed',
    build: () =>
      overflowing(
        background(
          onDemandCompaction({ compact: compactor(), fallback: keepLastTurn(summaries()) }),
        ),
        ROOMY,
      ),
    steps: steps(agentLoop(4), {}, true),
  },
  {
    // The second on-demand attempt is no compaction: the summary goes after the block.
    name: 'signed-then-unsigned',
    build: () =>
      overflowing(
        chain(onDemandCompaction({ compact: compactor([2]) }), keepLastTurn(summaries())),
      ),
    steps: steps(agentLoop(5)),
  },
  {
    // A history resumed from Anthropic opens with the block that session got back.
    name: 'resumed-from-anthropic',
    build: () => overflowing(keepLastTurn(summaries())),
    steps: (() => {
      const { history: resumed } = fromAnthropic([
        {
          role: 'assistant',
          content: [{ type: 'compaction', content: 'SUMMARY 0', signature: 'SIG_BLOCK_0' }],
        },
      ] as unknown as MessageParam[]);
      return requests(agentLoop(3)).map((history) => ({ history: [...resumed, ...history] }));
    })(),
  },
];
