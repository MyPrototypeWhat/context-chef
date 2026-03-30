# @context-chef/ai-sdk-middleware API Reference

## Exports

### `withContextChef(model, options): LanguageModelV3`

Wraps an AI SDK language model with context-chef middleware. Returns a standard `LanguageModelV3` that can be used anywhere the original model was used.

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
const wrappedModel = withContextChef(openai('gpt-4o'), options);
```

### `createMiddleware(options): LanguageModelMiddleware`

Creates a raw `LanguageModelMiddleware` for use with `wrapLanguageModel` directly.

```typescript
import { createMiddleware } from '@context-chef/ai-sdk-middleware';
import { wrapLanguageModel } from 'ai';
const middleware = createMiddleware(options);
const model = wrapLanguageModel({ model: openai('gpt-4o'), middleware });
```

### `fromAISDK(prompt): AISDKMessage[]`

Converts an AI SDK `LanguageModelV3Prompt` to context-chef `Message[]` IR. Original AI SDK content is stored in per-role fields for lossless round-trip.

### `toAISDK(messages): LanguageModelV3Prompt`

Converts context-chef `Message[]` IR back to AI SDK `LanguageModelV3Prompt`. Uses original content when unmodified; falls back to constructing from IR fields when content was modified by Janitor.

---

## `ContextChefOptions`

The main configuration object passed to `withContextChef()` or `createMiddleware()`.

| Option | Type | Required | Description |
|---|---|---|---|
| `contextWindow` | `number` | Yes | The model's context window size in tokens |
| `compress` | `CompressOptions` | No | Enable LLM-based history compression |
| `truncate` | `TruncateOptions` | No | Enable tool result truncation |
| `compact` | `CompactConfig` | No | Mechanical compaction before LLM compression |
| `dynamicState` | `DynamicStateConfig` | No | Dynamic state injection into prompt |
| `tokenizer` | `(msgs: unknown[]) => number` | No | Custom tokenizer for precise token counting |
| `onCompress` | `(summary: string, count: number) => void` | No | Hook called after compression occurs |
| `onBudgetExceeded` | `(history, tokenInfo) => Message[] \| null \| Promise<...>` | No | Hook called when token budget is exceeded |
| `transformContext` | `(prompt) => LanguageModelV3Prompt \| Promise<...>` | No | Transform prompt after compression, before model |

---

## `CompressOptions`

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `LanguageModelV3` | Yes | A cheap model for summarization (e.g. `openai('gpt-4o-mini')`) |
| `preserveRatio` | `number` | No | Ratio of context window to preserve for recent messages. Default: `0.8` |

---

## `TruncateOptions`

| Field | Type | Required | Description |
|---|---|---|---|
| `threshold` | `number` | Yes | Character count to trigger truncation |
| `headChars` | `number` | No | Characters to preserve from start. Default: `0` |
| `tailChars` | `number` | No | Characters to preserve from end. Default: `1000` |
| `storage` | `VFSStorageAdapter` | No | Storage adapter for persisting originals before truncation. Provides `context://vfs/` URI for retrieval. |

---

## `CompactConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `clear` | `ClearTarget[]` | Yes | Content types to clear. Values: `'tool-result'`, `'thinking'` |

---

## `DynamicStateConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `getState` | `() => Record<string, unknown> \| Promise<...>` | Yes | Returns the current state object. Called on every model invocation. |
| `placement` | `'last_user' \| 'system'` | No | Where to inject state. `'last_user'` (default) appends to last user message for recency bias. `'system'` adds as standalone system message. |

---

## Processing Pipeline

The middleware processes the prompt in this order on every `generateText` / `streamText` call:

```
1. truncate    → Truncate large tool results (if configured)
2. fromAISDK   → Convert AI SDK prompt to context-chef IR
3. compact     → Mechanical compaction (if configured, zero LLM cost)
4. compress    → LLM-based compression (if over token budget)
5. toAISDK     → Convert back to AI SDK format
6. dynamicState → Inject state XML (if configured)
7. transformContext → Custom transform hook (if configured)
```

After the LLM responds, `wrapGenerate` / `wrapStream` extracts `usage.inputTokens.total` and feeds it back to the Janitor for the next call's budget check.
