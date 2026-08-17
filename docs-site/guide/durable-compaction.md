# Durable Compaction

In-flight compression rewrites each outgoing payload but does not touch your message store — for a sustained over-budget conversation the summary is recomputed on every call. When you own the store, compact it once and persist the result. This page covers the durable compaction helpers in core and their AI SDK / TanStack AI ports.

All three helpers split on atomic turn boundaries (an assistant message and its tool results never separate), summarize the old slice, and return `[...system, <summary>, ...recent turns]`; on a no-op the input reference is returned unchanged, so you can skip persistence via `result === input`.

## Core — provider-agnostic, operates on IR `Message[]`

```typescript
import { compactHistory, planCompaction } from "@context-chef/core";

// myCompressFn must role-flatten tool messages (same contract as summarizeHistory)
history = await compactHistory(history, myCompressFn, { keepRecentTurns: 4 });
// planCompaction(history, { keepRecentTurns }) is the synchronous split behind it
```

## Vercel AI SDK — `ModelMessage` altitude, role-flattening wired for you

```typescript
import { compactModelMessages } from "@context-chef/ai-sdk-middleware";

messages = await compactModelMessages(messages, openai("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

Run it in your own loop (own the store and write the result back), or inside a `ToolLoopAgent`:

```typescript
import { compactModelMessages } from '@context-chef/ai-sdk-middleware';

const agent = new ToolLoopAgent({
  model,
  tools,
  prepareStep: async ({ messages, model }) => ({
    messages: await compactModelMessages(messages, model, { keepRecentTurns: 4 }),
  }),
});
```

Key properties:

- `model` is `ai`'s `LanguageModel` (`string id | V3 | V2`) — exactly what `prepareStep` / `generateText` give you.
- The cut lands only on **turn boundaries** (an assistant + its tool results stay together), so it never orphans a tool result or splits a multi-block assistant message.
- System messages are preserved verbatim and never summarized.
- Returns the **same `messages` reference** when there is nothing old enough to compact or the summarizer yields no text — skip persistence on a no-op via `next !== messages`. Safe to call unconditionally; throws only if the model call throws.
- Accepts the same `SummarizeMessagesOptions` (`customCompressionInstructions`, `toolResultStubThreshold`) as `summarizeMessages`.

> **`keepRecentTurns` is message-level turns, not `ToolLoopAgent` steps.** A turn is one user/assistant message, or an assistant with its tool-calls plus all their tool results (kept together). A single tool-using step is often 2–3 turns, so size `keepRecentTurns` for your worst-case step — a tool-dense agent loop needs a larger value than a plain chat. The summary is inserted as a `user` message, so when the kept tail also begins with a user turn the result can hold two consecutive `user` messages — a valid `ModelMessage[]` that the AI SDK provider layer normalizes (Anthropic merges same-role, OpenAI accepts it).

## TanStack AI — takes any TanStack text adapter

```typescript
import { compactTanStackMessages } from "@context-chef/tanstack-ai";

messages = await compactTanStackMessages(messages, openaiText("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

- `planCompactionTanStackMessages(messages, { keepRecentTurns })` — turn-safe split into `{ toSummarize, toKeep }` (no `system` slice: TanStack AI keeps system prompts outside `messages`).
- `compactTanStackMessages(messages, adapter, options)` — one-shot: plan, summarize, return `[<summary>, ...toKeep]`. Returns the input reference unchanged on a no-op.
- `summarizeTanStackMessages(messages, adapter, opts?)` — just the summary string, using the same pipeline as `compress`.

## Full compaction (Claude Code style)

`keepRecentTurns: 0` is full Claude-Code-style compaction — the whole conversation collapses into `[...system, <summary>]`, with no verbatim tail. This is the simplest mode to persist: because there is no kept tail, there is nothing to reconcile against your store's own unit boundaries — the write-back is just "replace the store with the two-message result."

The trade-off is that **no verbatim recent context survives** — the model continues purely from a lossy summary. So the summary's quality is everything; steer it toward a structured handoff with `customCompressionInstructions`:

```typescript
const next = await compactModelMessages(messages, summarizerModel, {
  keepRecentTurns: 0, // full compaction — collapse everything into the summary
  customCompressionInstructions: [
    'Write the summary as a handoff for resuming the task:',
    '- What was accomplished and the current state',
    '- Decisions made and why they were made',
    '- Files / resources touched',
    '- The exact next step to take',
  ].join('\n'),
});
// `next` is now [system, summary] — trivial to persist, no boundary bookkeeping.
```

Prefer a small `keepRecentTurns` (e.g. `2`–`4`) when you want the in-flight turn kept verbatim (safer for an autonomous loop mid-task); prefer `0` when you want maximal shrink and a clean, boundary-free store.

## Plan and summarize separately

When you want the boundary without summarizing (persist your own marker, or use a different summarizer), use the synchronous split plus the standalone summarizer:

```typescript
import { planCompactionModelMessages, summarizeModelMessages } from '@context-chef/ai-sdk-middleware';
import { Prompts } from '@context-chef/core';

const { system, toSummarize, toKeep } = planCompactionModelMessages(messages, { keepRecentTurns: 4 });
if (toSummarize.length > 0) {
  const summary = await summarizeModelMessages(toSummarize, model);
  messages = [
    ...system,
    { role: 'user', content: [{ type: 'text', text: Prompts.getCompactSummaryWrapper(summary) }] },
    ...toKeep,
  ];
}
```

## Don't double-compress

Don't combine durable compaction with in-flight compression ([Janitor](/guide/history-compression), or middleware `compress`) on the same conversation — that compresses the same history twice. Pick one strategy per conversation. See the [core](/packages/core), [ai-sdk-middleware](/packages/ai-sdk-middleware), and [tanstack-ai](/packages/tanstack-ai) package pages for the full contracts.
