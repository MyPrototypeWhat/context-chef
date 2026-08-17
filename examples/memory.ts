/**
 * Memory — cross-turn key-value context with TTL, placement, and LLM tools
 *
 * Demonstrates:
 * - Memory backed by InMemoryStore: set / TTL (turn-based and wall-clock)
 * - Both memoryPlacement modes ('after_system' vs 'before_history_tail')
 *   and why the tail placement is KV-cache friendly
 * - selector: choosing which entries get injected each compile
 * - compile() injecting the <memory> block, memory tool definitions in
 *   payload.tools, and meta.injectedMemoryKeys / meta.memoryExpiredKeys
 *
 * Runs fully offline — no API key required.
 *
 * Usage:
 *   npx tsx examples/memory.ts
 */

import { ContextChef, InMemoryStore } from '@context-chef/core';

// payload.messages is provider-typed (openai's ChatCompletionMessageParam);
// this loose view is enough for scanning message text in a demo.
type LooseMessage = { role: string; content?: unknown };

function messageText(m: LooseMessage | undefined): string {
  return m && typeof m.content === 'string' ? m.content : '';
}

const history = [
  { role: 'user' as const, content: 'Can you review my new endpoint?' },
  { role: 'assistant' as const, content: 'Sure — paste the handler and I will take a look.' },
  { role: 'user' as const, content: 'Here it is: app.post("/orders", createOrder)' },
];

// ─── 1. Default placement: 'after_system' ───────────────────────────────────
//
// The memory usage instruction and the volatile <memory> data block are folded
// into ONE system message right after your system prompt. Simple, but on
// providers that hoist system messages into a top-level system parameter
// (Anthropic, Gemini), every memory mutation rewrites that parameter — cache
// breakpoints placed after it are invalidated on each change.

async function afterSystemPlacement() {
  console.log('=== Placement: after_system (default) ===\n');

  const chef = new ContextChef({
    memory: {
      store: new InMemoryStore(),
      // Only inject the 2 most recently updated entries each compile.
      selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2),
    },
  });

  const memory = chef.getMemory();

  // No TTL option -> never expires (no defaultTTL configured on this chef).
  await memory.set('project_language', 'TypeScript, strict mode', {
    description: 'Language and compiler settings for this project',
  });
  // Turn-based TTL: a bare number (or { turns: n }) expires after n compiles.
  await memory.set('current_bug', 'POST /orders returns 500 on empty cart', { ttl: 2 });
  // Wall-clock TTL: { ms } expires after that many milliseconds.
  await memory.set('ci_status', 'main is green as of 10:32', { ttl: { ms: 60_000 } });

  const payload = await chef
    .setSystemPrompt([{ role: 'system', content: 'You are a code review assistant.' }])
    .setHistory(history)
    .compile({ target: 'openai' });

  // The selector picked 2 of the 3 entries; both keys are reported in meta.
  console.log('meta.injectedMemoryKeys:', payload.meta?.injectedMemoryKeys);

  const memoryMessage = (payload.messages as LooseMessage[]).find((m) =>
    messageText(m).includes('<memory>'),
  );
  console.log(`<memory> block lives in a '${memoryMessage?.role}' message:\n`);
  console.log(`${messageText(memoryMessage).slice(0, 400)}\n  ...\n`);

  // Memory also contributes tool definitions so the LLM can manage its own
  // memory: create_memory always, modify_memory once at least one key exists.
  console.log(
    'payload.tools:',
    (payload.tools ?? []).map((t) => t.name),
  );

  // Turn-based expiry: 'current_bug' was written with ttl: 2 at turn 0, so it
  // expires once the turn counter reaches 2. Each compile() advances one turn.
  await chef.compile({ target: 'openai' });
  const third = await chef.compile({ target: 'openai' });
  console.log('expired on a later compile:', third.meta?.memoryExpiredKeys, '\n');
}

// ─── 2. Cache-friendly placement: 'before_history_tail' ─────────────────────
//
// The STABLE usage instruction stays at the top as a system message (cacheable
// forever), while the VOLATILE <memory> data block is appended to the most
// recent user message — the same slot as dynamic state. The changing text
// never enters the top-level system parameter, so provider prefix caches over
// the system prompt and earlier history survive every memory mutation.

async function beforeHistoryTailPlacement() {
  console.log('=== Placement: before_history_tail (KV-cache friendly) ===\n');

  const chef = new ContextChef({
    memory: {
      store: new InMemoryStore(),
      memoryPlacement: 'before_history_tail',
    },
  });

  await chef.getMemory().set('user_preference', 'Prefers concise answers with code samples');

  const payload = await chef
    .setSystemPrompt([{ role: 'system', content: 'You are a code review assistant.' }])
    .setHistory(history)
    .compile({ target: 'openai' });

  const messages = payload.messages as LooseMessage[];
  const systemMessages = messages.filter((m) => m.role === 'system');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  console.log(
    'system messages contain <memory> data:',
    systemMessages.some((m) => messageText(m).includes('<memory>')),
  );
  console.log(
    'last user message contains <memory> data:',
    lastUser ? messageText(lastUser).includes('<memory>') : false,
  );
  console.log('\nTail of the last user message:\n');
  console.log(`  ...\n${messageText(lastUser).slice(-300)}\n`);
}

async function main() {
  console.log('=== ContextChef Memory Example ===\n');
  await afterSystemPlacement();
  await beforeHistoryTailPlacement();
}

main().catch(console.error);
