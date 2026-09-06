<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/raw/main/docs-site/public/logo.svg" width="88" alt="ContextChef" />
</p>

# @context-chef/core

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![GitHub stars](https://img.shields.io/github/stars/MyPrototypeWhat/context-chef)](https://github.com/MyPrototypeWhat/context-chef)
[![License](https://img.shields.io/npm/l/@context-chef/core.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

Context compiler for TypeScript/JavaScript AI agents.

📖 **Docs:** <https://myprototypewhat.github.io/context-chef/>

ContextChef solves the most common context engineering problems in AI agent development: conversations too long for the model to remember, too many tools causing hallucinations, having to rewrite prompts when switching providers, and state drift in long-running tasks. It doesn't take over your control flow — it just compiles your state into an optimal payload before each LLM call.

[中文文档](https://github.com/MyPrototypeWhat/context-chef/blob/main/README.zh-CN.md) | [GitHub](https://github.com/MyPrototypeWhat/context-chef)

> Looking for zero-config AI SDK integration? See [`@context-chef/ai-sdk-middleware`](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)

## Blog Series

1. [Why "Compile" Your Context](https://myprototypewhat.cn/context-chef-1-why-compile-context-en)
2. [Janitor — Separating Trigger Logic from Compression Policy](https://myprototypewhat.cn/context-chef-2-janitor-en)
3. [Pruner — Decoupling Tool Registration from Routing](https://myprototypewhat.cn/context-chef-3-pruner-en)
4. [Offloader/VFS — Relocate Information, Don't Destroy It](https://myprototypewhat.cn/context-chef-4-offloader-vfs-en)
5. [Core Memory — Zero-Cost Reads, Structured Writes](https://myprototypewhat.cn/context-chef-5-core-memory-en)
6. [Snapshot & Restore — Capture Everything That Determines the Next Compile](https://myprototypewhat.cn/context-chef-6-snapshot-en)
7. [The Provider Adapter Layer — Let Differences Stop at Compile Time](https://myprototypewhat.cn/context-chef-7-adapters-en)
8. [Five Extension Points in the Compile Pipeline](https://myprototypewhat.cn/context-chef-8-hooks-en)

## The five axes

Every feature in this library sits on exactly one of five axes. The map is the fastest way to find the piece you need — and the reason the 4.2 API looks the way it does.

| Axis | The question it answers | Who owns it |
|---|---|---|
| **① Selection** | What goes into the window | [`OverflowStrategy`](#overflow-42) for history, [Pruner](#tool-management-pruner) for tools, `memory.selector` for memory |
| **② Placement** | Where in the window it goes | the sandwich assembler, `memoryPlacement` / `skillPlacement`, the tail channel, cache breakpoints |
| **③ Persistence** | Where it lives once it is out of the window | one [`StorageBackend` behind one `Store`](#context-store-42) — namespaces `memory` / `notes` / `vfs` / `archive` |
| **④ Retrieval** | How the model reaches back outside the window | one [`context` tool](#the-context-tool--tools-unified) (+ `new_context`), dispatched through `chef.handleTool` |
| **⑤ Adaptation** | Provider wire format | [target adapters](#target-adapters) |

Overflow is not a feature of its own: it is information moving from ① to ③, recoverable through ④. `summarize` / `anchored` / `reset` are ① policies, `archive` / `notes` / `memory` are ③ namespaces, `view` / `search` are ④ handles. [`docs/architecture-v5.md`](https://github.com/MyPrototypeWhat/context-chef/blob/main/docs/architecture-v5.md) is the full contract.

## Features

**① Selection — what goes into the window**

- **Conversations too long?** — `overflow.strategy` decides what leaves: `summarize()` (the default), `anchored()`, `reset()`, or your own, composed with `chain()` / `background()`
- **Losing constraints to compression?** — Constraint pinning (v4): `pinned: true` messages survive overflow verbatim and are never cleared by `compact()`
- **Compression latency on the hot path?** — `background()` summarizes off-turn and swaps the result in only while it still applies; `anchored()` merges each evicted span into a persistent anchor document instead of rewriting the whole summary
- **Model knows the task is done?** — `new_context` + `chef.requestNewContext()` (4.2) run the strategy on the next compile whatever the budget says
- **Provider does compaction for you?** — `server()` delegates LLM compression to Anthropic's server-side compaction while pruning, skills, memory and the store stay client-side
- **Own your message store?** — Durable compaction: `planCompaction` / `compactHistory` compact your store once and persist the result, instead of re-compressing in-flight on every call
- **Too many tools?** — Dynamically prune the tool list per task, or use a two-layer architecture (stable namespaces + on-demand loading) to eliminate tool hallucinations
- **Need to block tools at runtime?** — Pruner blocklist + `checkToolCall` gate for permission, environment safety, rate limits, and sandboxing — KV-cache preserving by default

**② Placement — where in the window it goes**

- **Long tasks drifting?** — Zod schema-based state injection forces the model to stay aligned with the current task on every call
- **Output format drifting?** — Guardrail: `withGuardrails` enforces an XML output contract and sets an assistant prefill, auto-degraded on providers without native prefill
- **Mode-based behavior?** — `Skill` primitive bundles instructions and tool annotations per phase; loadable from `SKILL.md` files (compatible with Claude Code / Mastra / OpenCode formats)
- **Cache invalidated every turn?** — `memoryPlacement` / `skillPlacement` move volatile blocks out of the cached prefix into the tail channel; `cacheAudit: true` reports breakpoints that sit behind volatile content
- **Window about to be cut?** — Handoff budget (4.2): `overflow.handoff` reserves tokens above the trigger and delivers one tail notice per window, so the model can persist what matters before the library evicts mechanically

**③ Persistence — where it lives once it is out of the window**

- **Terminal output too large?** — Auto-truncate and offload, keeping error lines + a `context://vfs/` URI pointer for on-demand retrieval
- **Can't remember across sessions?** — Memory lets the model persist key information (project rules, user preferences), auto-injected on the next session
- **Four storage interfaces for one job?** — `ChefConfig.store` (4.2): one `StorageBackend` serves `memory`, `notes`, `vfs` and `archive`, with per-namespace eviction on the `Store` above it
- **Need to rollback?** — Snapshot & Restore captures and rolls back full context state for branching and exploration

**④ Retrieval — how the model reaches back**

- **Summary dropped a detail you need back?** — Reversible archive: the full evicted span is stored and cited by URI, whatever strategy evicted it
- **Four tools where one would do?** — `tools: 'unified'` (4.2) emits a single `context` tool spanning every namespace; `chef.ownsTool` / `chef.handleTool` are the one dispatch entry point for every library-owned tool

**⑤ Adaptation — provider wire format**

- **Switching providers?** — Same prompt architecture compiles to OpenAI / Anthropic / Gemini with automatic prefill, cache, and tool call format adaptation

**Across the axes**

- **Need external context?** — `chef.use('before-assemble', ...)` (4.2) injects RAG results, AST snippets, or MCP queries into the compile that is running
- **Need observability?** — Unified event system (`chef.on('compress', ...)`) for logging, metrics, and debugging across all internal modules

## Installation

```bash
npm install @context-chef/core zod
```

## Quick Start

```typescript
import { ContextChef } from "@context-chef/core";
import { z } from "zod";

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

const payload = await chef
  .setSystemPrompt([
    {
      role: "system",
      content: "You are an expert coder.",
      _cache_breakpoint: true,
    },
  ])
  .setHistory(conversationHistory)
  .setDynamicState(TaskSchema, {
    activeFile: "auth.ts",
    todo: ["Fix login bug"],
  })
  .withGuardrails({
    enforceXML: { outputTag: "response" },
    prefill: "<thinking>\n1.",
  })
  .compile({ target: "anthropic" });

const response = await anthropic.messages.create(payload);
```

---

## API Reference

> **Removed in 4.0** — each has a direct replacement: `TokenUtils` → `estimate` / `estimateObject`, `XmlGenerator` → `objectToXml`, `AdapterFactory` → `getAdapter` / `adapterRegistry`, `JanitorConfig.onBudgetExceeded` → `onBeforeCompress`. See [MIGRATION-4.md](https://github.com/MyPrototypeWhat/context-chef/blob/main/MIGRATION-4.md) for the full migration guide.

> **Deprecated in 4.2 (removed in 5.0)** — every alias below still works and is mapped onto the new shape at construction; nothing has to change in 4.x.
>
> | Deprecated | Replacement |
> |---|---|
> | `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
> | `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
> | `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(<strategy>)` |
> | `janitor.archive` | `overflow.archive` (strategy-agnostic) |
> | `contextManagement.strategy: 'server'` + `.server` | `overflow.strategy: server(config, { fallback })` |
> | `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', (ctx) => ctx.inject(text))` |
> | `ChefConfig.transformContext` | `chef.use('after-assemble', (messages) => messages)` |
> | `MemoryStore` | `StorageBackend` (or a `Store`) as `memory.store` |
> | `VFSStorageAdapter` | `StorageBackend` as `vfs.store` |
> | `VFSMemoryStore` | `new Store(new FileSystemBackend(dir))` — the `memory` namespace on it |
> | `FileSystemAdapter` | `FileSystemBackend` |
> | `Memory.getToolDefinitions()` → `create_memory` / `modify_memory` | `tools: 'unified'` → the `context` tool |
>
> The `tools` default stays `'legacy'` in 4.x — tool names are dispatch keys in your agent loop, so the default cannot flip in a minor. It becomes `'unified'` in 5.0.

### `new ContextChef(config?)`

Every field is optional. Grouped by axis; deprecated fields are marked with their replacement.

```typescript
interface ChefConfig {
  // ① Selection — what goes into the window
  janitor?: JanitorConfig;                 // the overflow runner: budget, tokenizer, circuit breaker
  overflow?: {                             // 4.2 — the overflow policy
    strategy?: OverflowStrategy;           // summarize() (default) | anchored() | reset() | server() | chain() | background()
    archive?: 'vfs' | CompressionArchiveConfig;
    handoff?: HandoffConfig;               // { budgetTokens, prompt? }
  };
  pruner?: PrunerConfig;                   // { strategy?: 'union' | 'intersection' }

  // ② Placement — where in the window it goes
  memory?: ChefMemoryConfig;               // MemoryConfig with `store` optional (ChefConfig.store fills it in)
  skillPlacement?: SkillPlacement;         // 'after_system' (default) | 'tail'

  // ③ Persistence — where it lives outside the window
  store?: StorageBackend | Store;          // 4.2 — one backend for memory / notes / vfs / archive
  vfs?: Partial<VFSConfig>;                // threshold, storageDir, maxAge, maxFiles, maxBytes, onVFSEvicted, ...

  // ④ Retrieval — how the model reaches back
  tools?: ToolsMode;                       // 'legacy' (default) | 'unified'
  contextTool?: ContextToolPolicyConfig;   // { writable?: string[] } — defaults to ['memory', 'notes']

  // ⑤ Adaptation — provider wire format
  defaultTarget?: TargetProvider | ITargetAdapter;

  // Across the axes
  logger?: ChefLogger;                     // degradation warnings; module-level loggers win
  cacheAudit?: boolean;                    // Anthropic-only breakpoint audit, once per issue per chef
  pipelineChecks?: boolean;                // 4.2 — dev invariants, reported never enforced
  transformToolResult?: (
    content: string,
    info: { toolName: string | null; toolCallId: string | null },
  ) => string | Promise<string>;

  /** @deprecated 4.2 — chef.use('before-assemble', (ctx) => ctx.inject(text)) */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
  /** @deprecated 4.2 — chef.use('after-assemble', (messages) => messages) */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  /** @deprecated 4.2 — overflow.strategy: server(config, { fallback }) */
  contextManagement?: { strategy: 'client' | 'server'; server?: unknown };
}
```

### Context Building

#### `chef.setSystemPrompt(messages): this`

Sets the static system prompt layer. Cached prefix — should rarely change.

```typescript
chef.setSystemPrompt([
  {
    role: "system",
    content: "You are an expert coder.",
    _cache_breakpoint: true,
  },
]);
```

`_cache_breakpoint: true` tells the Anthropic adapter to inject `cache_control: { type: 'ephemeral' }`.

#### `chef.setHistory(messages): this`

Sets the conversation history. Janitor compresses automatically on `compile()`.

#### `chef.setDynamicState(schema, data, options?): this`

Injects Zod-validated state as XML into the context.

```typescript
const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

chef.setDynamicState(TaskSchema, { activeFile: "auth.ts", todo: ["Fix bug"] });
// placement defaults to 'last_user' (injected into the last user message)
// use { placement: 'system' } for a standalone system message
```

#### `chef.withGuardrails(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
});
```

**v4 semantics.** Options are now *stored* and applied at `compile()`, so call order relative to `setDynamicState` no longer matters (pre-4.0, calling `setDynamicState` after `withGuardrails` silently discarded the guardrail). Each call **replaces** the previous options (no accumulation); `withGuardrails(null)` clears them. The stored options are persisted in `ChefSnapshot` (`guardrailOptions`), and the guardrail message lands at the very end of the sandwich as its own message — closest to generation, no longer merged into the dynamic-state message.

#### `chef.compile(options?): Promise<TargetPayload>`

Compiles everything into a provider-ready payload. Triggers Janitor compression. Registered tools are auto-included.

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

---

### Overflow (4.2)

Overflow is what happens when history no longer fits: the **strategy** decides what leaves the window, the **runner** ([Janitor](#history-compression-janitor)) decides when to ask and what to do with the answer, and `archive` keeps what left retrievable. Before 4.2 those three were one tangle of `janitor.compression*` flags; they are separate objects now, and every old flag still maps onto the new one.

```typescript
import { ContextChef, chain, reset, summarize } from "@context-chef/core";

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: countTokens },
  overflow: {
    strategy: chain(summarize({ compressionModel }), reset()),
    archive: "vfs",
  },
});
```

#### Built-in strategies

| Factory | What it does | Replaces |
|---|---|---|
| `summarize(opts)` | Summarizes the evicted span with `opts.compressionModel` and puts the summary at the head of the window. The default when no strategy is set. | `compressionMode: 'rewrite'` |
| `anchored(opts)` | Keeps a persistent anchor document per window and merges only the newly evicted span into it, instead of rewriting the whole summary each time. | `compressionMode: 'incremental-anchored'` |
| `server(config, { fallback })` | Delegates to the provider's server-side context management. On Anthropic the client never compresses and the payload carries `context_management` + betas; on every other target it runs `fallback`. | `contextManagement: { strategy: 'server' }` |
| `reset(opts)` | Keeps the pinned messages and evicts everything else — no model call, just a notice naming the closed window. Lossy without `archive`. | new in 4.2 |
| `chain(...strategies)` | Escalation: moves to the next strategy when the previous changed nothing, or left history still over the trigger. | new in 4.2 |
| `background(strategy)` | Moves `strategy` off the critical path: the over-budget compile returns history unchanged and a later compile swaps the finished result in — only while it still applies. | `compressionScheduling: 'background'` |

`summarize` and `anchored` take the same options — `compressionModel`, `compressionGuidelines`, `customCompressionInstructions`, `minShrinkRatio`, `validateCompression`, `preserveRecentMessages`, `preserveRatio`, `toolResultStubThreshold`, `split` — which are exactly the `janitor.compression*` knobs under their own roof.

```typescript
import { anchored, background, server, summarize } from "@context-chef/core";

// Summarize off-turn, merging each evicted span into a persistent anchor document.
new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: countTokens },
  overflow: { strategy: background(anchored({ compressionModel })), archive: "vfs" },
});

// One config across providers: Anthropic compacts server-side, everyone else summarizes.
new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: countTokens },
  overflow: { strategy: server(undefined, { fallback: summarize({ compressionModel }) }) },
});
```

#### `archive` — strategy-agnostic since 4.2

Whatever a strategy evicts is what gets archived, and the summary that replaced it cites the URI. `archive: 'vfs'` stores spans in this chef's VFS; the explicit `{ store }` form receives the serialized span (`JSON.stringify({ version: 1, messages })`) and returns the URI to cite. Archiving is best-effort — a store failure logs a warning and skips the citation, never the compile. Pair it with the [`context` tool](#the-context-tool--tools-unified)'s `view`, or the legacy `getRecallToolDefinition()` + `chef.resolveRecall()`, so the model can pull a span back.

`reset()` without an archive is allowed and genuinely lossy — the library documents that combination rather than rejecting it.

#### Handoff budget — `overflow.handoff`

Tokens held back **above** the trigger, so the model gets one turn to persist state before the library evicts mechanically. When the remaining headroom drops into that band, one compile carries a notice in its tail; the once-per-window flag resets when the window id changes, so a long stretch near the trigger does not repeat it every turn.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: countTokens },
  tools: "unified",
  overflow: {
    strategy: summarize({ compressionModel }),
    archive: "vfs",
    handoff: { budgetTokens: 8_000 }, // prompt defaults to Prompts.HANDOFF_NOTICE_TEMPLATE
  },
});
```

`{ budgetTokens, prompt? }` is validated at construction: `budgetTokens` a positive integer, `prompt` non-empty and at most 2000 UTF-8 bytes. Every `{n_remaining}` in the prompt is replaced with the headroom left before the trigger. The notice rides the announcement tail channel — never persisted, never returned by `getAnnouncements()`, and skipped on server-managed compiles.

#### `new_context` and `chef.requestNewContext(): this`

`getNewContextToolDefinition()` is a static, parameterless tool the model calls when a chunk of work is finished and its details no longer need to be in front of it. Dispatch it — `handleTool` does — and the **next** `compile()` runs the strategy whatever the budget says.

What "new window" means is whatever the installed strategy does: `summarize()` leaves a summary, `reset()` leaves a stub, `archive` keeps the span retrievable either way. Unlike `clearHistory()` this does not discard the conversation behind the library's back — the strategy still decides what survives, and a `before-overflow` handler can still veto it. The request is consumed by one compile whether or not the window actually changed (a strategy may decline; the breaker may be open), so call it again to retry.

```typescript
import { ContextChef, getNewContextToolDefinition, summarize } from "@context-chef/core";

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: countTokens },
  tools: "unified", // emits `context`, plus `new_context` because handoff is configured
  overflow: {
    strategy: summarize({ compressionModel }),
    archive: "vfs",
    handoff: { budgetTokens: 8_000 },
  },
});

// In your agent loop — one entry point for every library-owned tool:
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
  }
}
```

Under `tools: 'legacy'` register it yourself — `chef.registerTools([getNewContextToolDefinition()])`. `handleTool` dispatches it in either mode.

#### Window lineage

`WindowLineage = { first, previous?, current }` is owned by the runner and moves forward **only when an overflow result actually enters the window**, so a stale `background()` job never advances it. `CompileMeta.windowId` reports the window a payload belongs to:

```typescript
const payload = await chef.compile({ target: "anthropic" });
if (payload.meta?.windowId !== lastWindowId) {
  // history behind the model was rewritten since the last call
  lastWindowId = payload.meta?.windowId;
}
```

`anchored()` keys its anchor document by window id, `reset()`'s stub names the window it closed, and the lineage rides `chef.snapshot()` / `restore()`. `clearHistory()` starts a fresh lineage.

#### Writing your own strategy

Anything with an `apply` of this shape can be passed as `overflow.strategy`:

```typescript
interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  /** Called only when a result of `apply` actually entered the window — publish derived state here, never inside `apply`. */
  commit?(result: OverflowResult): void;
  snapshot?(): unknown;
  restore?(state: unknown): void;
}

interface OverflowInput {
  history: Message[];
  budget: { limit: number; current: number; trigger: number; remaining: number };
  tokenizer: (messages: Message[]) => number;
  pinned: readonly Message[]; // must survive verbatim; turn-scoped, compared by reference
  window: WindowLineage;
  signal?: AbortSignal;
}

interface OverflowResult {
  history: Message[];
  evicted: Message[]; // the archive input
  summary?: string;   // raw summary text, without the continuation wrapper
  meta: { strategy: string; windowId: string; changed: boolean; reason?: string };
}
```

```typescript
import type { OverflowInput, OverflowResult, OverflowStrategy } from "@context-chef/core";

const dropOldestTurn: OverflowStrategy = {
  name: "drop-oldest",
  async apply(input: OverflowInput): Promise<OverflowResult> {
    const pinned = new Set(input.pinned);
    const index = input.history.findIndex((m) => !pinned.has(m));
    const meta = { strategy: "drop-oldest", windowId: input.window.current };
    if (index === -1) {
      return {
        history: input.history,
        evicted: [],
        meta: { ...meta, changed: false, reason: "only pinned messages left" },
      };
    }
    return {
      history: input.history.filter((_, i) => i !== index),
      evicted: [input.history[index]],
      meta: { ...meta, changed: true },
    };
  },
};
```

The runner installs its circuit breaker and logger on the strategy, so a custom strategy that reports failure gets the same three-strikes protection the built-ins do.

#### Deprecated overflow options

All of these still work and are mapped at construction. Setting `overflow.strategy` alongside any of them warns once — the strategy wins.

| Deprecated | Replacement |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(<strategy>)` |
| `janitor.archive` | `overflow.archive` |
| `contextManagement: { strategy: 'server', server }` | `overflow.strategy: server(server, { fallback })` |

The remaining `janitor.compression*` fields are **not** deprecated — they describe the *default* strategy, and an explicit `overflow.strategy` simply supersedes them. `janitor.{contextWindow, tokenizer, triggerRatio, usagePreference, logger, onCompress, onBeforeCompress}` are runner concerns and keep applying whatever the strategy is. A standalone `Janitor` takes the same object as `janitor.strategy`.

---

### History Compression (Janitor)

Janitor is the **overflow runner**: it evaluates the budget, calls `strategy.apply()`, archives what left, emits the `compress:*` events, and owns the circuit breaker and durable compaction. The policy — what actually leaves the window — lives in [Overflow](#overflow-42) since 4.2. Everything below still describes the default `summarize()` policy under its original names.

Janitor provides two compression paths. Choose the one that fits your setup:

#### Path 1: Tokenizer (precise control)

Provide your own token counting function for precise per-message calculation. Janitor preserves recent messages that fit within `contextWindow * preserveRatio` and compresses the rest.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8, // keep 80% of contextWindow for recent messages (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages: the messages this summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

#### Path 2: reportTokenUsage (simple, no tokenizer needed)

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

#### `JanitorConfig`

| Option                          | Type                                        | Default    | Description                                                                                  |
| ------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `contextWindow`                 | `number`                                    | _required_ | Model's context window size (tokens). Compression triggers when usage exceeds `contextWindow × triggerRatio`. |
| `triggerRatio`                  | `number`                                    | `0.7`      | Fraction of `contextWindow` at which compression fires ("pre-rot"). Set `1` to restore the pre-4.0 trigger-at-window behavior. |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —          | Enables the tokenizer path for precise per-message token calculation.                        |
| `preserveRatio`                 | `number`                                    | `0.8`      | [Tokenizer path] Ratio of the effective budget (`contextWindow × triggerRatio`) to preserve for recent messages. |
| `preserveRecentMessages`        | `number`                                    | `1`        | [reportTokenUsage path] Number of recent turns to keep when compressing. A turn is a single message or an assistant with tool_calls plus its tool results. |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`    | Which token source drives the trigger when both `tokenizer` and `reportTokenUsage` are available. See "Choosing the trigger source" below. The value union is narrowed: configs without `tokenizer` only accept `'max' \| 'feedFirst'` (TypeScript rejects `'tokenizerFirst'` at compile time). |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —          | Async hook to summarize old messages via a low-cost LLM.                                     |
| `customCompressionInstructions` | `string`                                    | —          | Additional focused instructions appended to the default compression prompt (additive, not replacement). See "Custom compression instructions" below. |
| `compressionGuidelines`         | `string[]`                                  | —          | Numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`. |
| `toolResultStubThreshold`       | `number`                                    | —          | Replace tool-result content longer than this many chars with a one-line metadata stub before summarizing (saves summarizer tokens). |
| `minShrinkRatio`                | `number`                                    | `0.5`      | Quality gate: a summary must shrink the compressed span by at least this ratio (spans ≥ 2000 chars only); otherwise the compression fails and history is unchanged. `0` disables. |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | Post-summarization gate. Return `false` (or throw) to reject the summary — history unchanged, circuit breaker incremented. |
| `strategy`                      | `OverflowStrategy`                          | `summarize(<the fields above>)` | The overflow policy this runner applies. On a `ContextChef` set it as `overflow.strategy` instead. See [Overflow](#overflow-42). |
| `archive`                       | `CompressionArchiveConfig \| 'vfs'`         | —          | **Deprecated in 4.2 → `overflow.archive`.** Reversible overflow: store the full evicted span, cite its URI in the summary. Strategy-agnostic now. See [Compression pipeline v2](#compression-pipeline-v2-v4). |
| `compressionMode`               | `'rewrite' \| 'incremental-anchored'`       | `'rewrite'`| **Deprecated in 4.2 → `overflow.strategy: summarize(opts)` / `anchored(opts)`.** Anchored mode keeps a persistent anchor document and merges only the newly evicted span into it on each compression. |
| `compressionScheduling`         | `'blocking' \| 'background'`                | `'blocking'` | **Deprecated in 4.2 → `overflow.strategy: background(<strategy>)`.** Background mode runs summarization off-turn; the over-budget compile returns history unchanged and the result is swapped in later if still valid. |
| `onCompress`                    | `(summary, count, details) => void \| Promise<void>` | —  | Fires after compression. `details.compressedMessages` is the exact prefix slice of history that the summary replaced (the first `truncatedCount` messages). |
| `logger`                        | `ChefLogger`                                | —          | Sink for degradation warnings (storage write failures, missing tokenizer, etc.); defaults to `console`. |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —          | Fires before compression. Return modified history to intervene, or null to proceed normally. See [`onBeforeCompress` hook](#onbeforecompress-hook) below. |

#### Compression Output Contract

Janitor's default prompt (`Prompts.CONTEXT_COMPACTION_INSTRUCTION`) instructs the compression model to produce a two-phase response:

```
<analysis>
[scratchpad reasoning — stripped from the final output]
</analysis>

<summary>
1. Task Overview: ...
2. Current State: ...
3. Important Discoveries: ...
4. Next Steps: ...
5. Context to Preserve: ...
</summary>
```

The `<analysis>` block is a drafting scratchpad that measurably improves summary quality (pattern borrowed from Claude Code). Janitor automatically pipes the compression model's raw output through `Prompts.formatCompactSummary`, which:

- Strips `<analysis>...</analysis>` blocks (case-insensitive, all occurrences)
- Extracts content from `<summary>...</summary>` when present
- Falls back to the stripped text if no `<summary>` tag is found
- Collapses excessive blank lines and trims whitespace

The 5 output sections are intentionally **domain-agnostic** (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve) so the prompt works for coding, customer support, research, shopping, or any other conversational agent.

You can call `Prompts.formatCompactSummary(raw)` directly if you're building a custom `compressionModel` that needs to handle the same output shape.

#### Custom compression instructions

Use `customCompressionInstructions` to focus the summary on your domain's concerns without breaking the `<analysis>`/`<summary>` parsing contract. The string is appended as an "Additional Instructions:" section after the default prompt.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    customCompressionInstructions: `
Focus on:
- Customer sentiment changes across the conversation
- Unresolved issues and any commitments made by the agent
- Preserve ticket IDs and SKUs verbatim
Ignore tangential small talk.
`.trim(),
  },
});
```

This is an **additive** mechanism — the default scaffolding that enforces the output contract is always preserved. If you need a completely different compression behavior, provide your own `compressionModel` instead.

#### Compression pipeline v2 (v4)

v4 rebuilds the compression path around one rule: a bad summary must never replace good history.

- **Pre-rot trigger — `triggerRatio` (default `0.7`)**: compression fires at `contextWindow × 0.7` instead of at the hard limit — model quality degrades well before the window is full. `preserveRatio` applies to this effective budget. `triggerRatio: 1` restores the pre-4.0 behavior.
- **Constraint pinning — `pinned: true`**: pinned messages survive `compress()` verbatim (re-inserted after the summary, in order) and are never cleared by `compact()`. Pinning any message of an atomic turn protects the whole turn. Use it for policy and constraint text — compaction that drops policy text raises violation rates from 0% to 30%+ (arXiv:2606.22528).
- **Shrink guard — `minShrinkRatio` (default `0.5`)**: a summary that doesn't shrink the compressed span by ≥ 50% (character length; spans ≥ 2000 chars only) is a failed compression — history unchanged, circuit breaker incremented. Prevents compression death loops. `0` disables.
- **`validateCompression`**: post-summarization gate `(summary, { compressed, kept }) => boolean | Promise<boolean>` — return `false` or throw to reject the result (history unchanged, breaker incremented).
- **Reversible archive — `overflow.archive`** (`janitor.archive`, deprecated in 4.2): the evicted span is serialized (`JSON.stringify({ version: 1, messages })`) and stored via `store(serialized, { messageCount }) => uri`, and the summary cites the URI, so exact details stay retrievable instead of being guessed at by importance scoring (arXiv:2607.25066, arXiv:2607.08032). `archive: 'vfs'` stores in the chef's VFS (requires ContextChef wiring — pass an explicit `{ store }` on a standalone Janitor). Best-effort: a store failure logs a warning and skips the citation.
- **`compressionGuidelines`**: numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`.
- **Incremental-anchored mode — `anchored()`** (`compressionMode: 'incremental-anchored'`, deprecated in 4.2): keeps a persistent anchor document; each compression merges only the newly evicted span into it instead of rewriting the whole summary (Factory.ai pattern). Read it via `janitor.getAnchorDoc()`; it is part of `JanitorSnapshot` and cleared by `reset()`.
- **Background scheduling — `background()`** (`compressionScheduling: 'background'`, deprecated in 4.2): the first over-budget `compile()` returns history unchanged and starts summarization in the background; a later `compress()` swaps the result in only if the summarized span is still a prefix of the current history (stale results are discarded; `onCompress` fires at application time). Keeps compression latency off the hot path (arXiv:2605.08580). Background state is not snapshotted.
- **Failure semantics (BREAKING)**: a compression-model failure no longer truncates history with a placeholder — history is returned unchanged and the circuit breaker counts the failure.

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

**Recall tool recipe.** With `archive` (or VFS offloading) enabled, register the built-in `recall_context` tool so the model can pull archived content back on demand. Under [`tools: 'unified'`](#the-context-tool--tools-unified) the `context` tool's `view` command covers the same ground for every namespace, and `chef.handleTool` dispatches both names:

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

#### Standalone summarization — `summarizeHistory`

`summarizeHistory` is the provider-agnostic primitive behind the Janitor's compression path. Call it directly when you own your conversation store and want to compress a slice yourself (durable compaction) rather than relying on in-flight `compile()` compression. It runs the exact same pipeline — tool-result stubbing → attachment stripping → trailing instruction → `<summary>` extraction — and returns the extracted summary text.

```typescript
function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts?: SummarizeHistoryOptions,
): Promise<string>;

interface SummarizeHistoryOptions {
  customCompressionInstructions?: string;
  toolResultStubThreshold?: number;
  compressionGuidelines?: string[]; // numbered guidelines, before customCompressionInstructions
  baseInstruction?: string; // replace the base prompt — must keep the <analysis>/<summary> contract
}
```

Contracts: an empty `messages` slice returns `''` without calling `compress`; it is stateless (no circuit breaker, no fallback) and **throws if `compress` throws** — callers handle their own degradation. The `compress` callback **must role-flatten** tool and assistant-tool-call messages to plain user/assistant text, since providers reject raw `tool` roles.

```typescript
import { summarizeHistory, Prompts } from "@context-chef/core";

const summary = await summarizeHistory(slice, myCompressFn, {
  toolResultStubThreshold: 5000,
});
// myCompressFn must role-flatten tool messages; throws on model failure; '' for an empty slice.
const continuation = Prompts.getCompactSummaryWrapper(summary); // optional continuation framing
```

> **ai-sdk users:** prefer `summarizeMessages` from [`@context-chef/ai-sdk-middleware`](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware) — it wires the role-flattening adapter for you.

#### Durable compaction — `planCompaction` / `compactHistory`

Two higher-level helpers turn `summarizeHistory` into a one-call durable compaction for a conversation you own. Both are provider-agnostic and operate on the IR `Message[]`.

```typescript
function planCompaction(
  history: Message[],
  options: { keepRecentTurns: number },
): { system: Message[]; toSummarize: Message[]; toKeep: Message[] };

function compactHistory(
  history: Message[],
  compress: (messages: Message[]) => Promise<string>,
  options: { keepRecentTurns: number } & SummarizeHistoryOptions,
): Promise<Message[]>;
```

`planCompaction` is the synchronous split: it groups the conversation into atomic turns (an assistant + its tool results stay together) and cuts on a turn boundary, so it never orphans a tool result or splits a multi-block assistant message. System messages are pulled aside into `system` and never summarized.

`compactHistory` runs the whole cycle — `planCompaction` → `summarizeHistory(toSummarize, compress)` → reassemble into `[...system, <summary>, ...toKeep]`, with the summary wrapped via `Prompts.getCompactSummaryWrapper`. Run it between model calls and replace your stored messages with the result.

```typescript
import { compactHistory } from "@context-chef/core";

// myCompressFn must role-flatten tool messages (same contract as summarizeHistory).
history = await compactHistory(history, myCompressFn, { keepRecentTurns: 4 });
```

Contracts: `history` is a flat `Message[]` with any **system messages inline** (`role: 'system'`). The input adapters (`fromAnthropic` / `fromOpenAI` / `fromGemini`) return `{ system, history }` with system already split out — reassemble `[...system, ...history]` before passing it in. `compactHistory` returns the **input `history` reference unchanged** on a no-op (nothing old enough, or a blank summary), so it is safe to call unconditionally and you can skip persistence via `result === history`.

`keepRecentTurns: 0` is **full compaction** (Claude Code style): the whole conversation collapses into `[...system, <summary>]` with no verbatim tail. This is the simplest result to persist — there is no kept tail to reconcile against your store's unit boundaries. The trade-off is that no verbatim recent context survives, so steer the summary toward a structured handoff via `customCompressionInstructions`. Use a small `keepRecentTurns` instead when the in-flight turn should stay verbatim.

> **ai-sdk users:** prefer `compactModelMessages` / `planCompactionModelMessages` from [`@context-chef/ai-sdk-middleware`](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware) — they take an `AI SDK` prompt and a model directly, wiring the adapter and role-flattening for you.

#### Compression circuit breaker

A failed compression — `compressionModel` throwing, a summary failing `minShrinkRatio`, or a `validateCompression` rejection — leaves history **unchanged** (changed in 4.0: no more placeholder truncation) and increments the breaker. After three consecutive failures, subsequent `compress()` calls become no-ops (history passes through unchanged) until the next successful compression or an explicit `janitor.reset()` / `chef.clearHistory()`. This prevents sessions from hammering a broken compression endpoint on every turn.

The failure counter is part of `JanitorSnapshot` and is preserved by `chef.snapshot()` / `chef.restore()`.

#### `chef.reportTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds `contextWindow`, compression is triggered. In the tokenizer path the default behavior takes the higher of the local calculation and the fed value; use `usagePreference` (below) to change which source wins.

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

#### Choosing the trigger source — `usagePreference`

Only meaningful in the tokenizer path. Controls which token count is consulted when both the local `tokenizer` AND a fed value (`reportTokenUsage()`) are available.

| Value             | Trigger token count                | When to use                                                                                  |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `'max'` (default) | `Math.max(tokenizer, fed)`         | Most conservative — any over-budget signal triggers compression. Backward-compatible.        |
| `'feedFirst'`     | `fed ?? tokenizer`                 | The API's reported usage is authoritative. Useful when one config is shared across providers — some report usage, others rely on the tokenizer fallback. The tokenizer's over-estimation no longer forces premature compression on providers that report real usage. |
| `'tokenizerFirst'`| `tokenizer` (fed is ignored)       | The tokenizer reflects truth and the fed value would mislead the budget decision (e.g. fed includes tokens that will not be in the next call). |

The split index calculation (which messages to keep vs. summarize) is unaffected — it always uses precise per-turn tokenization in the tokenizer path. `usagePreference` only changes the *trigger* decision.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    usagePreference: 'feedFirst', // trust API-reported usage when present
  },
});
```

**Type-level guarantee.** `JanitorConfig` is a discriminated union on the presence of `tokenizer`. Configs without a tokenizer accept only `'max' | 'feedFirst'` — `'tokenizerFirst'` is rejected at compile time because it would have nothing to read from. Both `'max'` and `'feedFirst'` are runtime no-ops in the no-tokenizer path (only one source available), but allowing both lets you ship one config across providers with and without tokenizers.

#### `onBeforeCompress` hook

Fires when the token budget is exceeded, **before** automatic compression. Return a modified `Message[]` to replace the history (e.g., offload tool results to VFS), or return `null` to let default compression proceed.

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

#### `chef.clearHistory(): this`

Explicitly clear history and reset Janitor state when switching topics or completing sub-tasks.

#### Compact (Mechanical Clearing)

`compact()` strips content from history at zero LLM cost:

```typescript
// Clear old tool results, keep 5 most recent
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// Clear thinking blocks
history = janitor.compact(history, { clear: ['thinking'] });

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

Pinned messages (`pinned: true`) are never cleared by `compact()`, and Gemini thought signatures are immune to `compact({ clear: ['thinking'] })`.

> **Important: compact + compress interaction**
>
> When using `compact()` together with `compress()`, only clear `thinking` in compact.
> Clearing `tool-result` before compression causes the compression model to receive empty
> placeholders (`[Old tool result content cleared]`) instead of actual outputs, producing
> low-quality summaries.
>
> ```typescript
> // Correct: thinking only in compact, let compress handle history
> history = janitor.compact(history, { clear: ['thinking'] });
> history = await janitor.compress(history);
>
> // Incorrect: clearing tool-result before compress degrades summary quality
> history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });
> history = await janitor.compress(history); // compression model sees empty tool results
> ```

---

### Server-side context management (v4)

Providers now run compaction server-side (Anthropic `compact_20260112`, OpenAI `/responses/compact`) — one model call fewer and exact token accounting. Delegating LLM compression to the provider is the [`server()` overflow strategy](#built-in-strategies); everything servers don't do stays client-side: tool pruning, skills, memory, the context store, dynamic state.

```typescript
import { server, summarize } from "@context-chef/core";

const chef = new ContextChef({
  overflow: { strategy: server() },
  // portable across providers — non-Anthropic targets run the fallback:
  // overflow: { strategy: server(undefined, { fallback: summarize({ compressionModel }) }) },
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `server` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

- `server()` skips client-side LLM compression entirely on a target that implements it. A construction-time warning fires if a `compressionModel` is also configured — pick one.
- On any other target `server()` has nothing to delegate to, so it runs the `fallback` strategy if one was given, and otherwise leaves history alone. That is what makes one configuration portable across providers.
- `ChefConfig.contextManagement` is the **deprecated alias** (removed in 5.0): `{ strategy: 'server', server: config }` builds `server(config, { fallback: <the default client strategy> })`, which is why v4 behavior is preserved exactly. `{ strategy: 'client' }` is the default and needs no configuration.
- The first argument is a provider-shaped edits config passed through verbatim, e.g. `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` or `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`. `payload.betas` is auto-derived: `'compact-2026-01-12'` for compaction edits, `'context-management-2025-06-27'` for the clear-tool-uses / clear-thinking edits. `AnthropicPayload` gains `context_management?` and `betas?` fields.
- **Compaction block round-trip**: `fromAnthropic` maps the API's `{ type: 'compaction', content }` blocks to passthrough messages marked `pinned: true`, and the Anthropic adapter re-emits the block first, verbatim, on the next compile — server-produced summaries survive the client pipeline untouched.

This is a hybrid positioning, not an either/or: LLM compression can be delegated to the provider while ContextChef keeps doing the parts servers don't — pruning, skills, memory, the context store, and dynamic state.

---

### Context store (4.2)

Everything ContextChef keeps outside the window — memory entries, offloaded tool output, archived spans, the model's own notes — is the same thing at different addresses. Since 4.2 there is one substrate for all of it: a `StorageBackend` that moves bytes, a `Store` that adds namespacing, `context://` URIs, an access index and eviction, and one `context` tool that lets the model reach in.

```typescript
import { ContextChef, FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context"), // memory + notes + vfs + archive, one directory
  memory: {},
  tools: "unified",
});
```

#### Namespaces

| Namespace | Holds | Written by | Shown to the model |
|---|---|---|---|
| `memory` | Durable facts worth carrying between conversations | Memory (TTL, `allowedKeys`, `onMemoryUpdate` all still apply) | injected into every compile |
| `notes` | The model's own working scratch space | the `context` tool | only when it reads them |
| `vfs` | Tool output too large to keep inline | the Offloader | only when it reads them |
| `archive` | Spans of this conversation that overflow evicted | `overflow.archive` | only when it reads them |

In 4.x the archive keeps writing into the `vfs` namespace so existing `context://vfs/...` URIs stay byte-identical; the dedicated `archive/` namespace is ready and becomes the default in 5.0.

#### `StorageBackend`

Four required methods; everything else is an optional capability the `Store` queries before using.

```typescript
interface StorageBackend {
  read(ns: string, path: string): MaybePromise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): MaybePromise<void>;
  delete(ns: string, path: string): MaybePromise<boolean>;
  list(ns: string, prefix?: string): MaybePromise<ListedEntry[]>;

  readAll?(ns: string, prefix?: string): MaybePromise<Record<string, StoredEntry>>;
  exists?(ns: string, path: string): MaybePromise<boolean>;
  append?(ns: string, path: string, content: string): MaybePromise<void>;
  search?(ns: string, query: string): MaybePromise<SearchHit[]>;
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
  getPhysicalPath?(ns: string, path: string): MaybePromise<string | null>;
  /** For backends that must implement a method they cannot honour (legacy wrappers). */
  supports?(capability: StoreCapability, ns?: string): boolean;
}

interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}
```

Every method may be sync or async, and the `Store` passes that choice straight through — a synchronous backend keeps synchronous call sites (`chef.offload`, `memory.snapshot`) working. Asking a namespace for something its backend cannot do throws `StoreCapabilityError` naming the missing capability, instead of failing quietly.

Built-ins: `InMemoryBackend` (ephemeral, testing) and `FileSystemBackend(root, { layouts? })` (one root directory, a per-namespace on-disk layout so both legacy formats keep reading).

#### `Store` and namespaces

```typescript
import { FileSystemBackend, Store } from "@context-chef/core";

const store = new Store(new FileSystemBackend(".context"), {
  eviction: { vfs: { maxFiles: 200, maxBytes: 50 * 1024 * 1024 } },
});

const notes = store.namespace("notes");
await notes.put("plan.md", "# Plan\n");     // addressed write
const { uri } = await notes.put("scratch"); // auto-id write → context://notes/<hash>
await notes.append("plan.md", "- step 2\n");
await notes.get("plan.md");
await notes.list("2026-");                   // prefix filter
await notes.entries();                       // whole namespace in one pass when the backend has readAll
await notes.delete("plan.md");

Store.uri("notes", "plan.md");               // 'context://notes/plan.md'
Store.parseUri("context://notes/plan.md");   // { ns: 'notes', path: 'plan.md' } | null
```

`get` / `put` / `delete` / `list` have `…Sync` variants that throw a clear error rather than returning a promise when the backend turns out to be async. Eviction (`maxAge` / `maxFiles` / `maxBytes`, previously `VFSConfig` fields) is per namespace and applied by `store.cleanup(ns)` / `cleanupAsync(ns)` — mechanism, not policy: nothing sweeps on its own.

#### `ChefConfig.store` and precedence

`store` fills in what nothing else specifies. An explicit `memory.store` wins for memory; an explicit `vfs.store` / `vfs.adapter` / `vfs.storageDir` wins for the VFS. With neither set, today's defaults apply unchanged — so adding `store` to an existing config changes nothing you had already wired by hand.

#### `chef.getStore(): Store`

The store every namespace is addressed through — the shared `ChefConfig.store` when one was passed, otherwise the Offloader's own. Use it to seed notes before a run, or to read what the model wrote after one.

```typescript
await chef.getStore().namespace("notes").put("plan.md", "# Plan\n");
const entry = await chef.getStore().namespace("notes").get("plan.md");
```

#### The `context` tool — `tools: 'unified'`

One static, frozen, reference-stable tool definition covering every namespace. `getContextToolDefinition()` returns it; `ChefConfig.tools: 'unified'` puts it in `payload.tools` for you (plus `new_context` when `overflow.handoff` is configured), and the legacy memory tools are then **not** emitted — the two sets never co-exist in one payload.

```json
{
  "name": "context",
  "parameters": {
    "command": "view | create | str_replace | insert | delete | rename | search",
    "path": "context://<ns>/<path>  (or <ns>/<path>)"
  }
}
```

The schema has exactly one enum (`command`) and no live key list, so it can sit in a cached prefix and never move. What exists right now travels further down the prompt — in the injected memory block and in the results this tool returns — where a change costs a fraction of a cache invalidation.

`tools: 'unified'` also picks the session's vocabulary: the memory instruction and block, the offload truncation marker, the summary wrapper and the default handoff notice are all rewritten around `context://` addressing and name the `context` tool, so the prompt never mentions a tool the payload does not carry. `tools: 'legacy'` (the default in 4.x) emits `create_memory` / `modify_memory` and keeps the 4.1 wording byte for byte.

#### Access policy — `contextTool.writable`

Reading is never restricted: everything in the store is this conversation's own overflow. Writing defaults to `['memory', 'notes']`.

```typescript
new ContextChef({
  store: backend,
  tools: "unified",
  contextTool: { writable: ["notes"] }, // make memory read-only to the model
});
```

The policy is enforced in the dispatcher, not in the store — your own code writes the same store freely. A rejected write comes back as `Error: …` text the model can read and correct, not as a thrown exception.

#### `chef.ownsTool(name): boolean` / `chef.handleTool(call): Promise<string>`

One entry point for every library-owned tool: `context`, `new_context`, and the legacy `create_memory` / `modify_memory` / `recall_context`. `ownsTool` is independent of `ChefConfig.tools` — the mode decides what `compile()` *emits*, not what `handleTool` *understands* — so a migration that emits `context` while the model still occasionally reaches for a legacy name works, and so does the reverse.

```typescript
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments, // JSON string or already-parsed object
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
    continue;
  }
  // ... your own tools
}
```

`arguments` accepts both the JSON string the OpenAI and Anthropic SDKs produce and the parsed object Anthropic's `input` / Gemini's `args` carry. Model-facing mistakes never throw — an unknown path, a missing argument, a write to a read-only namespace and a veto from `onMemoryUpdate` all come back as `Error: …` text. Only a tool name this chef does not own throws, which is what `ownsTool` guards.

Dispatch routes `memory/` through the Memory module, so `allowedKeys`, the `onMemoryUpdate` veto, `onMemoryChanged`, TTL and the update counter all still apply; `notes/` goes straight to the store; `vfs/` and `archive/` are view-only by default and render through the recall path.

#### Deprecated storage interfaces

Each still works — Memory and the Offloader wrap them — and each is removed in 5.0.

| Deprecated | Replacement |
|---|---|
| `MemoryStore` | a `StorageBackend` (or `Store`) as `memory.store`; legacy stores are wrapped with `Store.fromMemoryStore`, mapping `MemoryStoreEntry` onto `StoredEntry.meta` one for one |
| `VFSStorageAdapter` | a `StorageBackend` as `vfs.store`; legacy adapters are wrapped with `Store.fromVfsAdapter`, which serves `vfs` and `archive` from their single flat keyspace |
| `VFSMemoryStore` | `new Store(new FileSystemBackend(dir))` — this class *is* the `memory` namespace of that backend, and reads the same files |
| `FileSystemAdapter` | `FileSystemBackend`, which serves every namespace from one root |
| `Memory.getToolDefinitions()` (`create_memory` / `modify_memory`) | `tools: 'unified'` → the `context` tool, writing the same entries at `context://memory/<key>` through the same validation |

---

### Large Output Offloading (Offloader / VFS)

The Offloader owns the `vfs` namespace of the [context store](#context-store-42): oversized content moves out of the window and leaves a truncation marker carrying a `context://vfs/` URI. Point it at a backend with `vfs.store` (or the chef-wide `store`); `vfs.adapter` and `vfs.storageDir` still work.

```typescript
// Offload if content exceeds threshold; preserves last 2000 chars by default
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: original content if small, or truncated with context://vfs/ URI

// Preserve head (first 500 chars) + tail (last 1000 chars), snapped to line boundaries
const safeOutput = chef.offload(content, { headChars: 500, tailChars: 1000 });

// No preview content — just truncation notice + URI
const safeDoc = chef.offload(largeFileContent, { headChars: 0, tailChars: 0 });

// Override threshold per call
const safeOutput2 = chef.offload(content, { threshold: 2000, tailChars: 500 });
```

Register a tool for the LLM to read full content when needed:

```typescript
// In your tool handler:
import { Offloader } from "@context-chef/core";
const offloader = new Offloader({ storageDir: ".context_vfs" });
const fullContent = offloader.resolve(uri);
```

#### Cleanup & Lifecycle

`.context_vfs/` grows unboundedly without intervention. Configure caps and trigger cleanup yourself — never automatic.

```typescript
const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    maxAge: 24 * 60 * 60 * 1000, // ms since createdAt
    maxFiles: 200,                // LRU evict by accessedAt
    maxBytes: 50 * 1024 * 1024,   // true UTF-8 size (Buffer.byteLength)
    onVFSEvicted: (entry, reason) => {
      // 'maxAge' | 'maxFiles' | 'maxBytes' — errors logged and swallowed
      logger.debug("evicted", entry.uri, reason);
    },
  },
});

// Manual sweep — call from your agent loop, on session end, or wire to compile:done.
const result = await chef.getOffloader().cleanupAsync();
// { evicted, evictedBytes, evictedByAge, evictedByCount, evictedByBytes, failed }

// Override caps for one call (Infinity disables a single cap).
await chef.getOffloader().cleanupAsync({ maxFiles: 0 }); // evict all over-age + all
```

After a process restart, `reconcile()` walks the adapter and adopts orphan files into the in-memory index so subsequent `cleanup()` can see them:

```typescript
const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
// createdAt parsed from legacy vfs_<ts>_<hash>.txt names; content-addressed names date from adoption. bytes measured if requested.
```

Eviction runs in two phases: **A**) `maxAge` sweep relative to `createdAt`, then **B**) single-pass LRU by `accessedAt` ascending until both count and byte caps are satisfied. Cleanup is **mechanism, not policy** — it is never triggered by `compile()`. Wire it to `compile:done` for per-turn enforcement, or call it on a timer / on session end.

Custom `VFSStorageAdapter` implementations must provide optional `list()` / `delete()` methods to enable cleanup; if either is missing, `cleanup()` throws `VFSCleanupNotSupportedError`. The built-in `FileSystemAdapter` implements both. Both are deprecated in 4.2 — implement `StorageBackend` and pass it as `vfs.store` (or use `FileSystemBackend`); legacy adapters keep working, wrapped with `Store.fromVfsAdapter`. New types exported from `@context-chef/core`: `VFSEntryMeta`, `VFSCleanupResult`, `VFSEvictionReason`, `CleanupOptions`, `VFSCleanupNotSupportedError`.

> **Production patterns** — see [`docs/vfs-lifecycle-recipes.md`](../../docs/vfs-lifecycle-recipes.md) for runnable recipes covering long-running servers, serverless cold-start `reconcile()`, AI SDK middleware integration, custom storage adapters (Redis example), and choosing your eviction strategy.

---

### Tool Management (Pruner)

#### Flat Mode

```typescript
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "run_bash", description: "Run a command", tags: ["shell"] },
  {
    name: "get_time",
    description: "Get timestamp" /* no tags = always kept */,
  },
]);

const { tools, removed } = chef.getPruner().pruneByTask("Read the auth.ts file");
// tools: [read_file, get_time]
```

Also supports `allowOnly(names)` and `pruneByTaskAndAllowlist(task, names)`.

#### Runtime Blocklist (Permission Gate)

Block specific tools at dispatch time without breaking KV cache. Useful for permission control, environment safety, sandboxing, rate limits, and feature flags. The compiled `tools` array stays unchanged — enforcement happens via `checkToolCall` in your agent loop.

```typescript
// Set policy (rare event — startup, on user role change, prod env, etc.)
chef.getPruner().setBlockedTools(["delete_file", "tail_logs"]);

// In your agent loop, gate every tool call before dispatch:
for (const call of response.tool_calls) {
  const check = chef.checkToolCall({ name: call.function.name });
  if (!check.allowed) {
    history.push({
      role: "tool",
      tool_call_id: call.id,
      content: check.reason, // e.g. 'Tool "delete_file" is currently blocked.'
    });
    continue;
  }
  await executeTool(call);
}
```

`checkToolCall` returns a discriminated union (`ToolCallCheckResult`), so TypeScript guarantees `reason` is present iff the call is rejected. KV cache is preserved across blocklist changes — the LLM continues to see the full tool set; the gate is dispatch-side only.

#### Namespace + Lazy Loading (Two-Layer Architecture)

**Layer 1 — Namespaces**: Core tools grouped into stable tool definitions. The tool list never changes across turns.

**Layer 2 — Lazy Loading**: Long-tail tools registered as a lightweight XML directory. The LLM loads full schemas on demand via `load_toolkit`.

```typescript
// Layer 1: Stable namespace tools
chef.registerNamespaces([
  {
    name: "file_ops",
    description: "File system operations",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { path: { type: "string" } },
      },
      {
        name: "write_file",
        description: "Write to a file",
        parameters: { path: { type: "string" }, content: { type: "string" } },
      },
    ],
  },
  {
    name: "terminal",
    description: "Shell command execution",
    tools: [
      {
        name: "run_bash",
        description: "Execute a command",
        parameters: { command: { type: "string" } },
      },
    ],
  },
]);

// Layer 2: On-demand toolkits
chef.registerToolkits([
  {
    name: "Weather",
    description: "Weather forecast APIs",
    tools: [
      /* ... */
    ],
  },
  {
    name: "Database",
    description: "SQL query and schema inspection",
    tools: [
      /* ... */
    ],
  },
]);

// Compile — tools: [file_ops, terminal, load_toolkit] (always stable)
const { tools, directoryXml } = chef.getPruner().compile();
// directoryXml: inject into system prompt so LLM knows available toolkits
```

**Agent Loop integration:**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.getPruner().isNamespaceCall(toolCall)) {
    // Route namespace call to real tool
    const { toolName, args } = chef.getPruner().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.getPruner().isToolkitLoader(toolCall)) {
    // LLM requested a toolkit — expand and re-call
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.getPruner().extractToolkit(parsed.toolkit_name);
    // Merge newTools into the next LLM request
  }
}
```

> **One level is enough.** The two-layer namespace → tools depth is the empirically optimal hierarchy for tool selection — deeper nesting hurts accuracy without saving meaningful context (arXiv:2607.17598). Don't nest namespaces inside namespaces.

#### Deferred tool loading — `deferLoading` (v4)

Set `deferLoading: true` on a `ToolDefinition` to annotate it for Anthropic's server-side Tool Search: the flag passes through `payload.tools` verbatim on the Anthropic target, letting the API surface the tool's full schema on demand instead of loading it up front. It is an annotation only — other targets ignore it.

---

### Memory

Persistent key-value memory that survives across sessions — the `memory` namespace of the [context store](#context-store-42), plus the TTL sweep and selector that were never store concerns. Under the default `tools: 'legacy'` it is modified via `create_memory` / `modify_memory`, auto-injected into the payload on `compile()`; under `tools: 'unified'` the `context` tool writes the same entries at `context://memory/<key>`, through the same validation.

`memory.store` accepts a `StorageBackend`, a pre-built `Store`, or a legacy `MemoryStore` (wrapped with `Store.fromMemoryStore`). Passing `ChefConfig.store` fills it in for you. `VFSMemoryStore` still works and reads the same files, but it *is* the `memory` namespace of a `FileSystemBackend` — prefer `new Store(new FileSystemBackend(dir))` so one backend serves every namespace.

```typescript
import { FileSystemBackend, InMemoryStore } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context"), // 4.2 — memory + notes + vfs + archive
  memory: {},
  // memory: { store: new InMemoryStore() },  // or scope a store to memory alone
});

// In your agent loop, intercept memory tool calls:
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") {
      await chef.getMemory().updateMemory(key, value, description);
    } else {
      await chef.getMemory().deleteMemory(key);
    }
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");

// On compile():
// - Memory tools (create_memory, modify_memory) are auto-injected into payload.tools
// - Existing memories are injected as <memory> XML between systemPrompt and history
```

#### Memory placement — `memoryPlacement`

Controls where the volatile `<memory>` data block lands in the compiled payload. Defaults to `'after_system'` (backward compatible). For applications using **Anthropic prompt caching** with cache breakpoints on history, switch to `'before_history_tail'` so memory mutations don't invalidate the history cache.

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(dir),
    memoryPlacement: 'before_history_tail',
  },
});
```

| Placement | Top of sandwich | Last user message | When to use |
|---|---|---|---|
| `'after_system'` (default) | INSTRUCTION + `<memory>` data combined into one `role: 'system'` message | untouched | Simple agents; you don't rely on cache breakpoints past the system parameter |
| `'before_history_tail'` | INSTRUCTION only (stable, cacheable) | appends the `<memory>` data block to the original user content | You want cache breakpoints on history (or earlier `system` blocks) to survive memory mutations on every turn |

The split keeps the stable usage instruction at the top of the sandwich where it caches cleanly, and ships the volatile data block at the tail of the conversation. Anthropic / Gemini adapters extract every `role: 'system'` message into the top-level `system` parameter — under `'before_history_tail'` the data block stays in `messages` instead, so any cache breakpoint earlier in the message stream no longer hashes the changing memory text.

When dynamic state is also injected at the tail (`dynamicStatePlacement: 'last_user'`), the order inside the last user message is: original content → `<memory>` → `<dynamic_state>` → `<implicit_context>` → anchor line. When dynamic state goes to its own system message (`dynamicStatePlacement: 'system'`), memory still injects at the user tail with no anchor.

---

### Skill (Behavior Bundle)

A `Skill` is a portable bundle of `(name + description + instructions + ...)` that scopes the agent's behavior for a specific phase or domain. Activating a skill injects its instructions as a dedicated system message between your system prompt and the memory block — no prompt rewriting on your side. Skills can be inline JS objects or loaded from `SKILL.md` files (same frontmatter shape as Claude Code / Mastra / OpenCode).

```typescript
import { ContextChef, type Skill } from "@context-chef/core";

const planning: Skill = {
  name: "planning",
  description: "Plan changes before editing",
  whenToUse: "When the task is non-trivial and requires multiple steps",
  instructions: "Read code, list affected files, write plan to scratchpad.",
  allowedTools: ["read_file", "grep"], // annotation only — chef does NOT enforce
};

const chef = new ContextChef();
chef.registerSkills([planning]);
chef.activateSkill("planning");
// activateSkill also accepts a Skill object directly, or null to deactivate.

const { messages, meta } = await chef.compile({ target: "openai" });
// messages = [...systemPrompt, { role: 'system', content: planning.instructions }, ...rest]
// meta.activeSkillName === 'planning'
```

#### Loading from `SKILL.md`

```typescript
import {
  loadSkill,
  loadSkillsDir,
  loadSkillsDirs,
  renderSkill,
  formatSkillListing,
} from "@context-chef/core";

// Load a single skill file
const skill = await loadSkill("./skills/db-debug/SKILL.md");

// Or scan a directory: each subdir/SKILL.md becomes a Skill (tolerant — bad files surface in `errors`)
const { skills, errors } = await loadSkillsDir("./skills");
chef.registerSkills(skills);

// Or merge several sources at once (e.g. builtin + user + project) — later dirs
// win on name collisions, dirs are realpath-deduped, and an optional `namespace`
// callback can prefix names per source:
const merged = await loadSkillsDirs([builtinDir, userDir, projectDir], {
  precedence: "last-wins",
});

// Render a system-prompt-friendly listing (useful for LLM-driven `load_skill` tool)
const listing = formatSkillListing(skills, { format: "plain" });
```

`SKILL.md` parsing is tolerant: block scalars (`>` folded / `|` literal), `- item` lists, and kebab-case keys (`allowed-tools`, `when-to-use`) all load. Any frontmatter key chef doesn't recognize is preserved verbatim on `skill.metadata` for your host to read — chef never interprets it (the same annotation-only stance as `allowedTools`). A *known* field written in a malformed nested shape throws, so a typo'd `allowed-tools` surfaces instead of silently disabling restrictions.

The listing lets the LLM pick a skill itself via a `load_skill` tool. Keep the tool definition **static** — the listing goes in your system prompt, not the tool description, and `skill_name` is a plain string, not an enum of registered names. Tool schemas sit at the very top of every provider's prompt prefix, so a listing-bearing description or a live-name enum rewrites the schema whenever the skill set changes and invalidates the entire prompt cache (the same reasoning as the static memory tool schemas, 4.1). Unknown names are caught at dispatch time instead — `activateSkill` throws with the available names:

```typescript
const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill to specialize for the current task. " +
    "The available skills are listed in the system prompt.",
  parameters: {
    skill_name: { type: "string", description: "A skill name from the listing." },
  },
};

// The listing lives in the (stable) system prompt:
chef.setSystemPrompt([
  { role: "system", content: `${basePrompt}\n\nAvailable skills:\n${listing}` },
]);

// In your dispatch loop — dispatch-gate, like the memory tools:
if (call.name === "load_skill") {
  try {
    chef.activateSkill(call.args.skill_name);
    /* push success tool result, continue loop */
  } catch (err) {
    /* push String(err) as the tool result — the model self-corrects */
  }
}
```

#### Rendering arguments (`renderSkill`)

`renderSkill` substitutes `$ARGUMENTS` / `$0..$N` / `$name` / `${VAR}` placeholders in a skill's instructions and returns a new `Skill` (pure — no I/O). Where the rendered skill is delivered is your call: the system slot above (a persistent "mode"), or a host-appended message for progressive disclosure of many skills at once.

```typescript
const triage = await loadSkill("./skills/triage/SKILL.md");

// Fill $ARGUMENTS / $0.. / ${SKILL_DIR} before activating:
chef.activateSkill(renderSkill(triage, { args: "p0 incidents" }));
```

Referenced files (`@./schema.json`, …) are **not** inlined by chef — pass `renderSkill(skill, { includeBaseDir: true })` and let your agent read them on demand via its own file tool.

For the design rationale (Skill ⊥ Pruner decoupling, SKILL.md frontmatter shape, mode-wiring recipes, LLM-driven skill loading, reference files) see [`SKILL_SPEC.md`](../../SKILL_SPEC.md). For argument rendering, multi-source loading, and the two delivery models, see [`docs/skill-interop-design.md`](../../docs/skill-interop-design.md) and the usage recipes in [`docs/skill-recipes.md`](../../docs/skill-recipes.md).

---

### Snapshot & Restore

Capture and rollback full context state for branching or error recovery.

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

---

### Lifecycle Events

Unified event system for observability across all internal modules. Subscribe via `chef.on()`, unsubscribe via `chef.off()`.

```typescript
// Log when history gets compressed
chef.on('compress', ({ summary, truncatedCount }) => {
  console.log(`Compressed ${truncatedCount} messages`);
});

// Track compile metrics
chef.on('compile:done', ({ payload }) => {
  metrics.track('compile', { messageCount: payload.messages.length });
});

// Monitor memory changes
chef.on('memory:changed', ({ type, key, value }) => {
  console.log(`Memory ${type}: ${key}`);
});
```

#### Available Events

| Event | Payload | Description |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | Emitted at the start of `compile()` |
| `compile:done` | `{ payload }` | Emitted after `compile()` produces the final payload |
| `compress:start` | `{ historyLength, currentTokens, limit }` | Budget exceeded — compression is about to run (before summarization) |
| `compress:end` | `{ compressed }` | Compression phase finished. `compressed: false` = budget was fine or the result was rejected |
| `compress` | `{ summary, truncatedCount, details }` | Emitted after Janitor compresses history |
| `offload:created` | `{ uri }` | Content was offloaded to the VFS (via `chef.offload` / `offloadAsync` or the compression archive) |
| `pruner:tool-blocked` | `{ name }` | `checkToolCall()` rejected a tool call against the Pruner blocklist |
| `pipeline:invariant` | `{ phase, message }` | A `pipelineChecks` invariant was violated — a slot handler dropped a pinned message, split a tool pair, or rewrote content ahead of the tail insertion point. Reported only; `compile()` continues |
| `memory:changed` | `{ type, key, value, oldValue }` | Emitted after any memory mutation (set, delete, expire) |
| `memory:expired` | `MemoryEntry` | Emitted when a memory entry expires during `compile()` |

Events are **observation-only** — they don't affect control flow. To participate in a compile, register on a [pipeline slot](#pipeline-slots-42) instead; `onMemoryUpdate` and `onBeforeCompress` remain config callbacks.

**Handler error isolation (v4).** A throwing or rejecting event handler is logged and the remaining handlers still run — pre-4.0, a throwing handler failed the whole `compile()`.

Events coexist with existing config callbacks: if you provide `onCompress` in `JanitorConfig`, it fires first, then the `compress` event is emitted.

#### Cancellation — `compile({ signal })`

Pass an `AbortSignal` to `compile()` to cancel an in-flight compile and propagate the signal to all event handlers fired during that call.

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // hard 5s budget

chef.on('compile:done', async ({ payload }, signal) => {
  // signal === controller.signal — forward it to slow async work
  await db.write(payload, { signal });
});

try {
  await chef.compile({ target: 'openai', signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    // compile was cancelled at the Janitor / onBeforeCompile / transformContext boundary
  }
  throw err;
}
```

Two effects: (1) signal forwarded to every handler as the second argument; (2) `compile()` itself calls `signal.throwIfAborted()` after Janitor compress, after `onBeforeCompile`, and after `transformContext`. `compile:start` fires before the first abort check, so observers may receive a `compile:start` for a compile that ultimately throws without firing `compile:done`. Memory events from external `memory().set()` / `delete()` (outside `compile()`) get `signal: undefined`.

#### Concurrency Model

**Canonical: one `ContextChef` instance per concurrent caller.** Chef state (in-flight signal, memory turn, active skill, history) is held across `await` points; per-request instantiation isolates each call — no shared mutable state, no race.

```typescript
// One chef per request — no shared mutable state, no race
const chef = new ContextChef({ memory: { store: sharedMemoryStore } });
chef.setHistory(history);
const payload = await chef.compile({ target: 'openai' });
```

For cross-request memory, extract the store (`VFSMemoryStore` or external Redis-backed) and pass to per-request chefs.

Sharing one chef across concurrent `compile()` calls is **single-threaded by design** — concurrent calls clobber `_currentSignal`, double-advance the memory turn counter, and interleave skill/history reads. Serialize per instance (chained `await`), or use the per-request pattern. Snapshot+serialize defensive option is in the roadmap (TODO T2.4.1, low priority) but not required for canonical usage.

---

### Pipeline slots (4.2)

`compile()` is a fixed, ordered list of phases — `start`, `transform-tool-results`, `handoff`, `overflow`, `inject`, `memory`, `skill`, `assemble`, `tail`, `adapt`, `audit`, `done`. Slots are the public composition surface at those boundaries: unlike an event handler, a slot handler *participates* in the compile — it can inject context, transform the assembled messages, or skip overflow entirely.

#### `chef.use(slot, handler): this`

Registers a handler. Handlers run in registration order and are awaited one after another. The deprecated config hooks are registered on this same registry at construction, so they always run first.

```typescript
const chef = new ContextChef();

chef.use("before-assemble", async (ctx) => {
  const snippets = await vectorDB.search(ctx.dynamicStateXml);
  ctx.inject(snippets.map((s) => s.content).join("\n"));
});

chef.use("after-adapt", (payload) => metrics.record(payload));
```

Errors are **not** isolated the way event-handler errors are: a throwing slot handler fails the compile, exactly like the legacy config hooks it generalizes. Wrap your own logic in try/catch if a failure should be survivable.

#### `chef.unuse(slot, handler): this`

Removes one registration. Registering the same function twice takes two `unuse` calls.

#### The six slots

```typescript
interface SlotHandlers {
  /** Return false to skip the overflow phase for this compile. */
  "before-overflow": (ctx: { history: readonly Message[]; budget: BudgetInfo }) => void | false | Promise<void | false>;
  /** `result` is null when the phase was skipped. */
  "after-overflow": (ctx: { history: Message[]; result: OverflowResult | null }) => void | Promise<void>;
  /** Runs before the sandwich is assembled; `ctx.inject(text)` adds an <implicit_context> block. */
  "before-assemble": (ctx: BeforeAssembleContext) => void | Promise<void>;
  /** Transforms the assembled sandwich. Handlers chain: each receives the previous result. */
  "after-assemble": (messages: Message[]) => Message[] | Promise<Message[]>;
  /** Observes the final message array right before the target adapter runs. */
  "before-adapt": (messages: readonly Message[]) => void | Promise<void>;
  /** Observes the compiled payload, before `compile:done`. */
  "after-adapt": (payload: TargetPayload) => void | Promise<void>;
}
```

`ctx.inject(text)` accumulates: multiple calls, and multiple handlers, are joined in registration order separated by a blank line; empty strings are ignored.

```typescript
// Ride out a small overshoot instead of compressing on every turn.
chef.use("before-overflow", ({ budget }) => {
  if (budget.remaining > -1_000) return false;
});
```

#### Deprecated hooks

Both still work unchanged — they are registered on the same slot registry at construction, ahead of any later `use()` call — and both are removed in 5.0.

| Deprecated | Replacement |
|---|---|
| `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', (ctx) => ctx.inject(text))` — the returned string becomes the `inject` argument |
| `ChefConfig.transformContext` | `chef.use('after-assemble', (messages) => messages)` |

Two neighbours that are **not** deprecated: `ChefConfig.transformToolResult` is a per-message transform inside the `transform-tool-results` phase rather than a slot, and `JanitorConfig.onBeforeCompress` stays a runner concern — it fires at the same boundary as `before-overflow` and now receives the runner's real budget.

```typescript
// 4.1 and earlier — still valid
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.dynamicStateXml);
    return snippets.map((s) => s.content).join("\n");
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```

#### Dev invariants — `pipelineChecks`

With `pipelineChecks: true`, `compile()` verifies after every `after-assemble` handler that pinned messages survived and tool call/result pairs are still paired, and after the `tail` phase that nothing ahead of the tail insertion point changed.

Violations are **reported, never enforced**: each goes to `ChefConfig.logger` (or `console`) and to the `pipeline:invariant` event, and `compile()` never throws because of a check. It costs a snapshot plus a serialization pass per compile, so keep it off in production. Default `false`.

```typescript
const chef = new ContextChef({ pipelineChecks: true });

chef.on("pipeline:invariant", ({ phase, message }) => {
  console.warn(`[${phase}] ${message}`);
});
```

---

### Target Adapters

| Feature                      | OpenAI                      | Anthropic                              | Gemini                                     |
| ---------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions            | Messages API                           | generateContent                            |
| Cache breakpoints            | Stripped                    | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support                         | Degraded to `[System Note]`                |
| `thinking` field             | Stripped                    | Mapped to `ThinkingBlockParam`         | Stripped                                   |
| Tool calls                   | `tool_calls` array          | `tool_use` blocks                      | `functionCall` parts                       |

Adapters are selected automatically by `compile({ target })`. You can also use them standalone:

```typescript
import { getAdapter } from "@context-chef/core";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

#### `openai-responses` target (v4)

A fourth built-in target for the OpenAI Responses API. `compile({ target: "openai-responses" })` produces an `OpenAIResponsesPayload { instructions?, input, tools?, meta? }`, and `fromOpenAIResponses(items, instructions?)` is the matching input adapter:

```typescript
import { fromOpenAIResponses } from "@context-chef/core";

const payload = await chef.compile({ target: "openai-responses" });
const { system, history } = fromOpenAIResponses(response.output, instructions);
```

The round-trip handles `message` / `function_call` / `function_call_output` items (joined by `call_id`, out-of-order safe), preserves reasoning items' `encrypted_content` byte-identically, and converts `input_image` / `input_file` parts to IR attachments.

#### Gemini thought signatures (v4)

Gemini 3.x rejects current-turn function calls whose thought signatures are missing (HTTP 400). `fromGemini` captures them — `ToolCall.thoughtSignature` for `functionCall` parts, a passthrough field for text parts — and `GeminiAdapter` re-emits them verbatim. They are immune to `compact({ clear: ['thinking'] })`.

#### `preserveThinkingAsText` (v4)

`new OpenAIAdapter({ preserveThinkingAsText: true })` / `new GeminiAdapter({ preserveThinkingAsText: true })` convert Anthropic-style `thinking` into a `<thinking>...</thinking>` text prefix instead of dropping it — useful when moving a Claude conversation to another provider mid-session. `redacted_thinking` is never textified (dropped, with one warning). Default `false`.

#### Custom adapters — `adapterRegistry` and `defaultTarget`

The three built-ins (`'openai' | 'anthropic' | 'gemini'`) are registered automatically. To plug in a third-party provider (Cohere, Mistral, an in-house protocol), implement `ITargetAdapter` and register it once:

```typescript
import { adapterRegistry, ITargetAdapter } from "@context-chef/core";

class CohereAdapter implements ITargetAdapter {
  compile(messages) {
    /* return Cohere-shaped payload */
  }
}

adapterRegistry.register("cohere", new CohereAdapter());
await chef.compile({ target: "cohere" }); // routed via the registry
```

`compile({ target })` accepts three forms:

| Form                  | Example                                | Use case                                      |
| --------------------- | -------------------------------------- | --------------------------------------------- |
| Built-in literal      | `compile({ target: "openai" })`        | Strict payload type via the type overloads    |
| Registered name       | `compile({ target: "cohere" })`        | Reuse the same custom adapter many times      |
| `ITargetAdapter`      | `compile({ target: new MyAdapter() })` | One-off use / tests — bypasses the registry   |

Set `defaultTarget` once in the constructor to avoid repeating it on every call:

```typescript
const chef = new ContextChef({ defaultTarget: "anthropic" });
await chef.compile(); // → AnthropicPayload
```

Resolution order in `compile()`:
`options.target` → `ChefConfig.defaultTarget` → `'openai'` (final built-in fallback).

For plugin systems and test isolation, pass a `sourceId` so a batch of registrations can be torn down together:

```typescript
adapterRegistry.register("cohere", new CohereAdapter(), "my-plugin");
adapterRegistry.register("mistral", new MistralAdapter(), "my-plugin");
// Later — unload the entire plugin in one call
adapterRegistry.unregisterBySource("my-plugin");
```

> **Replacing a built-in name** (e.g. `register('openai', myFork)`) keeps the strict overload's payload return type — `compile({ target: 'openai' })` is still typed `Promise<OpenAIPayload>`, so your replacement must honor that shape at runtime. TypeScript can't enforce this for you.

---

## Skill

ContextChef ships with a [Claude Code Skill](https://docs.anthropic.com/en/docs/claude-code/skills) that helps you integrate the library into your project interactively. The skill analyzes your existing codebase (LLM provider, package manager, project structure) and generates tailored integration code.

### Install the Skill

```bash
npx skills add MyPrototypeWhat/context-chef
```

### Use

Open [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) in your project and type:

```
/context-chef-core
```

Claude will:

1. **Detect your setup** — which LLM SDK you use (OpenAI / Anthropic / Gemini), package manager, TypeScript vs JavaScript
2. **Ask about your needs** — history compression, tool management, memory, VFS offloading, snapshot/restore
3. **Generate integration code** — tailored to your project structure and existing agent loop
4. **Explain the architecture** — the sandwich model, cache breakpoints, dynamic state placement

## License

MIT
