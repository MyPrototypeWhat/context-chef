# @context-chef/tanstack-ai

[![npm version](https://img.shields.io/npm/v/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/tanstack-ai.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![TanStack AI](https://img.shields.io/badge/TanStack%20AI-v0.10-ff4154.svg)](https://tanstack.com/ai)

[TanStack AI](https://tanstack.com/ai) middleware powered by [context-chef](https://github.com/MyPrototypeWhat/context-chef). Transparent history compression, tool result truncation, and token budget management — drop in as a single middleware.

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

When the conversation exceeds the token budget, the middleware compresses older messages to make room. Two modes:

**Without a compression model** (default) — old messages are discarded, only recent messages are kept:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
})
```

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

### Tool Result Truncation

Large tool outputs (terminal logs, API responses) are automatically truncated while preserving the head and tail:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
  },
})
```

Optionally persist the original content via a storage adapter so the LLM can retrieve it later via a `context://vfs/` URI:

```typescript
import { FileSystemAdapter } from '@context-chef/core';

contextChefMiddleware({
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    headChars: 500,
    tailChars: 1000,
    storage: new FileSystemAdapter('.context_vfs'), // or your own DB adapter
  },
})
```

### Token Budget Tracking

The middleware automatically extracts token usage from `onUsage` callbacks and feeds it back to the compression engine. No manual tracking needed.

### Compact (Mechanical Pruning)

Zero-LLM-cost message pruning — removes tool call/result pairs and empty messages before compression:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  compact: {
    toolCalls: 'before-last-message', // keep tools only in the last assistant turn
    emptyMessages: 'remove',          // strip empty messages
  },
})
```

Available `toolCalls` modes:
- `'all'` — remove all tool call/result pairs
- `'before-last-message'` — keep only the last assistant's tool calls
- `'before-last-${N}-messages'` — keep the last N assistants' tool calls
- `'none'` (default) — keep everything

### Dynamic State Injection

Inject runtime state (agent step, task progress, etc.) as XML into the prompt on every call:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  dynamicState: {
    getState: () => ({ step: 3, status: 'researching', pendingTools: ['search'] }),
    placement: 'last_user', // or 'system'
  },
})
```

State is automatically serialized to XML and injected into the last user message (leveraging recency bias) or as a system prompt.

### Transform Context Hook

Custom post-processing for RAG injection, prompt manipulation, or other transformations:

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  transformContext: (messages, systemPrompts) => ({
    messages: [...messages, { role: 'user', content: ragContext }],
    systemPrompts: [...systemPrompts, 'Use the RAG context above.'],
  }),
})
```

## API

### `contextChefMiddleware(options)`

Creates a `ChatMiddleware` that plugs into TanStack AI's `chat()` middleware array.

**Parameters:**

| Option | Type | Required | Description |
|---|---|---|---|
| `contextWindow` | `number` | Yes | Model's context window size in tokens |
| `compress` | `CompressOptions` | No | Enable LLM-based compression |
| `compress.adapter` | `AnyTextAdapter` | Yes (if compress) | Cheap adapter for summarization |
| `compress.preserveRatio` | `number` | No | Ratio of context to preserve (default: `0.8`) |
| `truncate` | `TruncateOptions` | No | Enable tool result truncation |
| `truncate.threshold` | `number` | Yes (if truncate) | Character count to trigger truncation |
| `truncate.headChars` | `number` | No | Characters to preserve from start (default: `0`) |
| `truncate.tailChars` | `number` | No | Characters to preserve from end (default: `1000`) |
| `truncate.storage` | `VFSStorageAdapter` | No | Storage adapter to persist original content |
| `compact` | `CompactConfig` | No | Mechanical pruning of tool calls and empty messages |
| `dynamicState` | `DynamicStateConfig` | No | Runtime state injection as XML |
| `tokenizer` | `(msgs) => number` | No | Custom tokenizer for precise counting |
| `onCompress` | `(summary, count) => void` | No | Hook called after compression |
| `onBeforeCompress` | `(history, tokenInfo) => msgs \| null` | No | Hook before compression with override capability |
| `transformContext` | `(msgs, prompts) => { msgs, prompts }` | No | Post-compression prompt transformation |

**Returns:** `ChatMiddleware` — plug directly into the `middleware` array of `chat()`.

### `fromTanStackAI(messages)` / `toTanStackAI(messages)`

Low-level converters between TanStack AI `ModelMessage[]` and context-chef `Message[]` IR. Useful if you want to use context-chef modules directly with TanStack AI message formats.

```typescript
import { fromTanStackAI, toTanStackAI } from '@context-chef/tanstack-ai';

const irMessages = fromTanStackAI(tanstackMessages);
// ... process with context-chef modules ...
const tanstackMessages = toTanStackAI(irMessages);
```

## How It Works

```
chat({ adapter, messages, middleware: [contextChefMiddleware(opts)] })
  |
  v
onConfig (before each LLM call)
  1. Truncate large tool results (if configured)
  2. Convert TanStack AI messages -> context-chef IR
  3. Compact: strip tool call pairs & empty messages (zero cost)
  4. Janitor compression (if over token budget)
  5. Convert back to TanStack AI messages
  6. Inject dynamic state (if configured)
  7. Apply transformContext hook (if configured)
  |
  v
LLM call executes normally
  |
  v
onUsage (after LLM response)
  8. Extract promptTokens from response
  9. Feed back to Janitor for next call's budget check
  |
  v
Result returned unchanged
```

The middleware is **stateful** — it tracks token usage across calls to know when compression is needed. Create one middleware instance per conversation/session.

## Need More Control?

The middleware covers the most common use case: transparent compression and truncation. For advanced features like tool namespaces, core memory, or snapshot/restore, use [`@context-chef/core`](https://www.npmjs.com/package/@context-chef/core) directly.

## License

MIT
