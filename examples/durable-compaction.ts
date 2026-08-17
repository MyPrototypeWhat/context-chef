/**
 * Durable Compaction — shrink the history you OWN, not just the payload
 *
 * Demonstrates:
 * - planCompaction: a turn-safe { system, toSummarize, toKeep } split
 * - compactHistory: one-shot plan + summarize + reassemble, ready to persist
 * - the persist pattern (result === history means "no-op, skip the write")
 * - contrast with in-flight compression (chef.compile / middleware compress)
 *
 * In-flight compression rewrites each OUTGOING request — your message store
 * is untouched, so a sustained over-budget conversation re-expands every
 * call. Durable compaction runs between calls against your own store and
 * actually replaces the old messages, so the history shrinks for good.
 *
 * Runs fully offline — the summarizer is a mock.
 *
 * Usage:
 *   npx tsx examples/durable-compaction.ts
 */

import { compactHistory, type Message, planCompaction } from '@context-chef/core';

// Mock summarizer. A real one forwards flattenForCompression(messages) to a
// cheap chat model — it MUST flatten, because chat endpoints reject raw
// `tool` roles (see examples/basic-chat.ts for the live version).
const mockSummarizer = async (_messages: Message[]): Promise<string> =>
  [
    '<summary>',
    '1. Task Overview: Debug the failing checkout integration test.',
    '2. Current State: Root cause found — stale fixture in tests/fixtures/cart.json.',
    '3. Important Discoveries: The API changed its price field from cents to a decimal string.',
    '4. Next Steps: Regenerate the fixture and re-run the suite.',
    '</summary>',
  ].join('\n');

// A store-shaped history: system messages INLINE (planCompaction extracts
// them and always preserves them verbatim). Includes a tool turn to show the
// turn-safe split — an assistant with tool_calls plus its tool results is one
// atomic turn, so the cut can never orphan a tool result.
const storedHistory: Message[] = [
  { role: 'system', content: 'You are a debugging assistant.' },
  { role: 'user', content: 'The checkout integration test fails on main. Find out why.' },
  {
    role: 'assistant',
    content: 'Running the failing test to capture the error.',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'run_tests', arguments: '{"filter":"checkout"}' },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'FAIL tests/checkout.test.ts — expected total "12.50", received 1250',
  },
  {
    role: 'assistant',
    content: 'The API now returns decimal strings; the fixture still has cents.',
  },
  { role: 'user', content: 'Fix the fixture then.' },
  { role: 'assistant', content: 'Updating tests/fixtures/cart.json to the new price format.' },
];

async function main() {
  console.log('=== ContextChef Durable Compaction Example ===\n');

  // ─── 1. The plan: inspect the split before committing to a model call ─────
  const plan = planCompaction(storedHistory, { keepRecentTurns: 2 });
  console.log('--- planCompaction({ keepRecentTurns: 2 }) ---');
  console.log('system (always kept): ', plan.system.length, 'message(s)');
  console.log('toSummarize:          ', plan.toSummarize.length, 'message(s)');
  console.log('toKeep (recent turns):', plan.toKeep.length, 'message(s)');
  // The assistant+tool_calls message and its tool result always land on the
  // same side of the cut — a turn is atomic.
  const sliceHasCall = plan.toSummarize.some((m) => m.tool_calls !== undefined);
  const sliceHasResult = plan.toSummarize.some((m) => m.role === 'tool');
  console.log('tool call + result in the same slice:', sliceHasCall === sliceHasResult, '\n');

  // ─── 2. One-shot: plan + summarize + reassemble ───────────────────────────
  const compacted = await compactHistory(storedHistory, mockSummarizer, {
    keepRecentTurns: 2,
    compressionGuidelines: ['Preserve file paths and test names verbatim.'],
  });

  console.log('--- compactHistory result ---');
  console.log(`before: ${storedHistory.length} messages, after: ${compacted.length} messages`);
  for (const m of compacted) {
    console.log(`  [${m.role}] ${m.content.slice(0, 76).replace(/\n/g, ' ')}...`);
  }

  // ─── 3. The persist pattern ───────────────────────────────────────────────
  // compactHistory returns the INPUT REFERENCE unchanged when there is
  // nothing old enough to compact, so it is safe to call unconditionally and
  // cheap to gate persistence on.
  if (compacted !== storedHistory) {
    // await store.replaceMessages(conversationId, compacted);
    console.log('\nchanged -> persist [system, summary, ...kept] to your store');
  }

  const noop = await compactHistory(storedHistory, mockSummarizer, { keepRecentTurns: 50 });
  console.log('keepRecentTurns: 50 is a no-op (same reference):', noop === storedHistory);

  // Do NOT combine durable compaction with in-flight compression (a janitor
  // compressionModel, or middleware `compress`) on the same conversation —
  // that summarizes the same span twice. Pick one altitude:
  //   - you own the store  -> durable compactHistory between calls
  //   - store is opaque    -> in-flight compression per request
}

main().catch(console.error);
