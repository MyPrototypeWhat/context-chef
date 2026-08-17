/**
 * Snapshot / Restore — rollback for risky branches
 *
 * Demonstrates:
 * - chef.snapshot(label) before a risky operation, chef.restore(snap) after
 * - guardrailOptions surviving the round-trip (v4: withGuardrails is stored
 *   state, so snapshots carry it)
 * - Janitor state surviving too — including the 'incremental-anchored'
 *   anchor document
 * - label + createdAt metadata on the snapshot
 *
 * Runs fully offline — the compression model is a mock.
 *
 * Usage:
 *   npx tsx examples/snapshot-restore.ts
 */

import { ContextChef, type Message } from '@context-chef/core';

// Mock summarizer so the example runs without an API key. A real one would
// forward flattenForCompression(messages) to a cheap chat model.
const mockCompressionModel = async (_messages: Message[]): Promise<string> =>
  '<summary>Refactoring the payment flow; DB schema is locked; tests 12/14 green.</summary>';

const chef = new ContextChef({
  janitor: {
    contextWindow: 1_000, // tiny window so the fed usage below triggers compression
    preserveRecentMessages: 1,
    compressionMode: 'incremental-anchored', // keeps a persistent anchor document
    compressionModel: mockCompressionModel,
  },
});

const history: Message[] = [
  { role: 'user', content: 'Refactor the payment flow to support partial refunds.' },
  { role: 'assistant', content: 'Started. The schema needs a refunded_amount column.' },
  { role: 'user', content: 'Schema is locked this sprint — work around it.' },
  { role: 'assistant', content: 'Understood, storing refunds in the ledger table instead.' },
];

async function main() {
  console.log('=== ContextChef Snapshot / Restore Example ===\n');

  chef
    .setSystemPrompt([{ role: 'system', content: 'You are a senior engineer.' }])
    .setHistory(history)
    .withGuardrails({ enforceXML: { outputTag: 'plan' }, prefill: '<plan>' });

  // Trigger one compression so the Janitor holds interesting state (the
  // anchor document). compile() never mutates chef's stored history — the
  // compression only shapes the outgoing payload — but Janitor state advances.
  chef.reportTokenUsage(2_000);
  await chef.compile({ target: 'anthropic' });

  // ─── Snapshot before the risky branch ─────────────────────────────────────
  const snap = chef.snapshot('before-experimental-branch');
  console.log('snapshot label:   ', snap.label);
  console.log('snapshot createdAt:', new Date(snap.createdAt).toISOString());
  console.log('guardrailOptions: ', JSON.stringify(snap.guardrailOptions));
  console.log('janitor anchor:   ', JSON.stringify(snap.modules.janitor.anchorDoc), '\n');

  // ─── The risky branch mutates everything ──────────────────────────────────
  chef.withGuardrails(null); // guardrail gone
  chef.clearHistory(); // history gone, Janitor reset (anchor cleared)
  chef.setHistory([{ role: 'user', content: 'Actually, rewrite it all in Rust.' }]);

  const mutated = await chef.compile({ target: 'anthropic' });
  const mutatedLast = mutated.messages[mutated.messages.length - 1];
  console.log('after mutation:');
  console.log('  history messages:', mutated.messages.length);
  console.log('  trailing prefill:', mutatedLast.role === 'assistant'); // false — guardrail cleared
  console.log('  janitor anchor:  ', JSON.stringify(chef.snapshot().modules.janitor.anchorDoc));

  // ─── Roll back ────────────────────────────────────────────────────────────
  chef.restore(snap);

  const restored = await chef.compile({ target: 'anthropic' });
  const restoredLast = restored.messages[restored.messages.length - 1];
  console.log('\nafter restore:');
  console.log('  history messages:', restored.messages.length);
  console.log('  trailing prefill:', restoredLast.role === 'assistant'); // true — guardrail is back
  console.log('  janitor anchor:  ', JSON.stringify(chef.snapshot().modules.janitor.anchorDoc));

  // Snapshots are deep clones: mutating chef after snapshot() never bleeds
  // into an already-captured snapshot, and restore() clones again on the way
  // back in — the same snapshot can be restored multiple times.
}

main().catch(console.error);
