# Overflow

When a conversation outgrows the window, something has to leave. That is overflow: information moving from the window into the [context store](/guide/context-store), kept reachable through the `context` tool. It is axis ① → ③ → ④ of the [five-axis architecture](/guide/architecture), and it is one decision split cleanly in two.

**The Janitor is the runner.** It reads the token budget, decides when the trigger is crossed, holds the circuit breaker, archives what left, emits `compress:*`, and runs durable compaction. **The strategy is the policy.** It is handed the in-window history plus the budget that was blown, and returns the new window contents together with everything that left it.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },      // the runner
  overflow: {
    strategy: chain(summarize({ compressionModel: callGpt4oMini }), reset()), // the policy
    archive: 'vfs',
  },
});
```

Everything on this page below the strategies section applies whatever strategy you install.

## Strategies <Badge type="tip" text="4.2" />

Six built-ins, each a factory in `@context-chef/core`. Four are policies; two are combinators.

| Factory | What leaves the window | Cost | Use it when |
|---|---|---|---|
| `summarize(opts)` | old turns, replaced by one LLM summary | one model call per overflow | the default — you want the conversation's substance to survive |
| `anchored(opts)` | old turns, merged into a persistent anchor document | one model call per overflow, over a smaller span | long sessions where rewriting the whole summary every time is wasteful and drifts |
| `server(config, { fallback })` | nothing client-side on a provider that compacts for you | zero extra model calls on Anthropic | you target Anthropic and want exact token accounting; `fallback` keeps the config portable |
| `reset(opts)` | everything except pinned messages, replaced by a stub | zero | the escalation step of a `chain`, or a hard boundary between sub-tasks. Lossy without `archive` |
| `chain(...strategies)` | whatever the first strategy that succeeds evicts | that strategy's cost | you want a fallback: try to summarize, and when the summarizer is down, still get the window back |
| `background(strategy)` | the same as `strategy`, one compile later | the same, off the hot path | compression latency is hurting your turn time |

`chain` moves on when a strategy changed nothing **or** left the history still above the trigger, and stops at the first one that brings the window back under budget. `background` returns the over-budget history unchanged from the first compile and swaps the finished result in later — only while it still applies, checked by content equivalence, so a span that was rewritten in the meantime discards the job rather than corrupting the window.

```typescript
import { anchored, background, ContextChef, server, summarize } from '@context-chef/core';

// Anchored, off the hot path.
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: { strategy: background(anchored({ compressionModel: callGpt4oMini })) },
});

// Server-side on Anthropic, client-side everywhere else — one portable config.
const portable = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: server(
      { edits: [{ type: 'compact_20260112' }] },
      { fallback: summarize({ compressionModel: callGpt4oMini }) },
    ),
  },
});
```

`summarize()` and `anchored()` take the same options — `compressionModel`, `compressionGuidelines`, `customCompressionInstructions`, `minShrinkRatio`, `validateCompression`, `preserveRatio`, `preserveRecentMessages`, `toolResultStubThreshold`, `split`. These are the fields that used to live on `JanitorConfig`; see [the deprecation table](#the-4-1-compression-options).

### Where the split lands

Both summarizing strategies cut on turn boundaries — an assistant message and its tool results never separate — and only the size of the preserved tail differs:

- `split: 'ratio'` keeps as many recent turns as fit in `budget.trigger × preserveRatio` (default `0.8`). Meaningful only with a real tokenizer.
- `split: 'recent-turns'` keeps the last `preserveRecentMessages` turns (default `1`), whatever they cost. The right choice when token counts come from the provider rather than a local tokenizer.

The default is `'recent-turns'` when `preserveRecentMessages` is the only preserve option you gave, and `'ratio'` otherwise.

## Knowing the budget

The runner needs to know how full the window is. Two paths, pick one.

### Path 1: `tokenizer` (precise)

Provide your own counting function and Janitor computes per-message.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages — the exact slice of history the summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
  overflow: {
    strategy: summarize({ compressionModel: async (msgs) => callGpt4oMini(msgs), preserveRatio: 0.8 }),
  },
});
```

### Path 2: `reportTokenUsage` (no tokenizer needed)

Most LLM APIs return token usage in their response. Feed that value back.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200000 },
  overflow: {
    strategy: summarize({
      compressionModel: async (msgs) => callGpt4oMini(msgs),
      preserveRecentMessages: 1,
    }),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

In the tokenizer path the default is to take the higher of the local calculation and the fed value; `usagePreference` switches to `'feedFirst'` (trust the API truth) or `'tokenizerFirst'` (ignore fed entirely). Without a `tokenizer` the union narrows to `'max' | 'feedFirst'` and TypeScript rejects `'tokenizerFirst'` at compile time.

> **Note:** without a `compressionModel`, `summarize()` drops the evicted span instead of summarizing it. A console warning is printed at construction if neither `tokenizer` nor `compressionModel` is provided.

## Quality gates

One rule: a bad summary must never replace good history.

- **Pre-rot trigger — `triggerRatio` (default `0.7`)**: overflow fires at `contextWindow × 0.7` rather than at the hard limit, because model quality degrades well before the window is full. `triggerRatio: 1` restores the pre-4.0 behavior.
- **Constraint pinning — `pinned: true`**: pinned messages survive every strategy verbatim (re-inserted after the summary, in order) and are never cleared by `compact()`. Pinning any message of an atomic turn protects the whole turn. Use it for policy and constraint text — compaction that drops policy text raises violation rates from 0% to 30%+ (arXiv:2606.22528).
- **Shrink guard — `minShrinkRatio` (default `0.5`)**: a summary that doesn't shrink the compressed span by ≥ 50% (character length; spans ≥ 2000 chars only) is a failed overflow — history unchanged, circuit breaker incremented. Prevents compression death loops. `0` disables.
- **`validateCompression`**: post-summarization gate `(summary, { compressed, kept }) => boolean | Promise<boolean>` — return `false` or throw to reject the result.
- **Circuit breaker (runner-owned)**: three consecutive failures of *whatever strategy is installed* and overflow becomes a no-op until the next success or an explicit `janitor.reset()` / `chef.clearHistory()`. The counter survives `chef.snapshot()` / `chef.restore()`.

A failure — a model that threw, a summary that failed the shrink guard, a validator that said no — leaves history **unchanged** (pre-4.0 truncated it with a placeholder).

**Compression output contract.** The default prompt asks the compression model for an `<analysis>` scratchpad (stripped from the final output) followed by a structured `<summary>` block with five domain-agnostic sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Raw output is piped through `Prompts.formatCompactSummary` before injection.

**Standalone summarization.** `summarizeHistory(messages, compress, opts?): Promise<string>` is the provider-agnostic primitive behind this path — call it directly to compress a slice in your own store. Empty slice → `''`; stateless and **throws** if `compress` throws; the `compress` callback **must role-flatten** `tool` roles. See [Durable compaction](/guide/durable-compaction) for the higher-level helpers.

## Archive — overflow you can undo <Badge type="tip" text="4.2" />

`overflow.archive` is strategy-agnostic: whatever the installed strategy evicted is serialized and stored, and the URI is cited in the summary that replaced it, so exact details stay retrievable instead of being guessed at by importance scoring (arXiv:2607.25066, arXiv:2607.08032). It applies to `reset()` exactly as it applies to `summarize()`.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: reset(),
    archive: 'vfs', // or { store: (serialized, { messageCount }) => uri }
  },
});
```

`'vfs'` stores spans in this chef's VFS, under `context://vfs/...`. Archiving is best-effort: a store failure logs a warning and skips the citation rather than failing the overflow.

::: warning `reset()` without `archive` is lossy
Everything but the pinned messages is gone — no summary, no URI. That combination is documented, not enforced: mechanism, not policy. Pair `reset()` with an archive unless you genuinely mean to discard.
:::

Register the built-in `recall_context` tool so the model can pull archived content back on demand:

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({ role: "tool", tool_call_id: call.id, content: content ?? "[not found]" });
}
```

Under `tools: 'unified'` this is the `context` tool's `view` command instead, and `chef.handleTool` dispatches it for you — see [Context store](/guide/context-store).

## Handoff budget <Badge type="tip" text="4.2" />

Overflow is mechanical. Whatever a strategy evicts is gone from the window whether or not the model was ready for it — and the model is the only party that knows which half of the conversation still matters.

The handoff budget reserves a slice of headroom *above* the trigger and spends it on one notice: your window is about to be cut, write down what matters.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: summarize({ compressionModel: callGpt4oMini }),
    archive: 'vfs',
    handoff: {
      budgetTokens: 4000,
      prompt:
        'About {n_remaining} tokens remain before this conversation is compacted. ' +
        'Write anything worth keeping to context://notes/ or context://memory/ now.',
    },
  },
  tools: 'unified',
});
```

- The notice fires when `budget.remaining <= budgetTokens`, **once per window** — a long stretch near the trigger does not repeat it every turn. The flag resets when the window id changes.
- It is delivered through the announcement tail channel (`channel: 'auto'`, so it goes to a mid-conversation system message on Anthropic and the user tail elsewhere), and it never persists: it is not in `getAnnouncements()`, never enters your history, and is skipped entirely on server-managed compiles.
- `{n_remaining}` is replaced everywhere it appears, rounded and clamped at 0.
- `budgetTokens` must be a positive integer and `prompt` at most 2000 UTF-8 bytes; both are validated at construction, not silently ignored at compile time. Omit `prompt` to get `Prompts.HANDOFF_NOTICE_TEMPLATE` (or its `context://` variant under `tools: 'unified'`).

Pair it with the context store: the notice is only useful if the model has somewhere to write. `notes/` costs nothing per turn until it is read back.

## `new_context` — letting the model close a window <Badge type="tip" text="4.2" />

Sometimes the model knows a chunk of work is finished long before the budget says so. `new_context` is a static, parameterless tool that says exactly that.

```typescript
import { getNewContextToolDefinition } from '@context-chef/core';

chef.registerTools([getNewContextToolDefinition()]);

for (const call of response.tool_calls) {
  if (call.function.name === 'new_context') {
    chef.requestNewContext();
    history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: 'Starting a new context window.',
    });
  }
}
```

Under `tools: 'unified'` the tool is emitted automatically when `overflow.handoff` is configured, and `chef.handleTool` dispatches it.

`chef.requestNewContext()` is a one-shot force: the next `compile()` applies the strategy whatever the budget says. What "new window" means is whatever the installed strategy does — `summarize()` leaves a summary, `reset()` leaves a stub, `archive` keeps the span retrievable either way. Unlike `clearHistory()`, nothing is discarded behind the library's back: the strategy still decides what survives, a `before-overflow` handler can still veto, and the circuit breaker still applies. The request is consumed by one compile whether or not the window actually changed.

## Window lineage <Badge type="tip" text="4.2" />

Every overflow that lands closes one context window and opens the next. The runner keeps `{ first, previous?, current }` and advances it **at commit time only**, so a background result that went stale never moves the chain — it records windows that existed, not windows that were considered.

```typescript
chef.use('after-overflow', ({ result }) => {
  if (!result?.meta.changed) return;
  logger.info('overflow', result.meta.strategy, result.meta.windowId, result.evicted.length);
});

const payload = await chef.compile({ target: 'openai' });
payload.meta?.windowId;
```

Two ids, deliberately different: `OverflowResult.meta.windowId` is the window the strategy **acted on**, and `CompileMeta.windowId` is the window the payload **belongs to**. Two payloads carrying the same id were compiled against the same window, so a change is your signal that the history behind the model was rewritten.

The lineage is what makes the rest work: `anchored()` keys its anchor document by window id (so a restored snapshot brings back the anchor that window actually had), the handoff notice is once-per-window, and `reset()`'s stub names the window it closed. It rides `JanitorSnapshot` and `ChefSnapshot` and round-trips through `snapshot()` / `restore()`; `clearHistory()` starts a fresh lineage.

## Writing your own strategy <Badge type="tip" text="4.2" />

Anything with an `apply` of this shape can be passed as `overflow.strategy`:

```typescript
interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  commit?(result: OverflowResult): void;   // the result actually entered the window
  snapshot?(): unknown;                    // serialized into JanitorSnapshot
  restore?(state: unknown): void;
  attach?(runner: OverflowRunner): void;   // the runner installs its breaker + logger
}
```

`OverflowInput` carries `history`, `budget`, `tokenizer`, `pinned` (turn-scoped, by reference — compare with `===`, not by value), `window` and an optional `signal`. `OverflowResult` carries the new `history`, everything `evicted`, an optional `summary`, and `meta: { strategy, windowId, changed, reason? }`.

```typescript
const dropToolResults: OverflowStrategy = {
  name: 'drop-tool-results',
  async apply(input: OverflowInput): Promise<OverflowResult> {
    const pinned = new Set(input.pinned);
    const evicted = input.history.filter((m) => m.role === 'tool' && !pinned.has(m));
    if (evicted.length === 0) {
      return {
        history: input.history,
        evicted: [],
        meta: {
          strategy: 'drop-tool-results',
          windowId: input.window.current,
          changed: false,
          reason: 'no unpinned tool results left',
        },
      };
    }
    const dropped = new Set(evicted);
    return {
      history: input.history.filter((m) => !dropped.has(m)),
      evicted,
      meta: { strategy: 'drop-tool-results', windowId: input.window.current, changed: true },
    };
  },
};

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: { strategy: chain(dropToolResults, summarize({ compressionModel: callGpt4oMini })) },
});
```

Two rules. Never drop a message in `input.pinned` — the `pipelineChecks` invariants exist to catch it when you do. And publish state you derive from your own output in `commit`, not in `apply`: `apply` may run speculatively (that is exactly what `background()` does) and a result that never landed must not pollute your state.

## `JanitorConfig` — the runner's options

These stay on the Janitor. They are budget and lifecycle concerns, not policy.

| Option | Type | Default | Description |
|---|---|---|---|
| `contextWindow` | `number` | _required_ | Model's context window size (tokens). Overflow triggers above `contextWindow × triggerRatio`. |
| `triggerRatio` | `number` | `0.7` | Fraction of `contextWindow` at which overflow fires ("pre-rot"). Set `1` to restore the pre-4.0 trigger-at-window behavior. |
| `tokenizer` | `(msgs: Message[]) => number` | — | Enables the tokenizer path for precise per-message token calculation. |
| `usagePreference` | `'max' \| 'feedFirst' \| 'tokenizerFirst'` | `'max'` | Which token source drives the trigger when both `tokenizer` and `reportTokenUsage` are set. |
| `onCompress` | `(summary, count, details) => void` | — | Fires after an overflow lands. `details.compressedMessages` is the exact slice of history the summary replaced. |
| `onBeforeCompress` | `(history, tokenInfo) => Message[] \| null` | — | Fires before the strategy runs. Deprecated — register on the `before-overflow` slot instead. |
| `logger` | `ChefLogger` | — | Sink for degradation warnings (storage / compaction); defaults to `console`. |

## The 4.1 compression options

Every one of them still works, keeps its exact behavior, and is removed in 5.0. Setting both an alias and `overflow.strategy` logs a warning once and the strategy wins.

| Deprecated | Replacement |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy = summarize(...)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy = anchored(...)` |
| `janitor.compressionScheduling: 'background'` | wrap the strategy in `background(...)` |
| `janitor.archive` | `overflow.archive` |
| `contextManagement.strategy: 'server'` + `contextManagement.server` | `overflow.strategy = server(config, { fallback })` |
| `janitor.compressionModel` | `summarize({ compressionModel })` |
| `janitor.compressionGuidelines` | `summarize({ compressionGuidelines })` |
| `janitor.customCompressionInstructions` | `summarize({ customCompressionInstructions })` |
| `janitor.minShrinkRatio` | `summarize({ minShrinkRatio })` |
| `janitor.validateCompression` | `summarize({ validateCompression })` |
| `janitor.preserveRatio` | `summarize({ preserveRatio })` |
| `janitor.preserveRecentMessages` | `summarize({ preserveRecentMessages })` |
| `janitor.toolResultStubThreshold` | `summarize({ toolResultStubThreshold })` |
| `janitor.onBeforeCompress` | `chef.use('before-overflow', ...)` |

The `contextManagement` alias builds `server(cfg, { fallback: <the default client strategy> })`, which is exactly the v4 behavior: server-side on Anthropic, client-side compression everywhere else. See [Server-side context management](/guide/server-side-context-management).

## `chef.reportTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds the trigger, overflow runs.

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

## Intervening before overflow

`onBeforeCompress` (deprecated) and the `before-overflow` slot are the same code path. The slot sees the runner's real budget and can veto the phase entirely by returning `false`:

```typescript
chef.use('before-overflow', ({ history, budget }) => {
  logger.info(`over budget by ${-budget.remaining} tokens, ${history.length} messages in window`);
  if (streamingInProgress) return false; // don't rewrite history mid-stream
});
```

See [Events & Hooks](/guide/events-hooks) for the full slot list.

## Mechanical compaction (`compact`)

Strip content from history at zero LLM cost. Independent of overflow — use it proactively in your agent loop to keep the window lean and delay the trigger.

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

Explicitly clear history and reset the runner's state — circuit breaker, strategy state, and the window lineage — when switching topics or completing sub-tasks. Announcements survive; retract them explicitly.
