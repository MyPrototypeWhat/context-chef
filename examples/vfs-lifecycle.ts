/**
 * VFS Lifecycle — offload, recall, and clean up large tool output
 *
 * Demonstrates:
 * - offloadAsync: replacing a big tool output with a head/tail marker + URI
 * - the 'offload:created' event
 * - getRecallToolDefinition + chef.resolveRecall round-trip (model-driven recall)
 * - cleanupAsync with maxFiles / maxBytes caps (LRU eviction)
 *
 * Runs fully offline — no API key required. Writes to a throwaway directory
 * that is removed at the end.
 *
 * Usage:
 *   npx tsx examples/vfs-lifecycle.ts
 */

import { rm } from 'node:fs/promises';
import { ContextChef, getRecallToolDefinition } from '@context-chef/core';

const STORAGE_DIR = '.context_vfs_example';

const chef = new ContextChef({
  vfs: {
    threshold: 500, // offload anything longer than 500 chars
    storageDir: STORAGE_DIR,
  },
});

// Observe every offload (tool output AND compression archives go through here).
const offloadedUris: string[] = [];
chef.on('offload:created', ({ uri }) => {
  offloadedUris.push(uri);
  console.log('[event] offload:created ->', uri);
});

function fakeToolOutput(label: string, lines: number): string {
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    rows.push(`${label} row ${i}: status=ok latency=${(i * 7) % 90}ms region=eu-west-1`);
  }
  return rows.join('\n');
}

async function main() {
  console.log('=== ContextChef VFS Lifecycle Example ===\n');

  // 1. Offload: content over the threshold is written to the VFS and replaced
  //    by a marker that keeps a head/tail preview plus a context:// URI (and
  //    the physical path, when the adapter exposes one).
  const bigOutput = fakeToolOutput('query', 200);
  const truncated = await chef.offloadAsync(bigOutput, { headChars: 120, tailChars: 120 });

  console.log(`\noriginal: ${bigOutput.length} chars -> marker: ${truncated.length} chars`);
  console.log('--- marker (what the model sees in place of the output) ---');
  console.log(truncated);

  // 2. Recall tool: register the ready-made definition so the model can ask
  //    for the full content back. compile() carries it in payload.tools.
  chef.registerTools([getRecallToolDefinition()]);
  const payload = await chef
    .setSystemPrompt([{ role: 'system', content: 'You are a log analysis assistant.' }])
    .setHistory([
      { role: 'user', content: 'Summarize the query results.' },
      { role: 'assistant', content: `Here is what the tool returned:\n${truncated}` },
    ])
    .compile({ target: 'openai' });
  console.log(
    '\npayload.tools:',
    (payload.tools ?? []).map((t) => t.name),
  );

  // 3. Round-trip: when the model calls recall_context, dispatch the URI to
  //    chef.resolveRecall — it returns the full stored content (or null for
  //    unknown URIs).
  const uri = offloadedUris[0];
  const simulatedToolCall = { name: 'recall_context', arguments: JSON.stringify({ uri }) };
  const recalled = await chef.resolveRecall(JSON.parse(simulatedToolCall.arguments).uri);
  console.log('\nrecall round-trip intact:', recalled === bigOutput);
  console.log(
    'unknown URI returns null:',
    (await chef.resolveRecall('context://vfs/nope.txt')) === null,
  );

  // 4. Cleanup: cap the store by count/bytes/age. Caps can live in VFSConfig
  //    or be passed per call; eviction is LRU (least recently resolved first).
  await chef.offloadAsync(fakeToolOutput('deploy', 150));
  await chef.offloadAsync(fakeToolOutput('audit', 180));
  console.log(
    '\nentries before cleanup:',
    chef
      .getOffloader()
      .getEntries()
      .map((e) => `${e.filename} (${e.bytes}B)`),
  );

  const result = await chef.getOffloader().cleanupAsync({ maxFiles: 2, maxBytes: 50_000 });
  console.log(
    `cleanup evicted ${result.evicted.length} entr${result.evicted.length === 1 ? 'y' : 'ies'} ` +
      `(${result.evictedBytes} bytes; byCount=${result.evictedByCount}, byBytes=${result.evictedByBytes})`,
  );
  console.log(
    'entries after cleanup:',
    chef
      .getOffloader()
      .getEntries()
      .map((e) => e.filename),
  );

  // After a process restart the in-memory index is empty; call
  // chef.getOffloader().reconcileAsync() to adopt pre-restart files before
  // cleanup — otherwise they are invisible to the sweep.

  await rm(STORAGE_DIR, { recursive: true, force: true });
}

main().catch(console.error);
