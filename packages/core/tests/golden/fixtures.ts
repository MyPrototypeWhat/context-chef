/**
 * Golden payload fixtures — the byte-stability guard for the v5 refactor.
 *
 * Each fixture is a self-contained `ContextChef` configuration whose compiled
 * payload must stay byte-identical across every phase of the restructure.
 * Everything that could drift between runs is pinned:
 *
 * - `Date.now()` is frozen by the test file (fake timers), so memory metadata
 *   timestamps render as fixed ISO strings.
 * - Memory lives in an `InMemoryStore` seeded with fixed entries.
 * - Compression uses a deterministic stub model and an in-memory VFS adapter,
 *   so the archive URI (content-addressed) is stable too.
 *
 * A fixture builds a FRESH chef per compile target: several code paths
 * (warn-once flags, the transform cache) carry per-instance state that would
 * otherwise leak from one target's payload into the next.
 */

import { z } from 'zod';
import { ContextChef } from '../../src/index';
import { InMemoryStore } from '../../src/modules/memory/inMemoryStore';
import type { ChefLogger, Message } from '../../src/types';

/** Wall-clock instant every fixture is built at. */
export const GOLDEN_NOW = new Date('2026-03-01T12:00:00.000Z');

/** Targets every fixture is compiled against. */
export const GOLDEN_TARGETS = ['openai', 'anthropic', 'gemini'] as const;

export type GoldenTarget = (typeof GOLDEN_TARGETS)[number];

export interface GoldenFixture {
  name: string;
  build: () => Promise<ContextChef>;
}

/**
 * Golden fixtures are not warning tests — several of them deliberately hit
 * paths that warn (no tokenizer, server strategy on a non-Anthropic target).
 * Swallow those so the suite's output stays readable.
 */
const silent: ChefLogger = { warn: () => {} };

const SYSTEM_PROMPT: Message[] = [
  { role: 'system', content: 'You are a careful engineering assistant.' },
];

/** Plain three-turn conversation ending on a user message. */
const conversation = (): Message[] => [
  { role: 'user', content: 'How do I read a file in Node?' },
  { role: 'assistant', content: 'Use node:fs/promises readFile.' },
  { role: 'user', content: 'And write one?' },
];

/** Conversation ending mid-agent-loop, on a tool result awaiting interpretation. */
const toolLoop = (): Message[] => [
  { role: 'user', content: 'What is the weather in Oslo?' },
  {
    role: 'assistant',
    content: 'Checking.',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":"Oslo"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":-3,"sky":"clear"}' },
];

/** Deterministic memory store: fixed keys, fixed values, fixed insertion order. */
async function seedMemory(chef: ContextChef): Promise<void> {
  const memory = chef.getMemory();
  await memory.set('language', 'TypeScript', { description: 'Primary project language' });
  await memory.set('runtime', 'Node 22');
  await memory.set('editor', 'Neovim');
}

/** In-memory VFS adapter — keeps the archive path off the filesystem. */
function memoryVfsAdapter() {
  const files = new Map<string, string>();
  return {
    write: async (filename: string, content: string) => {
      files.set(filename, content);
    },
    read: async (filename: string) => files.get(filename) ?? null,
    exists: async (filename: string) => files.has(filename),
  };
}

/** Flat per-message token cost — the Janitor's budget math stays predictable. */
const flatTokenizer = (perMessage: number) => (messages: Message[]) => messages.length * perMessage;

/**
 * History long enough to trip the shrink guard's span floor, so compression
 * actually applies instead of being rejected as non-shrinking.
 */
const longHistory = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(200)}`,
  }));

export const goldenFixtures: GoldenFixture[] = [
  {
    name: 'default',
    build: async () => {
      const chef = new ContextChef({ logger: silent });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.registerTools([
        {
          name: 'read_file',
          description: 'Read a file from disk.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ]);
      return chef;
    },
  },
  {
    name: 'memory-after-system',
    build: async () => {
      const chef = new ContextChef({
        logger: silent,
        memory: { store: new InMemoryStore(), memoryPlacement: 'after_system' },
      });
      await seedMemory(chef);
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      return chef;
    },
  },
  {
    name: 'memory-before-history-tail-selector',
    build: async () => {
      const chef = new ContextChef({
        logger: silent,
        memory: {
          store: new InMemoryStore(),
          memoryPlacement: 'before_history_tail',
          // Deterministic visibility policy: alphabetical, two entries.
          selector: (entries) =>
            [...entries].sort((a, b) => a.key.localeCompare(b.key)).slice(0, 2),
        },
      });
      await seedMemory(chef);
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(toolLoop());
      return chef;
    },
  },
  {
    name: 'dynamic-state-last-user',
    build: async () => {
      const chef = new ContextChef({ logger: silent });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.setDynamicState(
        z.object({ step: z.number(), file: z.string(), dirty: z.boolean() }),
        { step: 3, file: 'src/index.ts', dirty: true },
        { placement: 'last_user' },
      );
      return chef;
    },
  },
  {
    name: 'dynamic-state-system',
    build: async () => {
      const chef = new ContextChef({ logger: silent });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.setDynamicState(
        z.object({ step: z.number(), file: z.string(), dirty: z.boolean() }),
        { step: 3, file: 'src/index.ts', dirty: true },
        { placement: 'system' },
      );
      return chef;
    },
  },
  {
    name: 'guardrail-system-placement',
    build: async () => {
      const chef = new ContextChef({ logger: silent });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.withGuardrails({
        enforceXML: { outputTag: 'answer' },
        prefill: '<answer>',
        placement: 'system',
      });
      return chef;
    },
  },
  {
    name: 'guardrail-last-user-placement',
    build: async () => {
      const chef = new ContextChef({ logger: silent });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.withGuardrails({
        enforceXML: { outputTag: 'answer' },
        prefill: '<answer>',
        placement: 'last_user',
      });
      return chef;
    },
  },
  {
    name: 'anchored-archive-vfs',
    build: async () => {
      const chef = new ContextChef({
        logger: silent,
        vfs: { threshold: 999_999, adapter: memoryVfsAdapter() },
        janitor: {
          contextWindow: 60,
          triggerRatio: 1,
          tokenizer: flatTokenizer(10),
          preserveRatio: 0.3,
          compressionMode: 'incremental-anchored',
          archive: 'vfs',
          compressionModel: async () => '<summary>The user set up a Node project.</summary>',
        },
      });
      // Odd length so the surviving tail is a user turn — a trailing
      // assistant message would be read as a prefill and drag the adapters'
      // prefill-degradation path into this fixture.
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(longHistory(9));
      return chef;
    },
  },
  {
    name: 'server-context-management',
    build: async () => {
      const chef = new ContextChef({
        logger: silent,
        contextManagement: { strategy: 'server' },
      });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      return chef;
    },
  },
  {
    name: 'skill-tail-announcement',
    build: async () => {
      const chef = new ContextChef({ logger: silent, skillPlacement: 'tail' });
      chef.setSystemPrompt(SYSTEM_PROMPT).setHistory(conversation());
      chef.activateSkill({
        name: 'planning',
        description: 'Plan before editing',
        instructions: 'Read the code, list affected files, then write a plan.',
      });
      chef.announce('tools:added', 'The `write_file` tool is now available.', {
        channel: 'system',
      });
      return chef;
    },
  },
];
