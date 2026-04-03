# @context-chef/ai-sdk-middleware

[![npm version](https://img.shields.io/npm/v/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![License](https://img.shields.io/npm/l/@context-chef/ai-sdk-middleware.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v6-black.svg)](https://ai-sdk.dev)

[Vercel AI SDK](https://ai-sdk.dev) middleware powered by [context-chef](https://github.com/MyPrototypeWhat/context-chef). Transparent history compression, tool result truncation, and token budget management — zero code changes required.

## Installation

```bash
npm install @context-chef/ai-sdk-middleware ai
```

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

// Everything below stays exactly the same — works with generateText and streamText
const result = await generateText({
  model,
  messages: conversationHistory,
  tools: myTools,
});
```

That's it. History compression, tool result truncation, and token budget tracking happen automatically behind the scenes.

## Features

### History Compression

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

### Tool Result Truncation

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

Optionally persist the original content via a storage adapter so the LLM can retrieve it later via a `context://vfs/` URI:

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

### Token Budget Tracking

The middleware automatically extracts token usage from `generateText` and `streamText` responses and feeds it back to the compression engine. No manual `reportTokenUsage()` calls needed.

### Compact (Mechanical Clearing)

Zero-LLM-cost content clearing for thinking blocks and tool results:

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compact: {
    clear: ['thinking', { target: 'tool-result', keepRecent: 5 }],
  },
});
```

> **Important: compact + compress interaction**
>
> When using `compact` together with `compress`, only clear `thinking` in compact:
>
> ```typescript
> const model = withContextChef(openai('gpt-4o'), {
>   contextWindow: 128_000,
>   compact: { clear: ['thinking'] },                // thinking only
>   compress: { model: openai('gpt-4o-mini') },
> });
> ```
>
> Clearing `tool-result` before compression causes the compression model to receive
> empty placeholders instead of actual tool outputs, producing low-quality summaries.
> Compression's turn-based splitting already manages history length — use `compact`
> for `tool-result` clearing only when `compress` is **not** configured.

## API

### `withContextChef(model, options)`

Wraps an AI SDK language model with context-chef middleware.

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';

const wrappedModel = withContextChef(model, options);
```

**Parameters:**

| Option | Type | Required | Description |
|---|---|---|---|
| `contextWindow` | `number` | Yes | Model's context window size in tokens |
| `compress` | `CompressOptions` | No | Enable LLM-based compression |
| `compress.model` | `LanguageModelV3` | Yes (if compress) | Cheap model for summarization |
| `compress.preserveRatio` | `number` | No | Ratio of context to preserve (default: `0.8`) |
| `truncate` | `TruncateOptions` | No | Enable tool result truncation |
| `truncate.threshold` | `number` | Yes (if truncate) | Character count to trigger truncation |
| `truncate.headChars` | `number` | No | Characters to preserve from start (default: `0`) |
| `truncate.tailChars` | `number` | No | Characters to preserve from end (default: `1000`) |
| `truncate.storage` | `VFSStorageAdapter` | No | Storage adapter to persist original content before truncation |
| `compact` | `CompactConfig` | No | Mechanical content clearing (thinking, tool-result). When combined with `compress`, use `clear: ['thinking']` only |
| `tokenizer` | `(msgs) => number` | No | Custom tokenizer for precise counting |
| `onCompress` | `(summary, count) => void` | No | Hook called after compression |

**Returns:** `LanguageModelV3` — a wrapped model that can be used anywhere the original model was used.

### `createMiddleware(options)`

Creates a raw `LanguageModelMiddleware` if you want to apply it yourself via `wrapLanguageModel`:

```typescript
import { createMiddleware } from '@context-chef/ai-sdk-middleware';
import { wrapLanguageModel } from 'ai';

const middleware = createMiddleware({ contextWindow: 128_000 });
const model = wrapLanguageModel({ model: openai('gpt-4o'), middleware });
```

### `fromAISDK(prompt)` / `toAISDK(messages)`

Low-level converters between AI SDK `LanguageModelV3Prompt` and context-chef `Message[]` IR. Useful if you want to use context-chef modules directly with AI SDK message formats.

```typescript
import { fromAISDK, toAISDK } from '@context-chef/ai-sdk-middleware';

const irMessages = fromAISDK(aiSdkPrompt);
// ... process with context-chef modules ...
const aiSdkPrompt = toAISDK(irMessages);
```

## How It Works

```
generateText / streamText ({ model: wrappedModel, messages })
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

The middleware is **stateful** — it tracks token usage across calls to know when compression is needed. Create one wrapped model per conversation/session.

## Need More Control?

The middleware covers the most common use case: transparent compression and truncation. For advanced features like dynamic state injection, tool namespaces, memory, or snapshot/restore, use [`@context-chef/core`](https://www.npmjs.com/package/@context-chef/core) directly.

## License

ISC
