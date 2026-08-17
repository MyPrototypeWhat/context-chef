# @context-chef/ai-sdk-middleware

[Vercel AI SDK](https://ai-sdk.dev) middleware powered by ContextChef — transparent history compression, tool result truncation, and token budget management with zero code changes.

[![npm version](https://img.shields.io/npm/v/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)

## Installation

```bash
npm install @context-chef/ai-sdk-middleware ai
```

> **AI SDK version.** `3.x` targets **AI SDK v7** (`ai@>=7`). Still on AI SDK v6? Use `@context-chef/ai-sdk-middleware@1` — the `1.x` line supports `ai@6`.

## Quick Start

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
});

// Everything below stays exactly the same — works with generateText, streamText, and ToolLoopAgent
const result = await generateText({
  model,
  messages: conversationHistory,
  tools: myTools,
});
```

That's it. History compression, tool result truncation, and token budget tracking happen automatically behind the scenes.

## History Compression

When the conversation exceeds the token budget, the middleware compresses older messages to make room. Two modes:

**Without a compression model** (default) — old messages are discarded, only recent messages are kept:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
});
```

**With a compression model** — old messages are summarized by a cheap model before being replaced:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: {
    model: openai('gpt-4o-mini'),  // cheap model for summarization
    preserveRatio: 0.8,             // keep 80% of context for recent messages
  },
});
```

> **In-flight vs durable.** Middleware `compress` is *in-flight*: it rewrites each outgoing request but does **not** mutate your message store. So for a *sustained* over-budget conversation the summary is discarded each call and the history re-expands. For a one-off spike that's fine; for sustained use, **persist** the summary via `onCompress`, or compact your own store with `compactModelMessages` (recommended — see [Durable Compaction](/guide/durable-compaction)). The middleware logs a one-time warning if `compress` keeps firing without `onCompress`.

## Anthropic Server-Side Context Management

`@ai-sdk/anthropic` can hand context management to the Anthropic API itself via `providerOptions.anthropic.contextManagement` (edits such as `compact_20260112`, `clear_tool_uses_20250919`, `clear_thinking_20251015`). If a call declares that option **and** this middleware has compression configured, the same history would be managed twice — once here, once again on the server.

The middleware detects this per call and **skips its own compression step** (server wins), logging a one-time warning. `truncate`, `compact`, `clear`, `dynamicState`, and `skill` still run — only the compression step yields.

To intentionally run both — e.g. middleware compression tuned to fire well below the server-side trigger — disable the guard:

```typescript
const model = withContextChef(anthropic('claude-sonnet-4-6'), {
  contextWindow: 200_000,
  compress: { model: anthropic('claude-haiku-4-5') },
  allowDoubleCompression: true, // skip the guard: no skip, no warning
});
```

## Tool Result Truncation

Large tool outputs (terminal logs, API responses) are automatically truncated while preserving the head and tail:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
  },
});
```

Optionally persist the original content via a storage adapter so it can be retrieved later:

```typescript
import { FileSystemAdapter } from '@context-chef/core';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    headChars: 500,
    tailChars: 1000,
    storage: new FileSystemAdapter('.context_vfs'), // or your own DB adapter
  },
});
```

When the adapter exposes a physical path (`FileSystemAdapter` does, via `getPhysicalPath`), the truncation marker advertises that path as the primary retrieval handle — the model can read it back with its standard file-read tool. Adapters that don't map to a filesystem fall back to the `context://vfs/` URI alone.

Per-tool overrides via `perTool` — bare strings preserve a tool entirely (storage is also bypassed), object entries override `threshold` / `headChars` / `tailChars` for that one tool:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    tailChars: 1000,
    perTool: [
      'read_file',                                 // never truncate; not stored in VFS
      { name: 'fetch_logs', threshold: 50_000 },   // higher threshold
      { name: 'big_query', tailChars: 5000 },      // bigger tail
    ],
  },
});
```

## Session Isolation (Multi-User Servers)

A wrapped model is usually created once at module scope and reused across requests. Compression state (fed token usage, compression suppression, the failure circuit breaker) is tracked per **session** — pass a `sessionId` through `providerOptions` on each call so concurrent conversations never share state:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
});

// Per request:
const result = await generateText({
  model,
  messages,
  providerOptions: { contextChef: { sessionId: conversationId } },
});
```

Calls without a `sessionId` share one default session — fine for single-conversation processes, wrong for multi-user servers. Up to `maxSessions` sessions are tracked concurrently (default 256, LRU-evicted).

## Compact (Mechanical Pruning)

Zero-LLM-cost message pruning via AI SDK's `pruneMessages` — removes reasoning, tool calls, and empty messages:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compact: {
    reasoning: 'all',                          // Remove all reasoning
    toolCalls: 'before-last-message',          // Keep tools only in the last message
  },
});
```

## API surface

| Export | What it does |
|---|---|
| `withContextChef(model, options)` | Wraps an AI SDK model; returns a `LanguageModelV3` usable anywhere the original was |
| `createMiddleware(options)` | Raw `LanguageModelMiddleware` for `wrapLanguageModel` |
| `fromAISDK(prompt)` / `toAISDK(messages)` | Converters between `LanguageModelV3Prompt` and ContextChef IR |
| `summarizeMessages(prompt, model, opts?)` | Summarize an AI-SDK prompt slice (role-flattening included) |
| `compactModelMessages(messages, model, opts)` | Durable compaction in one call at the `ModelMessage` altitude |
| `planCompactionModelMessages(messages, opts)` | The synchronous turn-safe split behind it |
| `summarizeModelMessages(messages, model, opts?)` | `ModelMessage`-altitude summarizer |

Key `withContextChef` options: `contextWindow` (required), `compress` (`model`, `preserveRatio`, `toolResultStubThreshold`, `usagePreference`), `allowDoubleCompression`, `truncate` (`threshold`, `headChars`, `tailChars`, `storage`, `perTool`), `compact`, `clear`, `tokenizer`, `onCompress`, `logger`. See the [full README on GitHub](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/ai-sdk-middleware) for the complete option tables.

## How It Works

```
generateText / streamText / ToolLoopAgent ({ model: wrappedModel, messages })
  |
  v
transformParams (before LLM call)
  1. Truncate large tool results (if configured)
     - Optionally persist originals to storage adapter
  2. Convert AI SDK messages -> context-chef IR
  3. Run Janitor compression (if over token budget)
  4. Convert back to AI SDK messages
  |
  v
LLM call executes normally
  |
  v
wrapGenerate / wrapStream (after LLM call)
  5. Extract token usage from response
  6. Feed back to Janitor for next call's budget check
  |
  v
Result returned unchanged
```

The middleware is **stateful** — it tracks token usage across calls to know when compression is needed.

## Need more control?

For dynamic state injection, tool namespaces, memory, or snapshot/restore, use [`@context-chef/core`](/packages/core) directly.

## Links

- [npm — @context-chef/ai-sdk-middleware](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
- [Source & full README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/ai-sdk-middleware)
