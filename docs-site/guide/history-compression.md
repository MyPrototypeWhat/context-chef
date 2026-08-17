# History Compression (Janitor)

Janitor keeps a long conversation inside the model's context window: it watches token usage and, when the budget is exceeded, summarizes old messages with a cheap model while preserving the recent ones. This page covers the two compression paths, every `JanitorConfig` option, the v4 "pipeline v2" quality gates, and the zero-LLM-cost `compact()` utility.

Janitor provides two compression paths. Choose the one that fits your setup:

## Path 1: Tokenizer (precise control)

Provide your own token counting function for precise per-message calculation. Janitor preserves recent messages that fit within `contextWindow × preserveRatio` and compresses the rest.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8, // keep 80% of contextWindow for recent messages (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages — the exact slice of history the summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

## Path 2: reportTokenUsage (simple, no tokenizer needed)

Most LLM APIs return token usage in their response. Feed that value back — when it exceeds `contextWindow`, Janitor compresses everything except the last N messages.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    preserveRecentMessages: 1,       // keep last 1 message on compression (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

> **Note:** Without a `compressionModel`, old messages are discarded with no summary. A console warning is printed at construction time if neither `tokenizer` nor `compressionModel` is provided.

## `JanitorConfig`

| Option                          | Type                                        | Default    | Description                                                                                  |
| ------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `contextWindow`                 | `number`                                    | _required_ | Model's context window size (tokens). Compression triggers when usage exceeds `contextWindow × triggerRatio`. |
| `triggerRatio`                  | `number`                                    | `0.7`      | Fraction of `contextWindow` at which compression fires ("pre-rot"). Set `1` to restore the pre-4.0 trigger-at-window behavior. |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —          | Enables the tokenizer path for precise per-message token calculation.                        |
| `preserveRatio`                 | `number`                                    | `0.8`      | [Tokenizer path] Ratio of the effective budget (`contextWindow × triggerRatio`) to preserve for recent messages. |
| `preserveRecentMessages`        | `number`                                    | `1`        | [reportTokenUsage path] Number of recent turns to keep when compressing.                     |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`    | Which token source drives the trigger when both `tokenizer` and `reportTokenUsage` are set. Without `tokenizer`, the value union narrows to `'max' \| 'feedFirst'` — TypeScript rejects `'tokenizerFirst'` at compile time. |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —          | Async hook to summarize old messages via a low-cost LLM.                                     |
| `customCompressionInstructions` | `string`                                    | —          | Additional focused instructions appended to the default compression prompt (additive, not replacement). |
| `compressionGuidelines`         | `string[]`                                  | —          | Numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`. |
| `toolResultStubThreshold`       | `number`                                    | —          | Replace tool-result content longer than this many chars with a one-line metadata stub before summarizing (saves summarizer tokens). |
| `minShrinkRatio`                | `number`                                    | `0.5`      | Quality gate: a summary must shrink the compressed span by at least this ratio (spans ≥ 2000 chars only); otherwise the compression fails and history is unchanged. `0` disables. |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | Post-summarization gate. Return `false` (or throw) to reject the summary — history unchanged, circuit breaker incremented. |
| `archive`                       | `CompressionArchiveConfig \| 'vfs'`         | —          | Reversible compression: store the full pre-compression span, cite its URI in the summary. See [Compression pipeline v2](#compression-pipeline-v2-v4). |
| `compressionMode`               | `'rewrite' \| 'incremental-anchored'`       | `'rewrite'`| Anchored mode keeps a persistent anchor document and merges only the newly evicted span into it on each compression. |
| `compressionScheduling`         | `'blocking' \| 'background'`                | `'blocking'` | Background mode runs summarization off-turn; the over-budget compile returns history unchanged and the result is swapped in later if still valid. |
| `onCompress`                    | `(summary, count, details) => void`         | —          | Fires after compression with the summary message and truncated count. `details.compressedMessages` is the exact slice of history the summary replaced. |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —          | Fires before LLM compression. Return modified history to intervene, or null to proceed normally. |
| `logger`                        | `ChefLogger`                                | —          | Sink for degradation warnings (storage/compaction); defaults to `console`. |

**Compression output contract.** Janitor's default prompt instructs the compression model to produce an `<analysis>` scratchpad (stripped from the final output) followed by a structured `<summary>` block with 5 domain-agnostic sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Raw output is piped through `Prompts.formatCompactSummary` before injection. See the [core package README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/core) for the full contract and `customCompressionInstructions` usage.

**Failure semantics (changed in 4.0).** A compression-model failure — a throw, a summary that fails `minShrinkRatio`, or a `validateCompression` rejection — leaves history **unchanged** (pre-4.0 truncated it with a placeholder) and increments the circuit breaker. If three consecutive `compress()` calls fail, `compress()` becomes a no-op until the next successful compression or an explicit `janitor.reset()` / `chef.clearHistory()`. The failure counter is preserved by `chef.snapshot()` / `chef.restore()`.

**Standalone summarization.** `summarizeHistory(messages, compress, opts?): Promise<string>` is the provider-agnostic primitive behind this path — call it directly to compress a slice in your own store. Empty slice → `''`; stateless and **throws** if `compress` throws; the `compress` callback **must role-flatten** `tool` roles. Options include `customCompressionInstructions`, `toolResultStubThreshold`, `compressionGuidelines`, and `baseInstruction`. See [Durable compaction](/guide/durable-compaction) for the higher-level helpers.

## Compression pipeline v2 (v4)

v4 rebuilds the compression path around one rule: a bad summary must never replace good history.

- **Pre-rot trigger — `triggerRatio` (default `0.7`)**: compression fires at `contextWindow × 0.7` instead of at the hard limit — model quality degrades well before the window is full. `preserveRatio` applies to this effective budget. `triggerRatio: 1` restores the pre-4.0 behavior.
- **Constraint pinning — `pinned: true`**: pinned messages survive `compress()` verbatim (re-inserted after the summary, in order) and are never cleared by `compact()`. Pinning any message of an atomic turn protects the whole turn. Use it for policy and constraint text — compaction that drops policy text raises violation rates from 0% to 30%+ (arXiv:2606.22528).
- **Shrink guard — `minShrinkRatio` (default `0.5`)**: a summary that doesn't shrink the compressed span by ≥ 50% (character length; spans ≥ 2000 chars only) is a failed compression — history unchanged, circuit breaker incremented. Prevents compression death loops. `0` disables.
- **`validateCompression`**: post-summarization gate `(summary, { compressed, kept }) => boolean | Promise<boolean>` — return `false` or throw to reject the result (history unchanged, breaker incremented).
- **Reversible archive — `archive`**: the compressed span is serialized and stored via `store(serialized, { messageCount }) => uri`, and the summary cites the URI, so exact details stay retrievable instead of being guessed at by importance scoring (arXiv:2607.25066, arXiv:2607.08032). `archive: 'vfs'` stores in the chef's VFS. Best-effort: a store failure logs a warning and skips the citation.
- **`compressionGuidelines`**: numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`.
- **Incremental-anchored mode — `compressionMode: 'incremental-anchored'`**: keeps a persistent anchor document; each compression merges only the newly evicted span into it instead of rewriting the whole summary (Factory.ai pattern). Read it via `janitor.getAnchorDoc()`; it is part of `JanitorSnapshot` and cleared by `reset()`.
- **Background scheduling — `compressionScheduling: 'background'`**: the first over-budget `compile()` returns history unchanged and starts summarization in the background; a later `compress()` swaps the result in only if the summarized span is still a prefix of the current history (stale results are discarded; `onCompress` fires at application time). Keeps compression latency off the hot path (arXiv:2605.08580). Background state is not snapshotted.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200_000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    triggerRatio: 0.7,       // default — compress "pre-rot"
    minShrinkRatio: 0.5,     // default — reject summaries that barely shrink
    archive: "vfs",          // reversible: full span stored, summary cites a context:// URI
    compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  },
});

// Pin constraint text — survives compress() verbatim, never cleared by compact()
history.push({
  role: "user",
  content: "NEVER touch prod. Deploy only from CI.",
  pinned: true,
});
```

### Recall tool recipe

With `archive` (or VFS offloading) enabled, register the built-in `recall_context` tool so the model can pull archived content back on demand:

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({
    role: "tool",
    tool_call_id: call.id,
    content: content ?? "[not found]",
  });
}
```

## `chef.reportTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds `contextWindow`, compression is triggered. In the tokenizer path, the default is to take the higher of the local calculation and the fed value; switch via `usagePreference` if you want `'feedFirst'` (trust the API truth) or `'tokenizerFirst'` (ignore fed entirely).

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

## `onBeforeCompress` hook

Fires when the token budget is exceeded, **before** LLM compression. Return a modified `Message[]` to replace the history, or return `null` to let default compression proceed.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBeforeCompress: (history, { currentTokens, limit }) => {
      // Example: offload large tool results to VFS before compression
      return history.map((msg) =>
        msg.role === "tool" && msg.content.length > 5000
          ? { ...msg, content: pointer.offload(msg.content).content }
          : msg,
      );
    },
  },
});
```

## Mechanical Compaction (`compact`)

Strip content from history at zero LLM cost. Use proactively in your agent loop to keep context lean.

```typescript
// Clear all tool results and thinking blocks
history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

// Keep the 5 most recent tool results, clear the rest (min: 1)
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// Combine: clear old tool results + all thinking
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }, 'thinking'],
});

// v4: strip <think>...</think> tags from assistant text (open-weight reasoning models)
history = janitor.compact(history, { clear: ['reasoning-tags'] });

// v4: per-tool granularity — clear only these tools, never those
history = janitor.compact(history, {
  clear: [{
    target: 'tool-result',
    keepRecent: 5,          // counts within the clearable set
    toolFilter: ['run_bash'],   // only clear these tools
    exemptTools: ['read_file'], // never clear these (wins over toolFilter)
  }],
});
```

Pinned messages (`pinned: true`) are never cleared by `compact()`, and Gemini thought signatures are immune to `compact(['thinking'])`.

## `ensureValidHistory(history)`

Standalone utility that sanitizes message history to satisfy LLM API invariants (orphan tool result removal, missing tool result placeholder injection, first-non-system-must-be-user). Use when loading history from a database or after manual modifications.

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

> **Boundary contract.** All input adapters (`fromOpenAI` / `fromAnthropic` / `fromGemini`, plus middleware-internal `fromAISDK` / `fromTanStackAI`) run their output through `ensureValidHistory` automatically — they're the system boundary between external SDK formats and ContextChef IR. `chef.setHistory(IR)` does NOT sanitize: IR is treated as an internal protocol, and history you construct (or mutate) directly is trusted to satisfy the invariants. Wrap with `ensureValidHistory(...)` explicitly when in doubt.

## `chef.clearHistory(): this`

Explicitly clear history and reset Janitor state when switching topics or completing sub-tasks.
