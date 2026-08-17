/**
 * AI SDK Middleware — withContextChef around a Vercel AI SDK model
 *
 * Demonstrates:
 * - withContextChef(openai('gpt-4o'), ...): compress + truncate + compact in
 *   one wrapper, zero changes to the generateText call site
 * - per-conversation session isolation via providerOptions contextChef.sessionId
 * - the anti-double-compression guard for Anthropic server-side context
 *   management (allowDoubleCompression)
 * - durable compaction with compactModelMessages when you own the store
 *
 * The wrapper setup below typechecks and constructs offline; the actual model
 * call at the bottom needs OPENAI_API_KEY and is skipped without it.
 *
 * Usage:
 *   export OPENAI_API_KEY=your-key
 *   npx tsx examples/ai-sdk-middleware.ts
 */

import { openai } from '@ai-sdk/openai';
import { compactModelMessages, withContextChef } from '@context-chef/ai-sdk-middleware';
import { generateText, type ModelMessage } from 'ai';

// ─── The wrapped model ──────────────────────────────────────────────────────
// Create once at module scope, reuse everywhere. The middleware rewrites each
// outgoing request (in-flight): it does NOT mutate your message store.
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000, // required whenever compression is configured

  // LLM compression. v4 note: the janitor triggers at contextWindow * 0.7 by
  // default ("pre-rot") — earlier than the pre-4.0 trigger-at-window behavior.
  compress: {
    model: openai('gpt-4o-mini'), // cheap summarizer
    preserveRatio: 0.8, // keep 80% of the effective budget for recent messages
    toolResultStubThreshold: 5_000, // stub huge tool outputs before summarizing
  },

  // Mechanical tool-result truncation (head/tail preserved, middle dropped).
  truncate: {
    threshold: 5_000,
    headChars: 500,
    tailChars: 1_000,
    perTool: [
      'read_file', // never truncate this tool
      { name: 'fetch_logs', threshold: 50_000 }, // higher threshold for this one
    ],
  },

  // Zero-LLM-cost pruning (AI SDK pruneMessages semantics).
  compact: {
    reasoning: 'before-last-message', // keep reasoning only on the last message
    toolCalls: 'before-last-2-messages',
    emptyMessages: 'remove',
  },

  // In-flight compression discards the summary after each call. For sustained
  // over-budget conversations, persist the boundary here (or use the durable
  // compactModelMessages pattern below) — otherwise history re-expands and
  // the middleware warns after repeated compressions.
  onCompress: (summary, truncatedCount) => {
    console.log(`[onCompress] replaced ${truncatedCount} messages (${summary.length} chars)`);
  },

  // Anti-double-compression: when a call opts into Anthropic server-side
  // context management (providerOptions.anthropic.contextManagement), the
  // middleware SKIPS its own compression for that call — the server already
  // compacts, and compressing here too would rewrite the same history twice.
  // Set allowDoubleCompression: true only if your middleware trigger is
  // deliberately tuned below the server-side threshold.
  // allowDoubleCompression: true,
});

// ─── Durable compaction (you own the store) ─────────────────────────────────
// Between calls, shrink the persisted history itself with a cheap model.
// Returns the input reference unchanged on a no-op, so persistence is easy to
// gate. Do not combine with `compress` on the same conversation.
async function compactStoredConversation(stored: ModelMessage[]): Promise<ModelMessage[]> {
  const compacted = await compactModelMessages(stored, openai('gpt-4o-mini'), {
    keepRecentTurns: 6, // message-level turns, not agent steps — size generously
  });
  if (compacted !== stored) {
    // await store.replaceMessages(conversationId, compacted);
    console.log(`durably compacted: ${stored.length} -> ${compacted.length} messages`);
  }
  return compacted;
}

async function main() {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'In one sentence: what does an LLM context window limit?' },
  ];

  const result = await generateText({
    model,
    messages,
    // Session isolation: one wrapped model serves many conversations. Without
    // a sessionId all calls share one compression-state session — fine for a
    // CLI, wrong for a multi-user server.
    providerOptions: { contextChef: { sessionId: 'user-42:conversation-7' } },
  });

  console.log('assistant:', result.text);

  // Later, against your own store:
  await compactStoredConversation(messages);
}

// The wrapper above is fully constructed at this point — only the live call
// needs a key.
if (process.env.OPENAI_API_KEY) {
  main().catch(console.error);
} else {
  console.log('OPENAI_API_KEY not set — skipping the live call. The wiring above still ran.');
}
