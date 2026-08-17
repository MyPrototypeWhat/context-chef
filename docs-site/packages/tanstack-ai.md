# @context-chef/tanstack-ai

[TanStack AI](https://tanstack.com/ai) `ChatMiddleware` powered by ContextChef — transparent history compression, tool result truncation, and token budget management, dropped in as a single middleware.

[![npm version](https://img.shields.io/npm/v/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)

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

## Features

### History Compression

When the conversation exceeds the token budget, the middleware compresses older messages to make room. `contextWindow` is **required** whenever a compression option (`compress`, `onCompress`, `onBeforeCompress`) is configured; configurations without one don't need it.

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  compress: {
    adapter: openaiText('gpt-4o-mini'), // cheap adapter for summarization
    preserveRatio: 0.8,                 // keep 80% of context for recent messages
  },
})
```

### Tool Result Truncation

```typescript
contextChefMiddleware({
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
    // storage: new FileSystemAdapter('.context_vfs'),
    perTool: [
      'read_file',                                 // never truncate; not stored in VFS
      { name: 'fetch_logs', threshold: 50_000 },   // higher threshold
    ],
  },
})
```

The per-tool lookup key is the tool's name — read from `ModelMessage.name` when set, otherwise resolved from the preceding assistant turn's `toolCalls[].function.name` via `toolCallId`, which is what makes `perTool` work for the canonical `chat()` flow.

### Conversation Isolation

Compression state (fed token usage, compression suppression, the failure circuit breaker) is tracked per `ctx.threadId`, so one middleware instance safely serves many conversations. Pass a `threadId` to `chat()` (`conversationId` is a deprecated alias); calls without one get an auto-generated per-run id — isolated within the run, but with no cross-call continuity. Up to `maxSessions` conversations are tracked concurrently (default 256, LRU-evicted).

### Compact (Mechanical Pruning)

Zero-LLM-cost message pruning — removes reasoning, tool call/result pairs, and empty messages before compression (AI SDK `pruneMessages` semantics):

```typescript
contextChefMiddleware({
  compact: {
    reasoning: 'all',                 // strip thinking arrays
    toolCalls: 'before-last-message', // keep tools referenced by the last message
    emptyMessages: 'remove',          // strip empty messages (default)
  },
})
```

`toolCalls` modes: `'all'`, `'before-last-message'`, `'before-last-${N}-messages'`, `'none'` (default), or the array form `[{ type: 'all', tools: ['search'] }]` for per-tool control.

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

### Transform Context Hook

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

The middleware compresses the engine's in-flight state — your own message store is untouched. When you own the store, compact durably between calls:

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

- `planCompactionTanStackMessages(messages, { keepRecentTurns })` — turn-safe split into `{ toSummarize, toKeep }`.
- `compactTanStackMessages(messages, adapter, options)` — one-shot: plan, summarize, return `[<summary>, ...toKeep]`. Returns the input reference unchanged on a no-op.
- `summarizeTanStackMessages(messages, adapter, opts?)` — just the summary string.

Don't combine durable compaction with middleware `compress` on the same conversation (double compression). See [Durable Compaction](/guide/durable-compaction).

## API surface

| Export | What it does |
|---|---|
| `contextChefMiddleware(options)` | Creates a `ChatMiddleware` for `chat()`'s middleware array |
| `fromTanStackAI(messages)` / `toTanStackAI(messages)` | Converters between TanStack AI `ModelMessage[]` (0.44 shape) and ContextChef IR |
| `createCompressionAdapter(adapter)` | Adapts any TanStack text adapter into the `(messages) => Promise<string>` callback core expects |
| `compactTanStackMessages` / `planCompactionTanStackMessages` / `summarizeTanStackMessages` | Durable compaction helpers |

Key `contextChefMiddleware` options: `contextWindow` (required only with compression), `compress` (`adapter`, `preserveRatio`, `toolResultStubThreshold`, `usagePreference`), `truncate`, `compact`, `clear`, `dynamicState`, `skill`, `tokenizer`, `maxSessions`, `onCompress`, `onBeforeCompress`, `transformContext`, `logger`. See the [full README on GitHub](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/tanstack-ai) for the complete option tables.

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

## Need more control?

For tool namespaces, core memory, or snapshot/restore, use [`@context-chef/core`](/packages/core) directly.

## Links

- [npm — @context-chef/tanstack-ai](https://www.npmjs.com/package/@context-chef/tanstack-ai)
- [Source & full README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/tanstack-ai)
