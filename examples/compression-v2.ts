/**
 * Compression v2 — the v4 janitor pipeline
 *
 * Demonstrates:
 * - triggerRatio: compression fires at contextWindow * 0.7 by default ("pre-rot")
 * - pinned messages surviving compression verbatim
 * - archive: 'vfs' — reversible compression with a cited context:// URI,
 *   recoverable via chef.resolveRecall
 * - compressionGuidelines injected into the compression prompt
 * - minShrinkRatio + validateCompression quality gates (failure = history
 *   unchanged, circuit breaker incremented — never a lossy placeholder)
 * - compress:start / compress:end / compress / offload:created events
 * - compressionMode: 'incremental-anchored' (persistent anchor document)
 *
 * Runs fully offline — the compression model is a mock that returns a
 * well-formed <analysis>/<summary> response.
 *
 * Usage:
 *   npx tsx examples/compression-v2.ts
 */

import { rm } from 'node:fs/promises';
import { ContextChef, Janitor, type Message } from '@context-chef/core';

const STORAGE_DIR = '.context_vfs_compression_example';

// ─── Mock compression model ─────────────────────────────────────────────────
// Receives the to-be-compressed span plus a trailing instruction message. A
// real implementation forwards flattenForCompression(messages) to a cheap
// chat model (see examples/basic-chat.ts). The <analysis> scratchpad is
// stripped; only the <summary> content survives.
let lastInstruction = '';
const mockCompressionModel = async (messages: Message[]): Promise<string> => {
  lastInstruction = messages[messages.length - 1].content;
  return [
    '<analysis>Support thread about a damaged order; keep IDs and the refund decision.</analysis>',
    '<summary>',
    '1. Task Overview: Resolve the refund request for order ORD-1042.',
    '2. Current State: Damage confirmed via photos; customer verified.',
    '3. Important Discoveries: Item arrived crushed; carrier claim already filed.',
    '4. Next Steps: Issue the refund and send a confirmation email.',
    '</summary>',
  ].join('\n');
};

function supportTurn(i: number): Message[] {
  return [
    {
      role: 'user',
      content:
        `Update ${i}: customer replied about order ORD-1042. ` +
        'They attached more photos of the crushed packaging and asked when the refund lands. ' +
        'They also mentioned the replacement should ship to the same address as before.',
    },
    {
      role: 'assistant',
      content:
        `Logged update ${i}. Photos confirm transit damage; carrier claim reference CLM-88${i} noted. ` +
        'Waiting on the refund decision before drafting the confirmation email.',
    },
  ];
}

async function inFlightCompression() {
  console.log('=== In-flight compression (ContextChef) ===\n');

  const chef = new ContextChef({
    vfs: { storageDir: STORAGE_DIR },
    janitor: {
      contextWindow: 10_000,
      // triggerRatio defaults to 0.7: compression triggers at 7_000 tokens,
      // not at the hard 10_000 limit — model quality decays well before the
      // window is full. Set triggerRatio: 1 for the pre-4.0 behavior.
      preserveRecentMessages: 2, // keep the last 2 turns verbatim
      compressionModel: mockCompressionModel,
      // Reversible compression: the full compressed span is serialized into
      // the chef's VFS and the summary cites the context:// URI.
      archive: 'vfs',
      // Numbered domain guidelines appended to the compression prompt.
      compressionGuidelines: [
        'Preserve all order IDs and claim references verbatim.',
        'Record every commitment made to the customer.',
      ],
      // Quality gates. A summary that fails either one is a FAILED
      // compression: history stays unchanged and the circuit breaker
      // increments (3 consecutive failures short-circuit compress()).
      minShrinkRatio: 0.5, // default — summary must halve the span (spans >= 2000 chars)
      validateCompression: (summary) => summary.includes('ORD-1042'),
    },
  });

  chef.on('compress:start', ({ historyLength, currentTokens, limit }) => {
    console.log(
      `[event] compress:start  ${historyLength} msgs, ${currentTokens} tokens > ${limit}`,
    );
  });
  chef.on('compress:end', ({ compressed }) => {
    console.log(`[event] compress:end    compressed=${compressed}`);
  });
  chef.on('compress', ({ truncatedCount, details }) => {
    console.log(
      `[event] compress        replaced ${truncatedCount} msgs ` +
        `(details.compressedMessages: ${details.compressedMessages.length})`,
    );
  });
  chef.on('offload:created', ({ uri }) => {
    console.log(`[event] offload:created ${uri}  (the archived span)`);
  });

  // Pinning: this policy line must survive compression VERBATIM. Pinning is
  // turn-scoped — pinning any message of an atomic tool turn protects the
  // whole turn. (Compaction that drops policy text measurably raises
  // constraint-violation rates; pinning restores them to zero.)
  const policy: Message = {
    role: 'user',
    content: 'STANDING POLICY: never refund more than $100 without supervisor approval.',
    pinned: true,
  };

  const history: Message[] = [
    ...supportTurn(1),
    policy,
    ...supportTurn(2),
    ...supportTurn(3),
    ...supportTurn(4),
  ];

  chef
    .setSystemPrompt([{ role: 'system', content: 'You are a support agent.' }])
    .setHistory(history);

  // Feed-token-usage path: report the prompt tokens from the last API call.
  // 9_000 > 10_000 * 0.7, so the next compile() compresses.
  chef.reportTokenUsage(9_000);
  const payload = await chef.compile({ target: 'openai' });

  const texts = (payload.messages as Array<{ content?: unknown }>).map((m) =>
    typeof m.content === 'string' ? m.content : '',
  );

  console.log(`\nhistory: ${history.length} msgs -> payload: ${payload.messages.length} msgs`);
  console.log('pinned policy survived verbatim:', texts.includes(policy.content));
  console.log(
    'guidelines reached the compression prompt:',
    lastInstruction.includes('Preserve all order IDs'),
  );

  // The summary message cites the archive URI — resolve it to get the exact
  // pre-compression messages back (pair with getRecallToolDefinition to let
  // the model do this itself; see examples/vfs-lifecycle.ts).
  const summaryText = texts.find((t) => t.includes('context://vfs/')) ?? '';
  const uriMatch = summaryText.match(/context:\/\/vfs\/\S+\.txt/);
  console.log('summary cites archive URI:', uriMatch?.[0]);
  if (uriMatch) {
    const serialized = await chef.resolveRecall(uriMatch[0]);
    const archived = serialized ? (JSON.parse(serialized) as { messages: Message[] }) : null;
    console.log('archived span recovered:', archived?.messages.length, 'messages\n');
  }
}

// ─── Incremental-anchored mode ──────────────────────────────────────────────
// Instead of rewriting the whole summary on every compression (drift + loss),
// the Janitor keeps a persistent "anchor document" and each compression
// merges ONLY the newly evicted span into it. The anchor survives
// snapshot()/restore() and clears on reset(). Shown on a standalone Janitor
// for direct access to getAnchorDoc().
async function anchoredMode() {
  console.log('=== compressionMode: incremental-anchored ===\n');

  let calls = 0;
  const janitor = new Janitor({
    contextWindow: 1_000,
    preserveRecentMessages: 1,
    compressionMode: 'incremental-anchored',
    compressionModel: async (messages) => {
      calls++;
      // The instruction embeds the previous anchor (<anchor>...</anchor>)
      // and asks for a merged update; this mock just versions it.
      return `<summary>anchor v${calls}: merged ${messages.length - 1} more messages.</summary>`;
    },
  });

  let history: Message[] = [
    { role: 'user', content: 'Start migrating the billing service to the new API.' },
    { role: 'assistant', content: 'Migration started; auth module converted first.' },
    { role: 'user', content: 'Also update the webhook signatures while you are in there.' },
    { role: 'assistant', content: 'Webhook signature update queued after the auth module.' },
  ];

  janitor.feedTokenUsage(2_000); // over budget -> compress on next call
  history = await janitor.compress(history);
  console.log('after 1st compression:', JSON.stringify(janitor.getAnchorDoc()));

  // The check right after a successful compression is skipped once by design
  // (anti-cascade); this quiet call consumes that suppression.
  history = await janitor.compress(history);

  history.push(
    { role: 'user', content: 'Auth module is verified in staging. Ship the webhooks next.' },
    { role: 'assistant', content: 'Webhook signature rollout is now in progress.' },
  );
  janitor.feedTokenUsage(2_000);
  history = await janitor.compress(history);
  console.log('after 2nd compression:', JSON.stringify(janitor.getAnchorDoc()));
  console.log('(each compression merged only the newly evicted span)\n');
}

// ─── Failure semantics: quality gates never truncate ────────────────────────
// v4 BREAKING change: a failed compression (model error, shrink-guard
// rejection, validateCompression false) leaves history UNCHANGED. Pre-4.0,
// a model failure truncated history behind a bare placeholder.
async function failedCompressionLeavesHistoryUnchanged() {
  console.log('=== Failed compression: history unchanged ===\n');

  const echoJanitor = new Janitor({
    contextWindow: 1_000,
    preserveRecentMessages: 1,
    // This "summarizer" echoes its input, so it can never shrink the span —
    // exactly the death-loop scenario minShrinkRatio (default 0.5) guards.
    compressionModel: async (messages) => messages.map((m) => m.content).join('\n'),
    logger: { warn: (message) => console.log(`  [warn] ${String(message).slice(0, 100)}...`) },
  });

  const bigHistory: Message[] = supportTurn(1)
    .concat(supportTurn(2), supportTurn(3), supportTurn(4))
    .concat({ role: 'user', content: 'So where are we on the refund?' });

  echoJanitor.feedTokenUsage(5_000);
  const result = await echoJanitor.compress(bigHistory);
  console.log('history returned unchanged:', result === bigHistory);
  console.log('(the failure counted toward the 3-strike circuit breaker)');
}

async function main() {
  console.log('=== ContextChef Compression v2 Example ===\n');
  await inFlightCompression();
  await anchoredMode();
  await failedCompressionLeavesHistoryUnchanged();
  await rm(STORAGE_DIR, { recursive: true, force: true });
}

main().catch(console.error);
