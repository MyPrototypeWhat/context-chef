# @context-chef/tanstack-ai

[![npm version](https://img.shields.io/npm/v/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/tanstack-ai.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![TanStack AI](https://img.shields.io/badge/TanStack%20AI-v0.44-ff4154.svg)](https://tanstack.com/ai)

[TanStack AI](https://tanstack.com/ai) `ChatMiddleware` powered by [context-chef](https://github.com/MyPrototypeWhat/context-chef). Transparent history compression, tool result truncation, and token budget management — drop in as a single middleware.

Requires `@tanstack/ai` **^0.44** (the 2026-03 middleware rework). For the pre-rework `^0.10` API, use `@context-chef/tanstack-ai@0.x`.

## Installation

```bash
npm install @context-chef/tanstack-ai @tanstack/ai
```

## Quick Start

```typescript
import { contextChefMiddleware } from '@context-chef/tanstack-ai';
import { chat } from '@tanstack/ai';
import { openaiText } from '@tanstack/ai-openai';

const stream = chat({
  adapter: openaiText('gpt-4o'),
  messages,
  threadId: 'conversation-1', // keys per-conversation compression state
  middleware: [
    contextChefMiddleware({
      contextWindow: 128_000,
      compress: { adapter: openaiText('gpt-4o-mini') },
      truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
    }),
  ],
});
```

That's it. History compression, tool result truncation, and token budget tracking happen automatically behind the scenes.

## Features

### History Compression

When the conversation exceeds the token budget, the middleware compresses older messages to make room. `contextWindow` is **required** whenever a compression option (`compress`, `onCompress`, `onBeforeCompress`) is configured; configurations without one (truncate/compact/clear/skill/dynamicState-only) don't need it.

**With a compression model** — old messages are summarized by a cheap model before being replaced:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  compress: {
    adapter: openaiText('gpt-4o-mini'), // cheap adapter for summarization
    preserveRatio: 0.8,                 // keep 80% of context for recent messages
  },
})
```

**Without a compression model** — configure `onBeforeCompress` (with or without returning replacement messages); when the budget is exceeded and no model is set, old messages are discarded and only recent messages are kept.

### Tool Result Truncation

Large tool outputs (terminal logs, API responses) are automatically truncated while preserving the head and tail:

```typescript
contextChefMiddleware({
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
  },
})
```

Optionally persist the original content via a storage adapter so it can be retrieved later by a tool, audit pipeline, or replay layer:

```typescript
import { FileSystemAdapter } from '@context-chef/core';

contextChefMiddleware({
  truncate: {
    threshold: 5000,
    headChars: 500,
    tailChars: 1000,
    storage: new FileSystemAdapter('.context_vfs'), // or your own DB adapter
  },
})
```

When the adapter exposes a physical path (`FileSystemAdapter` does this out of the box via `getPhysicalPath`), the truncation marker advertises that path as the primary retrieval handle — the model can read it back with its standard file-read tool, no custom URI-aware tool needed. Adapters that don't map to a filesystem (DB, in-memory) leave `getPhysicalPath` unset and the marker falls back to the `context://vfs/` URI alone.

Per-tool overrides via `perTool` — bare strings preserve a tool entirely (storage is also bypassed), object entries override `threshold` / `headChars` / `tailChars` for that one tool:

```typescript
contextChefMiddleware({
  truncate: {
    threshold: 5000,
    tailChars: 1000,
    perTool: [
      'read_file',                                 // never truncate; not stored in VFS
      { name: 'fetch_logs', threshold: 50_000 },   // higher threshold
      { name: 'big_query', tailChars: 5000 },      // bigger tail
    ],
  },
})
```

The lookup key is the tool's name — read from `ModelMessage.name` when set, otherwise resolved from the preceding assistant turn's `toolCalls[].function.name` via `toolCallId`. This fallback is what makes `perTool` work for the canonical `chat()` flow, where `convertMessagesToModelMessages` constructs tool messages without `name`. Wildcards are not supported, and `storage` cannot be overridden per-tool. `perTool` only affects the truncate step itself — a preserved message may still be dropped by `compact`, summarized by `compress` over the token budget, or rewritten by `transformContext`.

### Token Budget Tracking

The middleware's `onUsage` hook automatically extracts `promptTokens` from each model iteration and feeds it back to the compression engine. No manual tracking needed.

### Conversation Isolation

Compression state (fed token usage, compression suppression, the failure circuit breaker) is tracked per `ctx.threadId`, so one middleware instance safely serves many conversations. Pass a `threadId` to `chat()` (`conversationId` is a deprecated alias that also works); calls without one get an auto-generated per-run id — isolated within the run, but with no cross-call continuity, so pass an explicit `threadId` for multi-turn conversations. Up to `maxSessions` conversations are tracked concurrently (default 256, LRU-evicted); an evicted conversation is transparently recreated on next access, losing only its fed token usage.

### Compact (Mechanical Pruning)

Zero-LLM-cost message pruning — removes reasoning, tool call/result pairs, and empty messages before compression. Mirrors the AI SDK middleware's `CompactConfig` (AI SDK `pruneMessages` semantics):

```typescript
contextChefMiddleware({
  compact: {
    reasoning: 'all',                 // strip thinking arrays
    toolCalls: 'before-last-message', // keep tools referenced by the last message
    emptyMessages: 'remove',          // strip empty messages (default)
  },
})
```

Available `toolCalls` modes:
- `'all'` — remove all tool call/result pairs
- `'before-last-message'` — keep only tool pairs referenced by the last message
- `'before-last-${N}-messages'` — keep tool pairs referenced by the last N messages
- `'none'` (default) — keep everything
- Array form for per-tool control: `[{ type: 'all', tools: ['search'] }]` prunes only the named tools

"Last N messages" counts messages of the whole array (any role); tool calls/results referenced from inside that window are kept everywhere.

`emptyMessages: 'remove'` never drops `role: 'tool'` messages — an empty string is a valid tool result, and removing one would orphan the assistant tool call that references it.

### Clear (Placeholder-Style)

`clear` replaces content instead of deleting messages, keeping structure and tool-call pairing intact. It runs AFTER compression, so the summarizer still sees full content:

```typescript
contextChefMiddleware({
  clear: [
    { target: 'tool-result', keepRecent: 2 }, // older results → '[Old tool result content cleared]'
    'thinking',                               // strip reasoning from assistant messages
  ],
})
```

When tool results are targeted, an explainer instruction is auto-appended to `systemPrompts` so the model doesn't read the placeholder as an error.

### Dynamic State Injection

Inject runtime state (agent step, task progress, etc.) as XML into the prompt on every model invocation:

```typescript
contextChefMiddleware({
  dynamicState: {
    getState: () => ({ step: 3, status: 'researching', pendingTools: ['search'] }),
    placement: 'last_user', // or 'system'
  },
})
```

State is serialized to XML and injected into the last user message (leveraging recency bias) or as a system prompt. `getState` is called at init and at every agent iteration; the previously injected block is **replaced**, never duplicated.

### Skill Injection

```typescript
contextChefMiddleware({
  skill: () => activeSkill, // Skill | null | undefined, sync or async
})
```

The active skill's instructions are appended to `systemPrompts` after user prompts (idempotent across iterations). `skill.allowedTools` is annotation only — not enforced.

### Transform Context Hook

Custom post-processing for RAG injection, prompt manipulation, or other transformations:

```typescript
contextChefMiddleware({
  transformContext: (messages, systemPrompts, ctx) => ({
    messages: [...messages, { role: 'user', content: ragContext }],
    systemPrompts: [...systemPrompts, 'Use the RAG context above.'],
  }),
})
```

`transformContext` runs on every `onConfig` firing (init + each agent iteration) and its output carries into the next firing — make it idempotent, or gate on `ctx.phase === 'init'`.

### Never Breaks the Host Run

In `@tanstack/ai` 0.44, a middleware hook that throws fails the whole `chat()` run. This middleware wraps every hook body: on an unexpected error it logs through the configured `logger` and passes the request through unchanged instead of breaking your call.

## Durable Compaction

The middleware compresses the engine's in-flight state — your own message store is untouched, so a sustained over-budget conversation re-expands every call (the middleware warns after repeated compressions without `onCompress`). When you own the store, compact durably between calls:

```typescript
import { compactTanStackMessages } from '@context-chef/tanstack-ai';
import { openaiText } from '@tanstack/ai-openai';

// Between chat() calls:
const compacted = await compactTanStackMessages(storedMessages, openaiText('gpt-4o-mini'), {
  keepRecentTurns: 6,
});
if (compacted !== storedMessages) {
  await store.replaceMessages(conversationId, compacted); // persist [summary, ...kept]
}
```

- `planCompactionTanStackMessages(messages, { keepRecentTurns })` — turn-safe split into `{ toSummarize, toKeep }` (no `system` slice: TanStack AI keeps system prompts outside `messages`).
- `compactTanStackMessages(messages, adapter, options)` — one-shot: plan, summarize, return `[<summary>, ...toKeep]`. Returns the input reference unchanged on a no-op.
- `summarizeTanStackMessages(messages, adapter, opts?)` — just the summary string, using the same pipeline as `compress`.

A "turn" is one user/assistant message, or an assistant with its tool-calls plus all their tool results — the split never orphans a tool result. Don't combine durable compaction with middleware `compress` on the same conversation (double compression).

## API

### `contextChefMiddleware(options)`

Creates a `ChatMiddleware` that plugs into TanStack AI's `chat()` middleware array.

**Parameters:**

| Option | Type | Required | Description |
|---|---|---|---|
| `contextWindow` | `number` | Only with compression | Model's context window size in tokens. Required when `compress` / `onCompress` / `onBeforeCompress` is configured (throws otherwise); unused for other configurations. |
| `compress` | `CompressOptions` | No | Enable LLM-based compression |
| `compress.adapter` | `AnyTextAdapter` | Yes (if compress) | Cheap adapter for summarization |
| `compress.preserveRatio` | `number` | No | Ratio of context to preserve (default: `0.8`) |
| `compress.triggerRatio` | `number` | No | Fraction of `contextWindow` at which compression triggers (default: `0.7`, "pre-rot"). Set `1` to restore pre-4.0 trigger-at-window timing. In the tokenizer path, `preserveRatio` applies to the effective budget `contextWindow * triggerRatio`. |
| `compress.minShrinkRatio` | `number` | No | Minimum shrink of the compressed span's char length for a summary to be accepted (default: `0.5`). A failing summary counts as a failed compression: history unchanged, counts toward the circuit breaker. `0` disables the check. |
| `compress.toolResultStubThreshold` | `number` | No | Replace tool-result content longer than this many chars with a one-line metadata stub before sending the to-be-summarized history to the compression model. Recent (preserved) tool results untouched. Default: undefined (disabled). |
| `compress.usagePreference` | `'max' \| 'feedFirst' \| 'tokenizerFirst'` | No | Which token source drives the trigger when both `tokenizer` and reported usage are available. Default `'max'` (most conservative). `'tokenizerFirst'` requires `tokenizer` — sanitized to `'max'` with a warning otherwise. |
| `truncate` | `TruncateOptions` | No | Enable tool result truncation |
| `truncate.threshold` | `number` | Yes (if truncate) | Character count to trigger truncation |
| `truncate.headChars` | `number` | No | Characters to preserve from start (default: `0`) |
| `truncate.tailChars` | `number` | No | Characters to preserve from end (default: `1000`) |
| `truncate.storage` | `VFSStorageAdapter` | No | Storage adapter to persist original content |
| `truncate.perTool` | `Array<string \| { name; threshold?; headChars?; tailChars? }>` | No | Per-tool overrides. Bare string = preserve (and bypass storage); object = override params for that tool. Last entry wins on duplicates. |
| `compact` | `CompactConfig` | No | Mechanical pruning of reasoning, tool calls, and empty messages (`reasoning` / `toolCalls` incl. per-tool array form / `emptyMessages`) |
| `clear` | `ClearTarget[]` | No | Placeholder-style clearing. `'tool-result'` targets become `'[Old tool result content cleared]'` (+ auto explainer prompt); `'thinking'` strips reasoning. Runs AFTER compression. `ClearTarget` is exported from `@context-chef/core`. |
| `dynamicState` | `DynamicStateConfig` | No | Runtime state injection as XML (replaced per iteration, never duplicated) |
| `skill` | `Skill \| () => Skill \| null \| undefined` | No | Inject the active skill's instructions as a system prompt (idempotent) |
| `tokenizer` | `(msgs) => number` | No | Custom tokenizer for precise counting |
| `maxSessions` | `number` | No | Cap on concurrently tracked conversations (default: 256, LRU-evicted) |
| `onCompress` | `(summary, count, details) => void` | No | Hook called after compression. `details.compressedMessages` is the TanStack-format (`ModelMessage[]`) slice the summary replaced — use it to persist the summary boundary in your store. |
| `onBeforeCompress` | `(history, tokenInfo) => msgs \| null` | No | Hook before compression with override capability |
| `transformContext` | `(msgs, prompts, ctx) => { messages, systemPrompts }` | No | Post-compression transformation. Runs per iteration — must be idempotent. |
| `logger` | `ChefLogger` | No | Sink for degradation warnings; defaults to `console`. |

**Returns:** `ChatMiddleware` — plug directly into the `middleware` array of `chat()`.

### `fromTanStackAI(messages)` / `toTanStackAI(messages)`

Low-level converters between TanStack AI `ModelMessage[]` (0.44 shape) and context-chef `Message[]` IR. Useful if you want to use context-chef modules directly with TanStack AI message formats.

```typescript
import { fromTanStackAI, toTanStackAI } from '@context-chef/tanstack-ai';

const irMessages = fromTanStackAI(tanstackMessages);
// ... process with context-chef modules ...
const backToTanStack = toTanStackAI(irMessages);
```

Mapping notes:
- `thinking: Array<{content, signature?}>` projects to a single IR `thinking` (contents joined with `\n`, first element's signature); the full array round-trips losslessly via a pass-through reference whenever the pipeline doesn't modify or clear it.
- Media content parts (image/audio/video/document) project to IR `attachments` as a presence signal; the real parts round-trip untouched on unmodified messages.
- Tool-call `metadata`, message `id`, and `createdAt` are preserved on round-trip; rebuilding a *modified* tool-call list drops `metadata`.
- There is no `system` role in TanStack `ModelMessage` — system prompts travel via `chat({ systemPrompts })` and are transformed (with object-form `{ content, metadata }` entries preserved) without passing through the adapter.

### `createCompressionAdapter(adapter)`

Adapts any TanStack AI text adapter into the `(messages) => Promise<string>` callback core's Janitor and `summarizeHistory` expect (role-flattening included). Used internally by `compress` and the durable-compaction helpers.

## How It Works

```
chat({ adapter, messages, systemPrompts, threadId, middleware: [contextChefMiddleware(opts)] })
  |
  v
onConfig (phase 'init', then 'beforeModel' at every agent iteration)
  1. Truncate large tool results (if configured)
  2. Convert TanStack AI messages -> context-chef IR
  3. Compact: strip reasoning / tool pairs / empty messages (zero cost)
  4. Janitor compression (if over token budget; budgeting configs only)
  5. Clear: placeholder old tool results / strip thinking (if configured)
  6. Convert back to TanStack AI messages
  7. Inject skill instructions + clear explainer into systemPrompts (idempotent)
  8. Inject dynamic state (replaced per iteration)
  9. Apply transformContext hook
  -> return { messages, systemPrompts }  (engine merges the partial config)
  |
  v
model iteration executes normally
  |
  v
onUsage (after each model iteration)
  10. Extract promptTokens from usage
  11. Feed back to the conversation's Janitor for the next budget check
```

The middleware is **stateful** — it tracks token usage per `ctx.threadId` across calls to know when compression is needed. One middleware instance serves many conversations safely.

## Need More Control?

The middleware covers the most common use case: transparent compression and truncation. For advanced features like tool namespaces, core memory, or snapshot/restore, use [`@context-chef/core`](https://www.npmjs.com/package/@context-chef/core) directly.

## License

MIT
