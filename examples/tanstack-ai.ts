/**
 * TanStack AI — contextChefMiddleware in chat({ middleware })
 *
 * Demonstrates:
 * - contextChefMiddleware with compress + truncate + compact (@tanstack/ai 0.44)
 * - threadId keying per-conversation compression state
 * - durable compaction with compactTanStackMessages when you own the store
 *
 * The middleware setup below typechecks and constructs offline; the actual
 * chat() call at the bottom needs OPENAI_API_KEY and is skipped without it.
 *
 * Usage:
 *   export OPENAI_API_KEY=your-key
 *   npx tsx examples/tanstack-ai.ts
 */

import {
  compactTanStackMessages,
  contextChefMiddleware,
  planCompactionTanStackMessages,
} from '@context-chef/tanstack-ai';
import { chat, type ModelMessage } from '@tanstack/ai';
import { openaiText } from '@tanstack/ai-openai';

// openaiText() reads OPENAI_API_KEY at construction — exit gracefully without it.
if (!process.env.OPENAI_API_KEY) {
  console.log('Set OPENAI_API_KEY to run this example (see the Usage header).');
  process.exit(0);
}

// ─── The middleware ─────────────────────────────────────────────────────────
// Create once, drop into chat({ middleware }). It hooks onConfig (rewrites
// messages/systemPrompts before each model iteration) and onUsage (feeds
// promptTokens back for the budget check). Hooks never throw into the host —
// on an unexpected error the request passes through unchanged.
const middleware = contextChefMiddleware({
  contextWindow: 128_000, // required whenever compression is configured

  // LLM compression with a cheap adapter. v4 note: the janitor triggers at
  // contextWindow * 0.7 by default ("pre-rot"), not at the hard limit.
  compress: {
    adapter: openaiText('gpt-4o-mini'),
    preserveRatio: 0.8,
    toolResultStubThreshold: 5_000,
  },

  // Mechanical tool-result truncation (head/tail preserved).
  truncate: {
    threshold: 5_000,
    headChars: 500,
    tailChars: 1_000,
  },

  // Zero-LLM-cost pruning before compression.
  compact: {
    reasoning: 'all', // strip thinking arrays ('clear: ["thinking"]' also works in v4)
    toolCalls: 'before-last-message',
    emptyMessages: 'remove',
  },

  onCompress: (summary, truncatedCount) => {
    // details.compressedMessages (3rd arg) is the exact ModelMessage[] slice
    // the summary replaced — the boundary to persist in your own store.
    console.log(`[onCompress] replaced ${truncatedCount} messages (${summary.length} chars)`);
  },
});

// ─── Durable compaction (you own the store) ─────────────────────────────────
// The middleware only rewrites the in-flight request. To shrink the history
// you persist, compact between chat() calls. No `system` slice here —
// TanStack AI keeps system prompts outside `messages`.
async function compactStoredConversation(stored: ModelMessage[]): Promise<ModelMessage[]> {
  // Inspect the turn-safe split first if you want to log or veto it:
  const plan = planCompactionTanStackMessages(stored, { keepRecentTurns: 6 });
  console.log(`plan: summarize ${plan.toSummarize.length}, keep ${plan.toKeep.length}`);

  const compacted = await compactTanStackMessages(stored, openaiText('gpt-4o-mini'), {
    keepRecentTurns: 6,
  });
  if (compacted !== stored) {
    // await store.replaceMessages(threadId, compacted);
    console.log(`durably compacted: ${stored.length} -> ${compacted.length} messages`);
  }
  // Don't combine this with the middleware's `compress` on the SAME
  // conversation — that would summarize the same span twice.
  return compacted;
}

async function main() {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'In one sentence: why do agents need context management?' },
  ];

  const text = await chat({
    adapter: openaiText('gpt-4o'),
    messages,
    systemPrompts: ['You are a concise assistant.'],
    // threadId keys the per-conversation compression state (fed token usage,
    // suppression, circuit breaker). Calls without one get per-run isolation
    // only — always pass it for multi-turn conversations.
    threadId: 'conversation-1',
    middleware: [middleware],
    stream: false, // Promise<string>; omit for the streaming chunk iterable
  });

  console.log('assistant:', text);

  // Later, against your own store:
  await compactStoredConversation(messages);
}

// The middleware above is fully constructed at this point — only the live
// call needs a key.
if (process.env.OPENAI_API_KEY) {
  main().catch(console.error);
} else {
  console.log('OPENAI_API_KEY not set — skipping the live call. The wiring above still ran.');
}
