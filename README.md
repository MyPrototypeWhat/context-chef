<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/raw/main/docs-site/public/logo.svg" width="88" alt="ContextChef" />
</p>

# ContextChef

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/core Downloads](https://img.shields.io/npm/dm/@context-chef/core.svg?label=%40context-chef%2Fcore%20downloads)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/ai-sdk-middleware Downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg?label=%40context-chef%2Fai-sdk-middleware%20downloads)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![@context-chef/tanstack-ai Downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg?label=%40context-chef%2Ftanstack-ai%20downloads)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/core.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

Context compiler for TypeScript/JavaScript AI agents.

ContextChef solves the most common context engineering problems in AI agent development: conversations too long for the model to remember, too many tools causing hallucinations, having to rewrite prompts when switching providers, and state drift in long-running tasks. It doesn't take over your control flow — it just compiles your state into an optimal payload before each LLM call.

📖 **Docs:** [Document](https://myprototypewhat.github.io/context-chef/) · [中文文档](./README.zh-CN.md)

## Packages

| Package | Description |
|---|---|
| [`@context-chef/core`](./packages/core) | Core context compiler — overflow strategies, tool pruning, one addressed context store, pipeline slots, multi-provider adapters |
| [`@context-chef/ai-sdk-middleware`](./packages/ai-sdk-middleware) | [Vercel AI SDK](https://sdk.vercel.ai) middleware — drop-in context engineering with zero code changes |
| [`@context-chef/tanstack-ai`](./packages/tanstack-ai) | [TanStack AI](https://tanstack.com/ai) middleware — compression, truncation, and dynamic state via `ChatMiddleware` |

### Zero-config AI SDK integration

If you use the Vercel AI SDK, you can get transparent history compression and tool result truncation with just 2 lines:

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000 },
});

// Everything below stays exactly the same
const result = await generateText({ model, messages, tools });
```

See the [`@context-chef/ai-sdk-middleware` README](./packages/ai-sdk-middleware/README.md) for full documentation.

### TanStack AI middleware

If you use TanStack AI, drop in the middleware for transparent context management:

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
      truncate: { threshold: 5000 },
    }),
  ],
});
```

See the [`@context-chef/tanstack-ai` README](./packages/tanstack-ai/README.md) for full documentation.

### Full control with `@context-chef/core`

For direct control over the compilation pipeline — dynamic state injection, tool namespaces, memory, snapshot/restore — use the core library directly:

## Blog Series

1. [Why "Compile" Your Context](https://myprototypewhat.cn/context-chef-1-why-compile-context-en)
2. [Janitor — Separating Trigger Logic from Compression Policy](https://myprototypewhat.cn/context-chef-2-janitor-en)
3. [Pruner — Decoupling Tool Registration from Routing](https://myprototypewhat.cn/context-chef-3-pruner-en)
4. [Offloader/VFS — Relocate Information, Don't Destroy It](https://myprototypewhat.cn/context-chef-4-offloader-vfs-en)
5. [Core Memory — Zero-Cost Reads, Structured Writes](https://myprototypewhat.cn/context-chef-5-core-memory-en)
6. [Snapshot & Restore — Capture Everything That Determines the Next Compile](https://myprototypewhat.cn/context-chef-6-snapshot-en)
7. [The Provider Adapter Layer — Let Differences Stop at Compile Time](https://myprototypewhat.cn/context-chef-7-adapters-en)
8. [Five Extension Points in the Compile Pipeline](https://myprototypewhat.cn/context-chef-8-hooks-en)

## How it fits together

ContextChef compiles unbounded information into a bounded window. Every feature in this README sits on exactly one of five axes — that is the whole map:

| Axis | Question | What answers it |
|---|---|---|
| **① Selection** | What goes into the window | `overflow.strategy` (history), `Pruner` (tools), `memory.selector` (facts), `pinned: true` (what can never leave) |
| **② Placement** | Where in the window it goes | the sandwich — system layers → history → tail stitch — plus `memoryPlacement`, `skillPlacement`, `dynamicStatePlacement`, announcement channels, and the cache-stable prefix |
| **③ Persistence** | Where it lives when it is out of the window | one `StorageBackend` behind one `Store`, addressed as `context://<ns>/<path>`: `memory/`, `notes/`, `vfs/`, `archive/` |
| **④ Retrieval** | How the model reaches back outside the window | the `context` tool (+ `new_context`), dispatched through `chef.ownsTool` / `chef.handleTool` |
| **⑤ Adaptation** | Provider wire format | target adapters — OpenAI / Anthropic / Gemini / your own |

Overflow is not a sixth thing: it is information moving from ① to ③, recoverable via ④. `summarize` / `anchored` / `reset` are ① policies, `memory/` / `notes/` / `vfs/` / `archive/` are ③ namespaces, `view` / `search` / `recall_context` are ④ handles. When you are looking for "where does X live", find X's axis first.

Everything on those axes is mechanism, not policy: no combination of choices is rejected, and the failure classes that cannot be prevented (a rewritten cache prefix, a dropped pinned message, a split tool pair) are *reported* through the audit and event channels rather than blocked.

## Features

**① Selection — what stays in the window**

- **Conversations too long?** — Automatically compress history, preserve recent memory, delegate old messages to a small model for summarization
- **Losing constraints to compression?** — Constraint pinning (v4): `pinned: true` messages survive compression verbatim and are never cleared by `compact()`
- **One policy doesn't fit?** — Overflow strategies (4.2): `summarize` / `anchored` / `reset`, composed with `chain()` and `background()`, or your own `OverflowStrategy`
- **Provider does compaction for you?** — `server()` strategy delegates LLM compression to Anthropic's server-side compaction while pruning/skills/memory/VFS stay client-side
- **Compression latency on the hot path?** — `background()` runs summarization off-turn and swaps it in only when still valid; `anchored()` merges evicted spans into a persistent summary document instead of rewriting it
- **Own your message store?** — Durable compaction: `planCompaction` / `compactHistory` (plus AI SDK and TanStack ports) compact your store once and persist the result, instead of re-compressing in-flight on every call
- **Window about to be cut?** — Handoff budget (4.2): reserve tokens above the trigger and the model gets one notice to persist state before eviction happens mechanically
- **Too many tools?** — Dynamically prune the tool list per task, or use a two-layer architecture (stable namespaces + on-demand loading) to eliminate tool hallucinations
- **Need to block tools at runtime?** — Pruner blocklist + `checkToolCall` gate for permission, environment safety, rate limits, and sandboxing — KV-cache preserving by default

**② Placement — where in the window it lands**

- **Mode-based behavior?** — `Skill` primitive bundles instructions and tool annotations per phase; loadable from `SKILL.md` files (compatible with Claude Code / Mastra / OpenCode formats)
- **Capabilities change mid-session?** — Announcements (4.1): `announce()` states what tools/skills came or went and re-renders it into every compile until retracted; `skillPlacement: 'tail'` moves skill instructions out of the cached prefix so switching modes never invalidates it
- **Long tasks drifting?** — Zod schema-based state injection forces the model to stay aligned with the current task on every call
- **Output format drifting?** — Guardrail: `withGuardrails` enforces an XML output contract and sets an assistant prefill, auto-degraded on providers without native prefill
- **Prompt cache invalidated every turn?** — `memoryPlacement: 'before_history_tail'` and `skillPlacement: 'tail'` keep volatile text out of the cached prefix; `cacheAudit` names anything left inside it

**③ Persistence — where it lives once it is out of the window**

- **Terminal output too large?** — Auto-truncate and offload to `vfs/`, keeping error lines + a `context://` URI pointer for on-demand retrieval
- **Can't remember across sessions?** — `memory/` lets the model persist key information (project rules, user preferences), auto-injected on the next session
- **Summary dropped a detail you need back?** — Reversible archive: the full pre-overflow span is stored and cited by URI in the summary that replaced it
- **Four storage interfaces for one job?** — One `StorageBackend` behind one `Store` (4.2): memory, notes, offloaded output and archived spans are the same substrate at different addresses
- **Need to rollback?** — Snapshot & Restore captures and rolls back full context state for branching and exploration

**④ Retrieval — how the model reaches back**

- **A tool per namespace?** — One `context` tool (4.2) covering view / create / str_replace / insert / delete / rename / search, dispatched through `chef.handleTool`; opt in with `tools: 'unified'`
- **Model knows the chunk is finished?** — `new_context` + `chef.requestNewContext()` (4.2) force the next compile to open a fresh window
- **Need external context?** — The `before-assemble` slot (`onBeforeCompile` before 4.2) lets you inject RAG results, AST snippets, or MCP queries before compilation

**⑤ Adaptation — provider wire format**

- **Switching providers?** — Same prompt architecture compiles to OpenAI / Anthropic / Gemini with automatic prefill, cache, and tool call format adaptation

**Across the pipeline**

- **Need to compose?** — Pipeline slots (4.2): `chef.use('before-overflow' | 'after-overflow' | 'before-assemble' | 'after-assemble' | 'before-adapt' | 'after-adapt', handler)`
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

> **Removed in 4.0** — each has a direct replacement: `TokenUtils` → `estimate` / `estimateObject`, `XmlGenerator` → `objectToXml`, `AdapterFactory` → `getAdapter` / `adapterRegistry`, `JanitorConfig.onBudgetExceeded` → `onBeforeCompress`. See [MIGRATION-4.md](./MIGRATION-4.md) for the full migration guide.

### `new ContextChef(config?)`

```typescript
const chef = new ContextChef({
  janitor?: JanitorConfig,                       // ① when the window is over budget
  overflow?: { strategy?: OverflowStrategy, archive?: 'vfs' | CompressionArchiveConfig, handoff?: { budgetTokens: number, prompt?: string } },
  pruner?: { strategy?: 'union' | 'intersection' },
  memory?: MemoryConfig,                         // ③ the memory/ namespace
  vfs?: { threshold?: number, store?: StorageBackend | Store, storageDir?: string, maxAge?: number, maxFiles?: number, maxBytes?: number, onVFSEvicted?: (entry, reason) => void },
  store?: StorageBackend | Store,                // ③ one backend for every namespace
  tools?: 'legacy' | 'unified',                  // ④ which library-owned tools compile() emits
  contextTool?: { writable?: string[] },         // ④ namespaces the model may write to
  skillPlacement?: 'after_system' | 'tail',      // ②
  defaultTarget?: TargetProvider | ITargetAdapter, // ⑤
  logger?: ChefLogger,
  cacheAudit?: boolean,                          // warn on volatile content inside the cached prefix
  pipelineChecks?: boolean,                      // dev invariants, reported never enforced
  transformToolResult?: (content: string, info: { toolName: string | null; toolCallId: string | null }) => string | Promise<string>,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,   // @deprecated → use('after-assemble')
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>, // @deprecated → use('before-assemble')
});
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

**Cache-safe placement (4.1).** `placement: 'last_user'` delivers the enforce-XML instruction through the last-user-message tail injection (same channel as dynamic state) instead of a system message. This matters on Anthropic: every `role: 'system'` message is hoisted into the top-level `system` prefix, so under the default `placement: 'system'` any guardrail change invalidates cache breakpoints downstream of it. `prefill` is unaffected either way.

#### `chef.compile(options?): Promise<TargetPayload>`

Compiles everything into a provider-ready payload. Triggers Janitor compression. Registered tools are auto-included.

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

---

### History Compression (Janitor)

Janitor provides two compression paths. Choose the one that fits your setup:

#### Path 1: Tokenizer (precise control)

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

Don't hand-roll the counting function — `createTokenizerAdapter` (4.1) wraps any `(text) => tokens` encoder and encodes the fields-counted convention once (content + thinking + redacted data + **tool-call names/arguments** — the field hand-rolled adapters most often miss, and where write/edit tools carry the bulk of a coding-agent span):

```typescript
import { createTokenizerAdapter } from "@context-chef/core";
import { encode } from "gpt-tokenizer"; // or js-tiktoken, etc. — your dependency, not ours

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: createTokenizerAdapter(encode) },
});
```

Cross-provider counts are approximate (o200k is exact only for OpenAI), which is safe under the default `triggerRatio: 0.7` headroom; for exact accounting use `reportTokenUsage()` with provider-reported usage.

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

Runner options — when compression fires, what it is measured against, and what happens around it. These are Janitor's own and are unaffected by which [overflow strategy](#overflow--what-leaves-the-window-42) is installed:

| Option                          | Type                                        | Default    | Description                                                                                  |
| ------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `contextWindow`                 | `number`                                    | _required_ | Model's context window size (tokens). Compression triggers when usage exceeds `contextWindow × triggerRatio`. |
| `triggerRatio`                  | `number`                                    | `0.7`      | Fraction of `contextWindow` at which compression fires ("pre-rot"). Set `1` to restore the pre-4.0 trigger-at-window behavior. |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —          | Enables the tokenizer path for precise per-message token calculation.                        |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`    | Which token source drives the trigger when both `tokenizer` and `reportTokenUsage` are set. Without `tokenizer`, the value union narrows to `'max' \| 'feedFirst'` — TypeScript rejects `'tokenizerFirst'` at compile time. See the [core package README](./packages/core) for the full breakdown. |
| `onCompress`                    | `(summary, count, details) => void`         | —          | Fires after compression with the summary message and truncated count. `details.compressedMessages` is the exact slice of history the summary replaced. |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —          | Fires before LLM compression. Return modified history to intervene, or null to proceed normally. Same registry as the `before-overflow` slot. |
| `logger`                        | `ChefLogger`                                | —          | Sink for degradation warnings (storage/compaction); defaults to `console`. |
| `strategy`                      | `OverflowStrategy`                          | —          | The policy the runner applies. When building a `Janitor` directly; through `ContextChef` use `overflow.strategy`. |

Policy options — the same fields as ever, now the options of `summarize()` / `anchored()`. Set here (the 4.1 spelling) they build the default strategy; set an explicit `overflow.strategy` and it wins, with a one-time warning:

| Option                          | Type                                        | Default    | Description                                                                                  |
| ------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —          | Async hook to summarize old messages via a low-cost LLM.                                     |
| `customCompressionInstructions` | `string`                                    | —          | Additional focused instructions appended to the default compression prompt (additive, not replacement). |
| `compressionGuidelines`         | `string[]`                                  | —          | Numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`. |
| `toolResultStubThreshold`       | `number`                                    | —          | Replace tool-result content longer than this many chars with a one-line metadata stub before summarizing (saves summarizer tokens). |
| `minShrinkRatio`                | `number`                                    | `0.5`      | Quality gate: a summary must shrink the compressed span by at least this ratio (spans ≥ 2000 chars only); otherwise the compression fails and history is unchanged. `0` disables. |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | Post-summarization gate. Return `false` (or throw) to reject the summary — history unchanged, circuit breaker incremented. |
| `preserveRatio`                 | `number`                                    | `0.8`      | [Tokenizer path] Ratio of the effective budget (`contextWindow × triggerRatio`) to preserve for recent messages. |
| `preserveRecentMessages`        | `number`                                    | `1`        | [reportTokenUsage path] Number of recent turns to keep when compressing.                     |
| `archive` _(deprecated)_        | `CompressionArchiveConfig \| 'vfs'`         | —          | → `overflow.archive`, which applies to every strategy. Reversible compression: store the full pre-compression span, cite its URI in the summary. |
| `compressionMode` _(deprecated)_ | `'rewrite' \| 'incremental-anchored'`      | `'rewrite'`| → `overflow.strategy: summarize(...)` / `anchored(...)`. |
| `compressionScheduling` _(deprecated)_ | `'blocking' \| 'background'`          | `'blocking'` | → `overflow.strategy: background(...)`. |

**Compression output contract.** Janitor's default prompt instructs the compression model to produce an `<analysis>` scratchpad (stripped from the final output) followed by a structured `<summary>` block with 5 domain-agnostic sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Raw output is piped through `Prompts.formatCompactSummary` before injection. See the [core package README](./packages/core) for the full contract and `customCompressionInstructions` usage.

**Failure semantics (changed in 4.0).** A compression-model failure — a throw, a summary that fails `minShrinkRatio`, or a `validateCompression` rejection — leaves history **unchanged** (pre-4.0 truncated it with a placeholder) and increments the circuit breaker. If three consecutive `compress()` calls fail, `compress()` becomes a no-op until the next successful compression or an explicit `janitor.reset()` / `chef.clearHistory()`. The failure counter is preserved by `chef.snapshot()` / `chef.restore()`.

**Standalone summarization.** `summarizeHistory(messages, compress, opts?): Promise<string>` is the provider-agnostic primitive behind this path — call it directly to compress a slice in your own store. Empty slice → `''`; stateless and **throws** if `compress` throws; the `compress` callback **must role-flatten** `tool` roles. Options include `customCompressionInstructions`, `toolResultStubThreshold`, `compressionGuidelines`, and `baseInstruction`. See the [core package README](./packages/core) for the full contract, and [Durable compaction](#durable-compaction) below for the higher-level helpers.

#### Compression quality gates (v4)

v4 rebuilt the compression path around one rule: a bad summary must never replace good history. These gates belong to the runner and the summarizing strategies, so they hold whatever `overflow.strategy` you install.

- **Pre-rot trigger — `triggerRatio` (default `0.7`)**: compression fires at `contextWindow × 0.7` instead of at the hard limit — model quality degrades well before the window is full. `preserveRatio` applies to this effective budget. `triggerRatio: 1` restores the pre-4.0 behavior.
- **Constraint pinning — `pinned: true`**: pinned messages survive `compress()` verbatim (re-inserted after the summary, in order) and are never cleared by `compact()`. Pinning any message of an atomic turn protects the whole turn. Every strategy receives the pinned set and must return it untouched. Use it for policy and constraint text — compaction that drops policy text raises violation rates from 0% to 30%+ (arXiv:2606.22528).
- **Shrink guard — `minShrinkRatio` (default `0.5`)**: a summary that doesn’t shrink the compressed span by ≥ 50% (character length; spans ≥ 2000 chars only) is a failed compression — history unchanged, circuit breaker incremented. Prevents compression death loops. `0` disables. Under `anchored()` the guard compares anchor *growth* rather than absolute size.
- **`validateCompression`**: post-summarization gate `(summary, { compressed, kept }) => boolean | Promise<boolean>` — return `false` or throw to reject the result (history unchanged, breaker incremented).
- **`compressionGuidelines`**: numbered domain guidelines injected into the compression prompt, before `customCompressionInstructions`.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200_000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    triggerRatio: 0.7,       // default — compress "pre-rot"
    minShrinkRatio: 0.5,     // default — reject summaries that barely shrink
    compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  },
  overflow: { archive: "vfs" },   // reversible: full span stored, summary cites a context:// URI
});

// Pin constraint text — survives compress() verbatim, never cleared by compact()
history.push({
  role: "user",
  content: "NEVER touch prod. Deploy only from CI.",
  pinned: true,
});
```

The three policy choices that used to live here — reversible `archive`, incremental-anchored mode, background scheduling — are strategies now: see [Overflow](#overflow--what-leaves-the-window-42). Reading an archived span back is in [Recall](#recall--reading-an-archived-span-back).

#### Durable compaction

In-flight compression (above) rewrites each outgoing payload but does not touch your message store — for a sustained over-budget conversation the summary is recomputed on every call. When you own the store, compact it once and persist the result. All three helpers split on atomic turn boundaries (an assistant message and its tool results never separate), summarize the old slice, and return `[...system, <summary>, ...recent turns]`; on a no-op the input reference is returned unchanged, so you can skip persistence via `result === input`.

Core — provider-agnostic, operates on IR `Message[]`:

```typescript
import { compactHistory, planCompaction } from "@context-chef/core";

// myCompressFn must role-flatten tool messages (same contract as summarizeHistory)
history = await compactHistory(history, myCompressFn, { keepRecentTurns: 4 });
// planCompaction(history, { keepRecentTurns }) is the synchronous split behind it
```

Vercel AI SDK — `ModelMessage` altitude, role-flattening wired for you:

```typescript
import { compactModelMessages } from "@context-chef/ai-sdk-middleware";

messages = await compactModelMessages(messages, openai("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

TanStack AI — takes any TanStack text adapter:

```typescript
import { compactTanStackMessages } from "@context-chef/tanstack-ai";

messages = await compactTanStackMessages(messages, openaiText("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

`keepRecentTurns: 0` is full Claude-Code-style compaction — the whole conversation collapses into `[...system, <summary>]`. Don't combine durable compaction with in-flight compression on the same conversation (double compression). See the [core](./packages/core), [ai-sdk-middleware](./packages/ai-sdk-middleware), and [tanstack-ai](./packages/tanstack-ai) READMEs for the full contracts.

#### `chef.reportTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds `contextWindow`, compression is triggered. In the tokenizer path, the default is to take the higher of the local calculation and the fed value; switch via `usagePreference` if you want `'feedFirst'` (trust the API truth) or `'tokenizerFirst'` (ignore fed entirely).

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

#### `onBeforeCompress` hook

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

#### Mechanical Compaction (`compact`)

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

#### `ensureValidHistory(history)`

Standalone utility that sanitizes message history to satisfy LLM API invariants (orphan tool result removal, missing tool result placeholder injection, first-non-system-must-be-user). Use when loading history from a database or after manual modifications.

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

> **Boundary contract.** All input adapters (`fromOpenAI` / `fromAnthropic` / `fromGemini`, plus middleware-internal `fromAISDK` / `fromTanStackAI`) run their output through `ensureValidHistory` automatically — they're the system boundary between external SDK formats and ContextChef IR. `chef.setHistory(IR)` does NOT sanitize: IR is treated as an internal protocol, and history you construct (or mutate) directly is trusted to satisfy the invariants. Wrap with `ensureValidHistory(...)` explicitly when in doubt.

#### `chef.clearHistory(): this`

Explicitly clear history and reset Janitor state when switching topics or completing sub-tasks.

---

### Overflow — what leaves the window (4.2)

Janitor decides **when** the window is over budget. An `OverflowStrategy` decides **what leaves it**. Until 4.2 those were one class; they are now the runner and the policy, and the policy is a value you pass:

```typescript
import { ContextChef, chain, summarize, reset } from "@context-chef/core";

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },   // runner: budget, trigger, breaker
  overflow: {
    strategy: chain(summarize({ compressionModel: callGpt4oMini }), reset()),
    archive: "vfs",                                  // whatever is evicted stays retrievable
    handoff: { budgetTokens: 2_000 },                // one warning before the cut
  },
});
```

Nothing else moved. `contextWindow`, `tokenizer`, `usagePreference`, `triggerRatio`, `onCompress`, `onBeforeCompress`, `logger`, the circuit breaker, the `compress:*` events and durable compaction are runner concerns and stay on [`JanitorConfig`](#janitorconfig) exactly as they were. What `overflow.strategy` replaces is the `janitor.compression*` fields and `contextManagement` — see [Deprecated overflow options](#deprecated-overflow-options-42); they still work.

#### Built-in strategies

Each is a factory in the barrel. Pick by what you are willing to pay:

| Strategy | What it does | What it costs |
|---|---|---|
| `summarize(opts)` | Replaces the oldest turns with an LLM summary of them. The 4.x default (`compressionMode: 'rewrite'`). | One extra model call per overflow, and the whole summary is rewritten each time. Anything the summary omits is gone from the window unless `archive` is on. |
| `anchored(opts)` | Keeps a persistent anchor document and merges only the newly evicted span into it, instead of regenerating the summary from scratch (Factory.ai pattern). | The anchor grows monotonically and eventually needs its own budget. Its shrink guard compares anchor *growth*, not absolute size. |
| `server(config, { fallback })` | On a target with server-side context management (today: Anthropic) the client never compresses — the overflow phase is skipped and the payload carries `context_management` + betas. | On every other target there is nothing to delegate to: `fallback` runs, or history is left alone when none is given. |
| `reset(opts)` | Keeps the pinned messages, evicts everything else, leaves a one-line notice naming the closed window. | Zero model calls — and lossy unless `archive` is configured. That combination is documented, not enforced. |
| `chain(...strategies)` | Runs the next strategy when the previous one changed nothing or left the history still over the trigger. | Nothing on the happy path; a full escalation is every strategy's cost in one compile. |
| `background(strategy)` | Runs `strategy` off-turn: the over-budget compile returns history unchanged and a later compile swaps the result in — only while the summarized span is still the head of the current history (arXiv:2605.08580). | One or more compiles go out over budget before the swap lands, stale results are discarded, and background state is not snapshotted. |

`summarize()` and `anchored()` take the same options — the fields that used to live on `JanitorConfig`:

```typescript
summarize({
  compressionModel: async (msgs) => callGpt4oMini(msgs),
  compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  customCompressionInstructions: "Keep every unresolved question.",
  minShrinkRatio: 0.5,          // default — reject summaries that barely shrink
  validateCompression: (summary, { compressed, kept }) => summary.includes("Next Steps"),
  preserveRatio: 0.8,           // [split: 'ratio'] keep this share of the trigger budget
  preserveRecentMessages: 1,    // [split: 'recent-turns'] keep this many turns
  toolResultStubThreshold: 5_000,
  split: "ratio",               // defaults from which preserve option you set
});
```

`split` is the one new field: `'ratio'` prices the preserved tail with the runner's tokenizer, `'recent-turns'` counts turns instead. Without an explicit `overflow.strategy`, the chef picks `'ratio'` when a `tokenizer` is configured and `'recent-turns'` otherwise — the same split the two Janitor paths always used.

Escalation is the reason `chain` exists:

```typescript
// Summarize normally; when the summarizer is down or its output keeps failing
// the shrink guard, drop the window instead of growing forever.
overflow: {
  strategy: chain(summarize({ compressionModel }), reset()),
  archive: "vfs",
}
```

A strategy is just an object, so your own is a first-class citizen:

```typescript
import type { OverflowStrategy } from "@context-chef/core";

const dropToolResults: OverflowStrategy = {
  name: "drop-tool-results",
  async apply({ history, pinned, window }) {
    const keep = new Set(pinned);
    const evicted = history.filter((m) => m.role === "tool" && !keep.has(m));
    return {
      history: history.filter((m) => !evicted.includes(m)),
      evicted,
      meta: { strategy: "drop-tool-results", windowId: window.current, changed: evicted.length > 0 },
    };
  },
};
```

Optional `commit(result)`, `snapshot()` and `restore(state)` round out the interface: `apply` may run speculatively (that is what `background()` does), so state derived from your own output — an anchor document — is published in `commit`, which only ever runs for a result that actually entered the window.

#### Reversible archive — `overflow.archive`

Archiving is strategy-agnostic since 4.2: whatever a strategy evicts is serialized, stored, and cited by URI in the summary that replaced it, so exact details stay retrievable instead of being guessed at by importance scoring (arXiv:2607.25066, arXiv:2607.08032).

```typescript
overflow: { strategy: reset(), archive: "vfs" }               // store spans in this chef's VFS
overflow: { archive: { store: async (serialized, { messageCount }) => uploadToS3(serialized) } }
```

Best-effort: a store failure logs a warning and skips the citation rather than failing the compile. In 4.x archived spans keep landing in the `vfs` namespace, so `context://vfs/...` URIs stay byte-identical to 4.1; the dedicated `archive/` namespace is a 5.0 switch. Pair it with the [`context` tool](#the-context-tool-42) (or `recall_context` under the legacy tool set) so the model can pull a span back.

#### The handoff budget (4.2)

Overflow is mechanical: what a strategy evicts is gone from the window whether or not the model was ready for it. The handoff budget reserves a slice of headroom *above* the trigger and spends it on one notice, so the model can write what matters into the context store while the conversation is still in front of it.

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    handoff: { budgetTokens: 4_000 },   // notice fires while remaining ≤ 4000
    strategy: reset(),
    archive: "vfs",
  },
});
```

- The notice is rendered **once per window** — a long stretch near the trigger does not repeat it every turn — and the flag resets when the window id changes.
- It rides the same tail channel as announcements (`channel: 'auto'`) and is **never persisted**: it does not enter your history, does not appear in `getAnnouncements()`, and is skipped on server-managed compiles.
- The default text is `Prompts.HANDOFF_NOTICE_TEMPLATE`. A custom `prompt` may use `{n_remaining}`, replaced with the headroom left before the trigger (rounded, clamped at 0), and is capped at 2000 UTF-8 bytes.
- `budgetTokens` must be a positive integer; both it and the prompt are validated at construction, not at the compile that would silently skip the notice.

```typescript
overflow: {
  handoff: {
    budgetTokens: 4_000,
    prompt:
      "About {n_remaining} tokens remain before compression. " +
      "Write anything that must survive to context://notes/handoff.md now.",
  },
}
```

#### `new_context` — the model's handle on the window (4.2)

`chef.requestNewContext()` forces the next `compile()` to run the overflow strategy whatever the budget says. Unlike `clearHistory()` it does not discard the conversation behind the library's back: the installed strategy still decides what survives, `archive` still applies, and a `before-overflow` handler can still veto it.

```typescript
import { getNewContextToolDefinition } from "@context-chef/core";

chef.registerTools([getNewContextToolDefinition()]);   // static, no parameters, cache-safe

// In your agent loop:
if (call.function.name === "new_context") {
  chef.requestNewContext();
  history.push({ role: "tool", tool_call_id: call.id, content: "Starting a new context window." });
}
```

Under `tools: 'unified'` the definition is emitted for you whenever `overflow.handoff` is configured, and `chef.handleTool` dispatches it — see [the `context` tool](#the-context-tool-42). The request is consumed by one compile whether or not the window actually changed (a strategy may decline; the circuit breaker may be open), so call it again if it must be retried.

#### Window lineage — `meta.windowId` (4.2)

Each context window has an id. The runner allocates a new one **at commit time**, only when an overflow result actually enters the window — a stale `background()` result that gets discarded never advances it.

```typescript
const payload = await chef.compile({ target: "anthropic" });
payload.meta?.windowId; // 'w_…' — changes exactly when history behind the model was rewritten
```

Two payloads carrying the same id were compiled against the same window, so a change is the signal that the conversation the model can see was rewritten — useful for invalidating your own caches or writing a window boundary into your store. `OverflowResult.meta.windowId` is the window a strategy *acted on*; `CompileMeta.windowId` is the window the payload belongs to. `anchored()` keys its anchor document by window id, the lineage rides `snapshot()` / `restore()`, and `clearHistory()` starts a fresh one.

#### Server-side context management

Providers now run compaction server-side (Anthropic `compact_20260112`, OpenAI `/responses/compact`) — one model call fewer and exact token accounting. `server()` delegates LLM compression to the provider; everything servers don't do stays client-side: tool pruning, skills, memory, VFS offloading, dynamic state.

```typescript
import { server, summarize } from "@context-chef/core";

const chef = new ContextChef({
  overflow: {
    // Anthropic → the server compacts. Everything else → summarize locally.
    strategy: server(undefined, { fallback: summarize({ compressionModel }) }),
  },
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `config` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

- On a server-managed target the client-side overflow phase is skipped entirely; mechanical `compact()` and every other module still run.
- The first argument is a provider-shaped edits config passed through verbatim, e.g. `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` or `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`. `payload.betas` is auto-derived: `'compact-2026-01-12'` for compaction edits, `'context-management-2025-06-27'` for the clear-tool-uses / clear-thinking edits.
- **Compaction block round-trip**: `fromAnthropic` maps the API's `{ type: 'compaction', content }` blocks to passthrough messages marked `pinned: true`, and the Anthropic adapter re-emits the block first, verbatim, on the next compile — server-produced summaries survive the client pipeline untouched.

This is a hybrid positioning, not an either/or: LLM compression can be delegated to the provider while ContextChef keeps doing the parts servers don't — pruning, skills, memory, VFS, and dynamic state. AI SDK users get a matching guard: the middleware detects `providerOptions.anthropic.contextManagement` on a call and skips its own compression for that call (see the [ai-sdk-middleware README](./packages/ai-sdk-middleware/README.md#anthropic-server-side-context-management)).

The deprecated `contextManagement: { strategy: 'server' }` builds `server(config, { fallback: <the default client strategy> })` for you, which is exactly the v4 behavior.

#### Deprecated overflow options (4.2)

Every field below still works and is unchanged in behavior — each one now *builds* the strategy on the right. They are removed in 5.0; setting both a field and an explicit `overflow.strategy` logs a warning once and the strategy wins.

| Deprecated | Replacement |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(strategy)` |
| `janitor.archive` | `overflow.archive` (now applies to every strategy, not just `summarize`) |
| `contextManagement: { strategy: 'server', server }` | `overflow.strategy: server(server, { fallback })` |
| `janitor.{compressionModel, compressionGuidelines, customCompressionInstructions, minShrinkRatio, validateCompression, preserveRatio, preserveRecentMessages, toolResultStubThreshold}` | the options of `summarize()` / `anchored()` |
| `JanitorSnapshot.anchorDoc` | `JanitorSnapshot.strategy` (opaque strategy state; pre-4.2 snapshots still restore their anchor) |

---

### Context store (4.2)

Everything ContextChef keeps *outside* the window is the same thing at different addresses: durable facts, the model's working notes, tool output that was too large to keep inline, and spans of conversation that were compacted away. Since 4.2 they share one substrate — a `StorageBackend` that moves bytes, wrapped in a `Store` that adds namespaces, `context://` addressing, an access index and eviction.

| Namespace | Holds | In the window? | Writable by the model |
|---|---|---|---|
| `memory/` | Durable facts worth carrying between sessions | Injected into every compile | Yes (default) |
| `notes/` | The model's own scratchpad | Never — that is the point | Yes (default) |
| `vfs/` | Offloaded tool output, addressed by the URI left in its place | Only what it reads back | No (read-only by default) |
| `archive/` | Full pre-overflow spans behind a summary's citation | Only what it reads back | No (read-only by default) |

```typescript
import { ContextChef, FileSystemBackend, InMemoryBackend, Store } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"), // one backend for every namespace
  memory: {},
  vfs: { threshold: 5_000 },
});

await chef.getStore().namespace("notes").put("plan.md", "# Plan\n");
Store.uri("notes", "plan.md");                 // 'context://notes/plan.md'
Store.parseUri("context://notes/plan.md");     // { ns: 'notes', path: 'plan.md' }
```

`ChefConfig.store` fills in what nothing else specifies: an explicit `memory.store` still wins for memory, and an explicit `vfs.store` / `vfs.adapter` / `vfs.storageDir` still wins for the VFS. With neither set, the 4.1 defaults apply unchanged.

Built-in backends are `InMemoryBackend` (process lifetime; the default when nothing is configured) and `FileSystemBackend` (one root directory, per-namespace layout, atomic writes). A backend is four required methods — `read` / `write` / `delete` / `list` — plus optional `readAll`, `exists`, `append`, `search`, `snapshot`, `restore` and `getPhysicalPath`, each queried as a capability: asking a namespace for something its backend cannot do throws `StoreCapabilityError` (or, from the `context` tool, comes back as an error the model can read) instead of failing silently.

```typescript
// Pass a pre-built Store when you want per-namespace eviction or URI schemes
const store = new Store(new InMemoryBackend(), {
  eviction: { vfs: { maxFiles: 200, maxBytes: 50 * 1024 * 1024 } },
});
const chef = new ContextChef({ store, memory: {} });

const notes = chef.getStore().namespace("notes");
await notes.put("plan.md", "# Plan\n", { description: "current plan" });
await notes.append("plan.md", "- ship 4.2\n");
notes.uri("plan.md");                       // 'context://notes/plan.md'
if (notes.supports("search")) await notes.search("ship");
const { path } = await chef.getStore().namespace("vfs").put("big output"); // content-addressed id
```

Every `NamespaceView` method mirrors its backend's sync-or-async nature, so a synchronous backend keeps synchronous call sites (`chef.offload`, `memory.snapshot`) working; `getSync` / `putSync` / `deleteSync` / `listSync` are the explicit sync variants, and they throw a directed error rather than silently degrade when the backend answers with a Promise.

**The four old storage interfaces still work.** They are wrapped, not reimplemented, and every existing test of them stays green — but they are removed in 5.0:

| Deprecated | Replacement |
|---|---|
| `MemoryStore` (`memory.store`) | `StorageBackend` (or a `Store`); wrapped via `Store.fromMemoryStore`, `MemoryStoreEntry` mapping onto `StoredEntry.meta` one for one |
| `VFSStorageAdapter` (`vfs.adapter`) | `StorageBackend` as `vfs.store`; wrapped via `Store.fromVfsAdapter`, serving `vfs` and `archive` from its flat keyspace |
| `VFSMemoryStore(dir)` | `new Store(new FileSystemBackend(dir))` as `memory.store` — it *is* the `memory` namespace on that backend, and reads the same files |
| `FileSystemAdapter(dir)` | `FileSystemBackend(dir)`, which serves every namespace from one root |

`InMemoryStore` is not deprecated — it is still the simplest ephemeral `memory.store` for tests — but a single `InMemoryBackend` now covers every namespace at once.

#### Memory — the `memory/` namespace

Persistent key-value memory that survives across sessions, injected into every compile. Nothing about its semantics changed in 4.2; it simply reads and writes `context://memory/<key>` now.

```typescript
import { ContextChef, FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"),
  memory: {
    defaultTTL: 20,                          // bare number = turns; { ms } / { turns } also accepted
    allowedKeys: ["persona", "project_rules"],
    selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
    onMemoryUpdate: (key, value, oldValue) => key !== "locked",  // veto: false blocks the write
    onMemoryChanged: (event) => audit.log(event),
    onMemoryExpired: (entry) => audit.log(entry),
    memoryPlacement: "before_history_tail",
  },
});

// Direct read/write (developer use, bypasses the validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");
```

`allowedKeys` restricts what the model may create, `selector` filters/sorts/truncates what gets injected (after expired entries are swept), TTL expiry fires `memory:expired` during `compile()`, and the whole namespace round-trips through `chef.snapshot()` / `chef.restore()`. On `compile()`, existing entries are injected as a `<memory>` block and — under the default `tools: 'legacy'` — the `create_memory` / `modify_memory` tools are added to `payload.tools`.

Under `tools: 'legacy'` you dispatch those two yourself, exactly as in 4.1:

```typescript
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") await chef.getMemory().updateMemory(key, value, description);
    else await chef.getMemory().deleteMemory(key);
  }
}
```

Both definitions are **static** since 4.1 — same schema, same object references on every compile, regardless of what keys exist. (Previously `modify_memory` embedded an enum of live keys and appeared only when keys existed; tools sit at the top of every provider's prompt prefix, so each key mutation invalidated the entire prompt cache.) Current keys are surfaced through the injected memory block instead, and unknown-key dispatches still fail safely at `updateMemory` / `deleteMemory`. `chef.handleTool` dispatches both for you if you would rather not write the branch — see [the `context` tool](#the-context-tool-42).

##### Memory placement — `memoryPlacement`

Controls where the volatile `<memory>` data block lands in the compiled payload. Defaults to `'after_system'` (backward compatible). For applications using **Anthropic prompt caching** with cache breakpoints on history, switch to `'before_history_tail'` so memory mutations don't invalidate the history cache.

| Placement | Top of sandwich | Last user message | When to use |
|---|---|---|---|
| `'after_system'` (default) | INSTRUCTION + `<memory>` data, combined into one `role: 'system'` message | untouched | Simple agents; you don't rely on cache breakpoints past the system parameter |
| `'before_history_tail'` | INSTRUCTION only (stable, cacheable) | appends the `<memory>` data block to the original user content | You want cache breakpoints on history (or earlier `system` blocks) to survive memory mutations on every turn |

The split keeps the stable usage instruction at the top of the sandwich where it caches cleanly, and ships the volatile data block at the tail of the conversation. Anthropic / Gemini adapters extract every `role: 'system'` message into the top-level `system` parameter — under `'before_history_tail'` the data block stays in `messages` instead, so any cache breakpoint earlier in the message stream no longer hashes the changing memory text.

When dynamic state is also injected at the tail (`dynamicStatePlacement: 'last_user'`), the order inside the last user message is: original content → `<memory>` → `<dynamic_state>` → `<implicit_context>` → anchor line. When dynamic state goes to its own system message (`dynamicStatePlacement: 'system'`), memory still injects at the user tail with no anchor.

##### Anthropic cache audit (4.1)

Volatile content sitting inside the cached prompt prefix silently invalidates prompt caching on every change. The audit checks a compiled Anthropic payload for exactly that — memory data, dynamic state, implicit context, or guardrail instructions placed at or before the last `cache_control` breakpoint — and names the fix per issue:

```typescript
import { auditAnthropicCachePlacement } from "@context-chef/core";

const payload = await chef.compile({ target: "anthropic" });
for (const issue of auditAnthropicCachePlacement(payload)) {
  console.warn(`${issue.location}: ${issue.message}`);
}

// Or let the chef warn automatically (each distinct issue once per instance):
const chef = new ContextChef({ cacheAudit: true /* Anthropic targets only */ });
```

It recognizes the memory block by its header in **both** vocabularies, so the audit keeps working under `tools: 'unified'`.

**Anthropic-only by design**: it is the one provider with explicit, client-visible breakpoints, so the check is fully deterministic — a structural property of the payload, zero heuristics. OpenAI's automatic prefix cache and Gemini's implicit cache expose no marks to audit against, so no equivalent is offered for them.

#### Large output offloading — the `vfs/` namespace

```typescript
// Offload if content exceeds threshold; preserves last 2000 chars by default
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: original content if small, or truncated with a context://vfs/ URI

// Preserve head (first 500 chars) + tail (last 1000 chars), snapped to line boundaries
const safeOutput = chef.offload(content, { headChars: 500, tailChars: 1000 });

// No preview content — just truncation notice + URI
const safeDoc = chef.offload(largeFileContent, { headChars: 0, tailChars: 0 });

// Override threshold per call
const safeOutput2 = chef.offload(content, { threshold: 2000, tailChars: 500 });
```

The truncation marker the model sees names the URI it can read the full content back from. Reading it back is the retrieval axis: `chef.resolveRecall(uri)`, the `recall_context` tool under the legacy tool set, or `view` on the `context` tool under `unified`.

##### Cleanup & lifecycle

`.context_vfs/` (or your store's root) grows unboundedly without intervention. Configure caps and trigger cleanup yourself — never automatic.

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

After a process restart, `reconcile()` walks the store and adopts orphan files into the in-memory index so subsequent `cleanup()` can see them:

```typescript
const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
// createdAt parsed from legacy vfs_<ts>_<hash>.txt names; content-addressed names date from adoption. bytes measured if requested.
```

Cleanup is **mechanism, not policy** — it is never triggered by `compile()`. Wire it to `compile:done` for per-turn enforcement, or call it on a timer / on session end. The LRU index and the caps themselves moved onto the `Store` in 4.2 (`eviction: { vfs: { … } }`); the `vfs.maxAge` / `maxFiles` / `maxBytes` fields set that policy and are passed on every sweep, so they keep working even against a `Store` you built yourself. A backend without `list()` / `delete()` cannot be swept: `cleanup()` throws `VFSCleanupNotSupportedError` (both built-in backends implement them).

> **Production patterns** — see [`docs/vfs-lifecycle-recipes.md`](./docs/vfs-lifecycle-recipes.md) for runnable recipes covering long-running servers, serverless cold-start `reconcile()`, AI SDK middleware integration, custom storage adapters (Redis example), and choosing your eviction strategy.

#### Recall — reading an archived span back

With `overflow.archive` (or VFS offloading) enabled, the full span behind a summary stays retrievable by URI:

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

`resolveRecall(uri, { format: 'text' })` renders a stored message span as readable text instead of raw JSON. Under `tools: 'unified'` this is `view` on the `context` tool and `chef.handleTool` does the dispatch — `getRecallToolDefinition()` remains for legacy setups.

#### The `context` tool (4.2)

`ChefConfig.tools` picks which library-owned tools `compile()` emits:

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"),
  memory: {},
  tools: "unified",                            // default: 'legacy'
  contextTool: { writable: ["memory", "notes"] },  // the default policy
  overflow: { handoff: { budgetTokens: 2_000 } },
});
```

- `'legacy'` (default): the Memory module's `create_memory` / `modify_memory`. `recall_context` and `new_context` stay opt-in — register them yourself.
- `'unified'`: one `context` tool covering every namespace, plus `new_context` when `overflow.handoff` is configured. The legacy trio is not emitted; the two sets never co-exist in one payload.

**The default cannot flip in a minor release.** Tool names are dispatch keys in your agent loop — a `if (call.function.name === 'create_memory')` branch stops matching the moment the payload starts saying `context`. `'unified'` becomes the default in 5.0.

The tool is `memory_20250818`-shaped: one static, frozen, reference-stable definition with exactly one enum (`command`), so no live key list ever enters the cached prefix. Seven commands, addressed by `context://<ns>/<path>` (the prefix is optional, so `notes/plan.md` works too):

| Command | Does | Notes |
|---|---|---|
| `view` | Reads an entry, or lists a namespace/directory | Line-numbered for `notes/`; `vfs/` and `archive/` render through the recall path |
| `create` | Writes a new entry | Fails when one already exists |
| `str_replace` | Swaps the single exact occurrence of `old_str` | Ambiguous or missing match is an error the model reads |
| `insert` | Puts `insert_text` at 0-based `insert_line` | |
| `delete` | Removes an entry | |
| `rename` | Moves an entry to `new_path` in the same namespace | Implemented as create + delete |
| `search` | Finds entries under `path` matching `query` | Falls back to list + get when the backend has no native `search` |

`memory/` operations route through the Memory module, so `allowedKeys`, the `onMemoryUpdate` veto, `onMemoryChanged`, TTL and the update counter all apply exactly as they do for the legacy tools. `notes/` goes straight to the store. `vfs/` and `archive/` are view-only by default.

##### One dispatch entry — `chef.ownsTool` / `chef.handleTool`

```typescript
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,   // JSON string or already-parsed object
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
    continue;
  }
  await executeYourOwnTool(call);
}
```

`ownsTool` covers `context`, `new_context` **and** the legacy `create_memory` / `modify_memory` / `recall_context`, independently of `tools` mode — the mode decides what `compile()` emits, not what the dispatcher understands, so a migration where the model occasionally reaches for an old name still works. Model-facing mistakes never throw: an unknown path, a missing argument, a write to a read-only namespace and a veto from `onMemoryUpdate` all come back as `Error: …` text the model can read and correct. Only a tool name this chef does not own throws — that is a routing bug, so guard with `ownsTool`.

##### Write policy — `contextTool.writable`

Reading is never restricted: everything in the store is this conversation's own overflow, and a model that can be handed a `context://` URI can be handed what is behind it. Writing is:

```typescript
new ContextChef({ contextTool: { writable: ["notes"] } });                  // memory read-only
new ContextChef({ contextTool: { writable: ["memory", "notes", "vfs"] } }); // let it edit offloaded output
```

The policy is enforced in the dispatcher, not in the store — the store moves bytes, and your own code writes to any namespace freely.

##### One vocabulary

`tools` also picks the words the model reads. Under `'unified'` the memory instruction and memory block, the offload truncation marker, the summary wrapper (which then carries the `Context window: … (previous: …)` lineage line) and the default handoff notice are all rewritten in `context://` addressing and name the `context` tool — so the prompt never mentions a tool the payload does not carry. Under `'legacy'` every one of those strings is byte-identical to 4.1. The two vocabularies are `LEGACY_VOCABULARY` / `UNIFIED_VOCABULARY`, resolved once per chef; a standalone `Memory` / `Offloader` / `Janitor` built without a chef keeps the 4.x wording.

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

#### Skill placement — `skillPlacement` (4.1)

Where the active skill's instructions are delivered. The default `'after_system'` is the behavior above, bit-for-bit: a dedicated `role: 'system'` message right after your system prompt. Those tokens live in the cacheable prefix — free to re-send — but every activation, switch, or deactivation rewrites that prefix and costs one full cache invalidation.

Under `'tail'` the instructions leave the prefix entirely and lead the tail stitch, wrapped in `<skill_instructions skill="NAME">`:

```typescript
const chef = new ContextChef({ skillPlacement: "tail" });
chef.registerSkills([planning, editing]); // two Skill objects, shaped like the one above
chef.setSystemPrompt([{ role: "system", content: basePrompt }]).setHistory(history);

chef.activateSkill("planning");
const a = await chef.compile({ target: "anthropic" });
chef.activateSkill("editing");
const b = await chef.compile({ target: "anthropic" });

// `a` and `b` are byte-identical up to the last user message — activating,
// switching, and deactivating never touch the cached prefix. Only the tail moved:
//   <skill_instructions skill="editing">…</skill_instructions>
```

The trade-off is real in both directions: `'tail'` re-sends the full instruction text uncached on **every** request; `'after_system'` re-sends nothing but pays a cache miss on **every switch**. Pick `'tail'` when the agent switches modes often relative to how long each mode stays active, `'after_system'` for a mode that is set once and lives for the session.

Placement changes delivery only — `meta.activeSkillName`, `getActiveSkill()`, and snapshot/restore behave identically. In the tail, the skill block leads the fixed stitch order (`<skill_instructions>` → `<memory>` → `<dynamic_state>` → `<implicit_context>` → `<announcements>` → anchor) so the model reads "who you are right now" before the state it applies to, and it does **not** trigger the anchor line on its own — it is self-describing inside its own tag. If `cacheAudit` catches a `<skill_instructions` block at or before your last `cache_control` breakpoint, the breakpoint is too late, not the placement.

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

// Scan a directory: each subdir/SKILL.md becomes a Skill. Tolerant — bad
// files surface in `errors`, and `warnings` (4.1) reports mechanical quality
// findings (thin descriptions, oversized instructions, malformed
// allowedTools, dangling relative resource links) without blocking the load.
const { skills, errors, warnings } = await loadSkillsDir("./skills");
for (const w of warnings) console.warn(`${w.path}: ${w.message}`);
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

For the design rationale (Skill ⊥ Pruner decoupling, SKILL.md frontmatter shape, mode-wiring recipes, LLM-driven skill loading, reference files) see [`SKILL_SPEC.md`](./SKILL_SPEC.md). For argument rendering, multi-source loading, and the two delivery models, see [`docs/skill-interop-design.md`](./docs/skill-interop-design.md) and the usage recipes in [`docs/skill-recipes.md`](./docs/skill-recipes.md).

---

### Announcements (4.1)

Capabilities change mid-session: a permission is granted, a toolkit is loaded, a rate limit withdraws `web_search`. The payload changes shape, but nothing tells the model *what* changed — it keeps calling the tool that vanished, or ignores the one that just appeared. `announce()` states the change and keeps stating it until you retract it.

```typescript
chef.announce("tools:added", "Tools newly available: read_file, grep");
chef.announce(
  "tools:removed",
  "web_search has been withdrawn; calls to it will be rejected",
);

chef.getAnnouncements();
// [{ id: 'tools:added', content: '…', channel: 'auto' }, { id: 'tools:removed', … }]

chef.retractAnnouncement("tools:added"); // → true; the next compile carries no trace of it
```

Every standing announcement renders into one block, in insertion order:

```xml
<announcements>
<announcement id="tools:added">
Tools newly available: read_file, grep
</announcement>

<announcement id="tools:removed">
web_search has been withdrawn; calls to it will be rejected
</announcement>
</announcements>
```

**State, not event.** An announcement is a statement of the *current* capability set, re-rendered into every `compile()` — not a one-shot message appended to history. That is the point: chef's injections never persist into your history, so a retracted announcement disappears completely from subsequent payloads instead of lingering as an obsolete turn the model keeps re-reading. `announce()` upserts by `id` — re-announcing the same id replaces content and channel while keeping the original insertion position, so the block stays stable as it is updated. `retractAnnouncement(id)` returns whether anything was removed.

#### Channels

| Channel | Where it renders | Notes |
|---|---|---|
| `'user_tail'` | joins the tail stitch of the last user message — after `<dynamic_state>` / `<implicit_context>`, before the anchor line | Works on every provider. Unlike skill instructions and memory data, announcements *do* trigger the "Above is the current system state" anchor — they are system state |
| `'system'` | one combined `_positional` system message placed right after the conversational tail (and still in front of any assistant prefill) | Operator precedence, and the cached prefix stays intact |
| `'auto'` (default) | routes by **target**: `'system'` on the Anthropic target, `'user_tail'` everywhere else | See the caveat below |

Channels are per-announcement, so a mixed set splits across both delivery paths within a single compile. The [handoff notice](#the-handoff-budget-42) rides this same channel resolution — rendered last, for that one compile only, and never added to the standing set.

**The auto-routing caveat.** `'auto'` routes by *target*, not by model — chef never sees your model id. Mid-conversation `role: "system"` messages are native on Fable 5 / Mythos 5 / Opus 4.8 / Opus 5, but **not on Sonnet 5**. If you compile for the Anthropic target and call Sonnet 5, pass the channel explicitly:

```typescript
chef.announce("tools:added", "Tools newly available: grep", { channel: "user_tail" });
```

Mechanism, not policy — chef will not guess your model for you.

The `'system'` channel rides `Message._positional`: a `role: 'system'` message flagged positional stays *at its position* in the stream instead of being hoisted into the provider's top-level system parameter. Per adapter: Anthropic emits a mid-conversation system message (falling back to hoisting, with a one-time warning, if it would precede every user/tool message); OpenAI Chat Completions keeps system messages inline anyway, so the flag is a no-op; the Responses adapter emits an inline `message` item instead of folding the text into `instructions`; Gemini has no system role in `contents` and degrades it to a `user` entry verbatim.

**Wording matters.** State facts, do not command. "Tools newly available: read_file, grep" and "web_search has been withdrawn; calls to it will be rejected" read as system state. "You must now use read_file" reads as an instruction competing with your system prompt — and the model will weigh it against everything else you told it.

**Lifecycle.** Announcements survive `clearHistory()` — they describe the current capability set, which a fresh conversation still needs; retract them explicitly when the change no longer holds. They ride `ChefSnapshot` and round-trip through `snapshot()` / `restore()`; restoring a snapshot taken before 4.1 (no `announcements` field) yields an empty set rather than leaving the previous ones live. With `cacheAudit: true`, an `<announcements>` block caught at or before your last `cache_control` breakpoint is flagged — announcements always render at the conversational tail, so move the breakpoint earlier.

#### Detecting the delta (userland)

There is no automatic tool-delta detection. Chef renders what you announce; deciding *what changed* is policy and stays in your loop:

```typescript
let previousTools = new Set<string>();

function syncToolAnnouncements(next: string[]) {
  const added = next.filter((name) => !previousTools.has(name));
  const removed = [...previousTools].filter((name) => !next.includes(name));

  if (added.length) {
    chef.announce("tools:added", `Tools newly available: ${added.join(", ")}`);
  } else {
    chef.retractAnnouncement("tools:added"); // no longer new — stop repeating it
  }

  if (removed.length) {
    chef.announce(
      "tools:removed",
      `Withdrawn; calls to these will be rejected: ${removed.join(", ")}`,
    );
  } else {
    chef.retractAnnouncement("tools:removed");
  }

  previousTools = new Set(next);
}

// Pairs with the Pruner blocklist — the gate rejects, the announcement explains:
chef.getPruner().setBlockedTools(["delete_file"]);
chef.announce("tools:blocked", "delete_file is disabled in this environment");
```

Call it wherever your tool list is decided — right before you build the request, or from a `compile:done` handler if the Pruner owns the list (`payload.tools`), remembering that an announcement made there lands on the *next* compile, not the one that just finished.

Related: `ToolDefinition.deferLoading` annotates a tool as withheld from the initial context (Anthropic tool search, and the `mid-conversation-tool-changes` beta's `tool_addition` mechanism); deferred definitions are stripped before the cache key is computed, so adding them never invalidates an existing cache entry. Announcements are the text-side counterpart — chef's IR is text-content based, so `tool_addition` / `tool_removal` content blocks are not passed through.

---

### Snapshot & Restore

Capture and rollback full context state for branching or error recovery.

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

---

### Pipeline slots (4.2)

`compile()` is an ordered list of named phases — `start` → `transform-tool-results` → `handoff` → `overflow` → `inject` → `memory` → `skill` → `assemble` → `tail` → `adapt` → `audit` → `done`. Slots are the composition points fired at those boundaries. Unlike events, a slot handler **participates** in the compile: it can veto overflow, inject context, or rewrite the assembled messages.

```typescript
chef
  .use("before-assemble", async (ctx) => ctx.inject(await vectorDB.search(ctx.dynamicStateXml)))
  .use("after-adapt", (payload) => metrics.record(payload));

chef.unuse("after-adapt", handler); // removes one registration
```

| Slot | Signature | Contract |
|---|---|---|
| `before-overflow` | `({ history, budget }) => void \| false` | Return `false` to skip the overflow phase for this compile. `budget` is the runner's real reading: `{ limit, current, trigger, remaining }` |
| `after-overflow` | `({ history, result }) => void` | `result` is `null` when the phase was skipped; otherwise `OverflowResult` with `meta.strategy` / `meta.changed` / `meta.windowId` |
| `before-assemble` | `(ctx) => void` | `ctx` is the `BeforeCompileContext` plus `inject(text)`; injected blocks accumulate in registration order into `<implicit_context>` |
| `after-assemble` | `(messages) => Message[]` | Handlers chain — each receives the previous one's result |
| `before-adapt` | `(messages) => void` | Read-only view of the final message array, before the target adapter runs |
| `after-adapt` | `(payload) => void` | Read-only view of the compiled payload, before `compile:done` |

Handlers run in **registration order** and are awaited one after another. The legacy config hooks register on this same registry at construction, so they always run first — there is no second code path:

| Deprecated field | Registers as |
|---|---|
| `ChefConfig.onBeforeCompile` | `before-assemble` (the returned string becomes `ctx.inject(...)`) |
| `ChefConfig.transformContext` | `after-assemble` |

Both keep working unchanged and are removed in 5.0. `ChefConfig.transformToolResult` is **not** deprecated: it is a per-message transform in the `transform-tool-results` phase (applied to every `role: 'tool'` message before compression), not a slot. `JanitorConfig.onBeforeCompress` also still works and now receives the runner's real budget.

Slot errors are **not** isolated — unlike event handlers, a throwing slot handler fails the compile, exactly like the config hooks it generalizes. Wrap your own logic in try/catch when a failure should be survivable.

```typescript
// The 4.1 hooks, written as slots
chef.use("before-overflow", ({ history, budget }) => {
  if (history.length < 4) return false;              // never compress a short conversation
  console.log(`over budget by ${-budget.remaining} tokens`);
});

chef.use("after-overflow", ({ result }) => {
  if (result?.meta.changed) store.recordWindowBoundary(result.meta.windowId);
});
```

#### Dev invariants — `pipelineChecks`

`ChefConfig.pipelineChecks: true` verifies, after every `after-assemble` handler, that pinned messages survived and tool call/result pairs are still paired — and after the tail phase, that nothing ahead of the tail insertion point changed.

```typescript
const chef = new ContextChef({ pipelineChecks: true });
chef.on("pipeline:invariant", ({ phase, message }) => console.warn(`[${phase}] ${message}`));
```

Violations are **reported, never enforced**: each goes to `ChefConfig.logger` (or `console`) and to the `pipeline:invariant` event, and `compile()` never throws because of a check. It costs a snapshot plus a serialization pass per compile, so keep it off in production. Default `false`.

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
| `pipeline:invariant` | `{ phase, message }` | A `pipelineChecks` invariant was violated — a pinned message dropped, a tool pair split, or content rewritten ahead of the tail. Reported only |
| `memory:changed` | `{ type, key, value, oldValue }` | Emitted after any memory mutation (set, delete, expire) |
| `memory:expired` | `MemoryEntry` | Emitted when a memory entry expires during `compile()` |

Events are **observation-only** — they don't affect control flow. Anything that participates in the compile is a [slot](#pipeline-slots-42) (`chef.use(...)`, plus the `onBeforeCompile` / `transformContext` aliases); `onBeforeCompress` and `onMemoryUpdate` remain config callbacks on their modules.

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
  await metrics.report(payload, { signal });
});

try {
  await chef.compile({ target: 'openai', signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    // compile was cancelled mid-flight (overflow / inject / memory / assemble boundary)
  }
  throw err;
}
```

Two effects:

1. **Forwarded to handlers** — `chef.on(event, (payload, signal?) => ...)` receives the signal as the second argument. Handler can pass it to `fetch`, DB clients, or any cooperative API.
2. **Checked at compile() boundaries** — after the `overflow`, `inject`, `memory` and `assemble` phases (the same points as before 4.2: Janitor compression, `before-assemble` / `onBeforeCompile`, memory, `after-assemble` / `transformContext`). Aborts throw via `signal.throwIfAborted()`.

`compile:start` fires before the first abort check, so observers may receive a `compile:start` for a compile that ultimately throws without firing `compile:done`. Memory events fired from external `memory().set()` / `delete()` calls (outside `compile()`) get `signal: undefined`.

#### Concurrency Model

**Canonical pattern: one `ContextChef` instance per concurrent caller.** A chef holds mutable state across `await` points (in-flight signal, memory turn counter, active skill, history reference). Per-request instantiation gives each call its own state — no shared mutable state means no race.

```typescript
// Express / Fastify / Hono — one chef per request
app.post('/agent', async (req, res) => {
  const chef = new ContextChef({ memory: { store: sharedMemoryStore } });
  chef.setHistory(req.body.history);
  const payload = await chef.compile({ target: 'openai' });
  res.json(payload);
});
```

If memory needs to span requests, lift the store out (a shared `FileSystemBackend`, your own Redis-backed `StorageBackend`) and pass it as `store` to per-request chefs — store-level concurrency is the store's responsibility, not the chef's.

**Sharing one chef across concurrent `compile()` calls is single-threaded by design.** Two `compile()` calls on the same instance clobber each other's `_currentSignal`, double-advance the memory turn counter, and interleave skill/history reads. Serialize per instance (`await chef.compile()` chained), or use the per-request pattern above. A snapshot+serialize defensive option is in the roadmap (TODO T2.4.1, low priority) but is not needed for canonical usage.

---

### Input Adapters (Provider → IR)

Convert OpenAI / Anthropic / Gemini native messages to ContextChef IR, automatically separating system and history. Each adapter sanitizes the result via `ensureValidHistory` at the boundary — orphan tool results are dropped, missing tool results get an `[No tool result available]` placeholder, and the first non-system message is forced to be a user message. IR you build manually with `chef.setHistory(...)` is NOT sanitized; trust the IR or call `ensureValidHistory(messages)` yourself.

```typescript
import { fromOpenAI, fromAnthropic, fromGemini } from "@context-chef/core";

// OpenAI
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);

// Anthropic (system is a separate top-level parameter)
const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
chef.setSystemPrompt(system).setHistory(history);

// Gemini (systemInstruction is a separate top-level parameter)
const { system, history } = fromGemini(geminiContents, systemInstruction);
chef.setSystemPrompt(system).setHistory(history);
```

Multimodal content (images, files) is automatically converted to IR `attachments`:

| Provider Format | IR Field |
|---|---|
| OpenAI `image_url` / `file` | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document` | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` converts `attachments` back to the corresponding provider format. During compression, Janitor guides the compression model to describe image content.

---

### Target Adapters

| Feature                      | OpenAI                      | Anthropic                              | Gemini                                     |
| ---------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions            | Messages API                           | generateContent                            |
| Cache breakpoints            | Stripped                    | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support                         | Degraded to `[System Note]`                |
| `thinking` field             | Stripped                    | Mapped to `ThinkingBlockParam`         | Stripped                                   |
| Tool calls                   | `tool_calls` array          | `tool_use` blocks                      | `functionCall` parts                       |
| `attachments`                | `image_url` / `file` content parts | `image` / `document` blocks   | `inlineData` / `fileData` parts            |

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

## Skills

ContextChef provides [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills) that help you integrate the library into your project interactively. Each skill analyzes your existing codebase and generates tailored integration code.

| Skill | Description |
|---|---|
| `context-chef-core` | Integrate `@context-chef/core` — full control over compilation pipeline, multi-provider support |
| `context-chef-middleware` | Integrate `@context-chef/ai-sdk-middleware` — drop-in AI SDK middleware, zero code changes |

### Install

Install only what you need:

```bash
# Core library (OpenAI / Anthropic / Gemini direct SDK usage)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK middleware (Vercel AI SDK v7+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# All
npx skills add MyPrototypeWhat/context-chef
```

### Use

Open [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) in your project and type:

```
/context-chef-core
# or
/context-chef-middleware
```

Claude will:

1. **Detect your setup** — LLM SDK, package manager, TypeScript vs JavaScript
2. **Ask about your needs** — history compression, tool management, truncation, memory, etc.
3. **Generate integration code** — tailored to your project structure and existing agent loop
4. **Explain the architecture** — processing pipeline, cache breakpoints, dynamic state placement
