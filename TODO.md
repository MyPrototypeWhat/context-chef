# Memory Module Optimization Roadmap

## Background

Memory module uses XML tags (`<update_core_memory>` / `<delete_core_memory>`) in LLM responses, with a KV store that injects all entries into the system prompt. Based on industry research (Mem0, Letta/MemGPT, Cursor, Claude Code, Manus, Windsurf, Augment, Cline), the following optimizations are planned.

Design principle: **ContextChef provides mechanisms (hooks + utility functions), not policies.**

---

## Architecture Overview

### Design Decisions

**No tiers.** Originally borrowed `core / archival` from Letta, but analysis showed:
- Tier classification is fundamentally an LLM decision problem — unreliable regardless of how it's framed
- No product has solved this well; most (Cursor, Claude Code, Windsurf) avoid tiers entirely
- Mem0's approach (LLM-powered ADD/UPDATE/DELETE pipeline) belongs in agent framework layer, not context library

**No dual-mode (inline + tool).** Originally proposed to support tiered write paths. With tiers removed:
- Inline XML tags already provide full read/write capability in a single LLM response (zero extra round trips)
- Developers who want tool-based memory can trivially wrap `memory().set()` / `memory().delete()` in custom tool handlers (~15 lines)
- ContextChef provides mechanisms; tool routing is a policy decision

**TTL-based lifecycle control** instead of tier-based separation:
- All entries are equal — no tier semantics
- Growth control via TTL (turn-based or wall-clock) + developer hooks
- Industry patterns: Augment uses TTL for session memory; Manus uses recoverable compression; Cursor/Claude Code rely on manual curation

### Current Config

```typescript
memory: {
  store: myStore,
  defaultTTL?: TTLValue,              // number = turns, { ms } or { turns }
  allowedKeys?: string[],
  selector?: (entries) => entries,     // filter/sort before injection
  onMemoryUpdate?: (key, value, oldValue) => boolean,  // veto hook
  onMemoryChanged?: (event) => void,                    // notification hook
  onMemoryExpired?: (entry) => void,                    // expiry notification
}

// TTL types
type TTLValue = number | { ms: number } | { turns: number };
// number (bare) = turns shorthand
// { ms: 3600_000 } = wall-clock expiry
// { turns: 20 } = turn-based expiry (robust to session gaps)
```

### Memory Lifecycle

```
LLM response → extractAndApply() → set() with defaultTTL → store
                                                              ↓
compile() → sweepExpired() → advanceTurn() → selector → toXml() → inject into system prompt
               ↓                                                        ↓
         onMemoryExpired hook                              meta: { injectedMemoryKeys, memoryExpiredKeys }
```

- **Write**: LLM via XML tags (`extractAndApply()`) or developer via `memory().set()`
- **Read**: Always injected into system prompt during `compile()`
- **Expire**: Lazily during `compile()` — check `expiresAt` (wall-clock) or `expiresAtTurn` (turn-based)
- **Filter**: `selector` hook controls which entries are injected (default: all)
- **Clean response**: `stripMemoryTags()` removes XML tags from assistant content
- **Observe**: `compile()` returns `meta` with `injectedMemoryKeys` and `memoryExpiredKeys`

---

## Completed

### ✅ Entry metadata

`MemoryEntry` with `createdAt`, `updatedAt`, `updateCount`, `importance`.

### ✅ TTL-based expiration

- `defaultTTL` config: applies to all writes
- Per-entry override: `set(key, val, { ttl })`, `ttl: null` = never expire
- Two TTL modes: turn-based (robust to session gaps) and wall-clock (ms)
- `sweepExpired()` called automatically during `compile()`
- `onMemoryExpired` hook for developer to handle expiring entries (offload, extend, log)
- Turn counter (`advanceTurn()`) incremented per `compile()` call, included in snapshot/restore

### ✅ `stripMemoryTags(content: string): string`

- Strips `<update_core_memory>` and `<delete_core_memory>` tags from LLM response
- Pure utility function, no side effects

### ✅ `selector` hook

- `selector?: (entries: MemoryEntry[]) => MemoryEntry[]` in config
- Called during `compile()` before memory injection
- Developer controls filtering, sorting, truncation
- `getSelectedEntries()` public method for external access

### ✅ `onMemoryChanged` event hook

- `onMemoryChanged?: (event: MemoryChangeEvent) => void` in config
- Fires on `set()`, `delete()`, and TTL expiry (`type: 'set' | 'delete' | 'expire'`)
- Pure notification, does not affect write flow (unlike `onMemoryUpdate` which is a veto)

### ✅ `compile()` metadata return

- `compile()` returns `meta: { injectedMemoryKeys, memoryExpiredKeys }` on every call
- `injectedMemoryKeys`: keys that were injected into system prompt (after selector)
- `memoryExpiredKeys`: keys that expired and were removed this turn
- No token estimation — unreliable without a real tokenizer; developers can use their own

---

### ✅ Snapshot Deep-Clone Fix

Replaced shallow copies (`{ ...m }`) with `structuredClone` in `snapshot()` / `restore()` across three locations:

- `ContextChef.snapshot()` / `restore()` — nested `Message` fields (`tool_calls`, `thinking`, etc.) fully isolated
- `InMemoryStore.snapshot()` / `restore()` — `MemoryStoreEntry` references isolated
- `Pruner.snapshotState()` / `restoreState()` — tool `parameters` and `tags` isolated

Also added `snapshot()` / `restore()` to `VFSMemoryStore`, which previously returned `null` for memory state during snapshots.

### ✅ `compact()` — Extensible History Compaction API

Instance method on `Janitor` that mechanically strips content from a `Message[]` based on developer-specified clear targets. Pure function — no LLM call, no side effects, no state mutation.

```typescript
const compacted = janitor.compact(history, {
  clear: ['tool-result', 'thinking'],
});
```

- `ClearTarget` union type: `'tool-result'` | `'thinking'`
- `'tool-result'`: replace `role: "tool"` content with `"[Tool result cleared]"` (preserves `tool_call_id`)
- `'thinking'`: strip `thinking` and `redacted_thinking` blocks from assistant messages
- Extensible via `ClearTarget` union — new clearing types added without breaking changes
- Composable with `onBudgetExceeded` hook as first-pass compaction before LLM-based compression

### ✅ Tool Pair Protection in Janitor

`adjustSplitIndex()` ensures `compress()` never splits a `tool_calls` assistant message from its corresponding `tool` result. Two invariants:
1. Every `role: 'tool'` in the kept range has its matching assistant in the kept range
2. The kept range starts with an assistant message for valid alternation after the user-role summary

**Known limitation**: `adjustSplitIndex` makes the final split point unpredictable when combined with `compact(keepRecent)`. See "Turn-Based Grouping" in Planned section.

### ✅ Enhanced `compact()` — `keepRecent` Support

`ClearTarget` supports object form for selective tool-result clearing:

```typescript
type ClearTarget = 'thinking' | 'tool-result' | ToolResultClearTarget;
interface ToolResultClearTarget { target: 'tool-result'; keepRecent?: number; }
```

`keepRecent` preserves the last N tool results (floored to 1), clearing the rest.

### ✅ Turn-Based Grouping for Janitor

Replaced `adjustSplitIndex` with structurally correct turn-based splitting. Released in 3.0.1.

- `groupIntoTurns(history)` utility exported from public API, returns `Turn[]` with atomic boundaries (user/system/plain-assistant = single-message turn; assistant+tool_calls + all subsequent tool results = one atomic turn)
- `evaluateBudget()` iterates turns (not messages) from the tail on both tokenizer and feedTokenUsage paths — splits always land on turn boundaries, tool pair integrity guaranteed by design
- `adjustSplitIndex()` fully removed
- `preserveRecentMessages` now counts turns (behavioral change documented in 3.0.1)

### ✅ Remove System Message Protection in `executeCompression`

`executeCompression()` no longer contains defensive system-message filtering (removed in 3.0.1). The middleware path (`ai-sdk-middleware/src/middleware.ts`) splits system messages out before `compress()` is called, and core-path callers don't put system messages in `setHistory()`. Janitor is no longer responsible for this.

### ✅ Built-in Compression Prompt Utilities + Prompt Scaffolding Upgrade

Upgraded `CONTEXT_COMPACTION_INSTRUCTION` to use Claude Code's two-phase `<analysis>` + `<summary>` pattern with an `<example>` block, while keeping the domain-agnostic section headings (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve) so the prompt works for any use case, not just coding agents.

- New `Prompts.formatCompactSummary(raw)` — strips `<analysis>` scratchpad blocks (any case, multiple occurrences) and extracts `<summary>` content. Falls back to cleaned raw text when tags are absent. Collapses 3+ consecutive blank lines and trims.
- `executeCompression()` now pipes `compressionModel` output through `formatCompactSummary` before wrapping with `getCompactSummaryWrapper`, so `<analysis>` scratchpads and XML scaffolding never leak into the next context window.
- Deleted `DEEP_CONVERSATION_SUMMARIZATION` — it was dead code (defined but never referenced internally) and its `<history_summary>` vs `<summary>` divergence from `CONTEXT_COMPACTION_INSTRUCTION` created an inconsistent parsing contract.
- New `JanitorConfig.customCompressionInstructions?: string` — additive (not replacement), appended as an "Additional Instructions:" section after the default prompt. Claude Code-style: users can focus the summary on their domain concerns without being able to break the `<analysis>`/`<summary>` contract.

Design decision: **no preset-swapping mechanism** (considered `compressionPrompt: string` full-swap; rejected). Claude Code doesn't let users swap the wholesale prompt for the same reason — it would break the parser contract. Users who need radically different compression behavior can still provide their own `compressionModel` entirely.

### ✅ Compression Circuit Breaker

Prevents infinite retry loops when `compressionModel` consistently fails. Inspired by Claude Code's `autoCompact.ts` (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`).

- New private `_consecutiveFailures` counter in `Janitor`, constant `MAX_CONSECUTIVE_COMPRESSION_FAILURES = 3`
- `compress()` short-circuits (returns history unchanged) when `_consecutiveFailures` reaches the limit — no wasted API calls
- `executeCompression()` try/catch: resets counter to 0 on success, increments on failure
- `JanitorSnapshot` gains `consecutiveFailures: number`; `snapshotState()` / `restoreState()` / `reset()` updated accordingly
- `restoreState()` uses `?? 0` for defensive backward compatibility with serialized snapshots from older versions
- No `onCompressError` hook added — YAGNI; the breaker trip is observable via subsequent `compress()` becoming a no-op, and developers who want failure notifications can already wrap their own `compressionModel`

### ✅ Multimodal Attachment IR + Media-Aware Compression Prompt

Added `Attachment` interface (`mediaType`, `data`, `filename`) and `Message.attachments` field to core IR as a provider-neutral representation of media content. Provider adapters convert to/from this field (OpenAI `image_url`/`file`, Anthropic `image`/`document`, Gemini `inline_data`/`file_data`).

- `executeCompression()` strips binary attachments from `toCompress` messages before the compression call, replacing each with an inline `[image]` / `[document: filename]` text placeholder. Avoids shipping base64 through the compression payload (which the user-supplied `compressionModel` function couldn't actually forward to the LLM anyway, since it has no adapter pipeline). Mirrors Claude Code's `stripImagesFromMessages` strategy. `toKeep` retains its attachments, which still reach the main model via the target adapter.
- Replaces the original "Strip Media Before Compression" plan (which assumed base64 in `content: string` — incorrect; multimodal data lives in structured content parts, not in the IR string)

### ✅ Input Adapters (Provider → IR)

Added `fromOpenAI()`, `fromAnthropic()`, `fromGemini()` input adapter functions — the reverse direction of the existing output adapters. Users no longer need to manually construct IR `Message` objects.

- `fromOpenAI(messages)` → `ParsedMessages { system, history }` — maps `image_url`/`file` content parts → `attachments`, tool_calls, tool messages
- `fromAnthropic(messages, system?)` → `ParsedMessages` — maps `image`/`document` blocks → `attachments`, `tool_use` → `tool_calls`, `tool_result` → IR tool messages, `thinking`/`redacted_thinking` → IR fields. Handles all 4 document source types (base64, url, text, content)
- `fromGemini(contents, systemInstruction?)` → `ParsedMessages` — maps `inlineData`/`fileData` → `attachments`, `functionCall`/`functionResponse` → IR tool messages with correlated synthetic `tool_call_id`
- New types: `HistoryMessage` (Message with role excluding 'system'), `ParsedMessages` ({ system, history })
- All functions exported from `@context-chef/core`

Usage:
```typescript
import { fromOpenAI } from '@context-chef/core';
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);
```

### ✅ Output Adapters: `attachments` → Provider Format

All three output adapters now convert IR `attachments` to provider-specific multimodal content parts during `compile()`.

- `openAIAdapter`: converts to `image_url` (images) and `file` (documents) content parts
- `anthropicAdapter`: `attachmentsToBlocks()` converts to Anthropic SDK image/document content blocks
- `geminiAdapter`: converts to `fileData` (HTTP/GCS URLs) or `inlineData` (base64)
- Full round-trip support with input adapters (`fromOpenAI`, `fromAnthropic`, `fromGemini`)
- Complete test coverage across all three adapters

### ✅ VFS Lifecycle Management

`Offloader` gains `cleanup()` / `cleanupAsync()` (sweeps expired and over-cap entries) and `reconcile()` / `reconcileAsync()` (adopts orphan files into the in-memory index after process restart, modeled on `npm`'s `cacache verify`). New `VFSConfig` fields: `maxAge` (ms since `createdAt`), `maxFiles`, `maxBytes` (true UTF-8 byte length via `Buffer.byteLength`), and `onVFSEvicted(entry, reason)` per-entry hook (errors logged via `console.warn` and swallowed). `VFSStorageAdapter` gains optional `list()` / `delete()` methods — capability-checked at runtime via `VFSCleanupNotSupportedError`, so existing custom adapters keep working unchanged; built-in `FileSystemAdapter` implements both. New types: `VFSEntryMeta`, `VFSCleanupResult`, `VFSEvictionReason`, `CleanupOptions`. `chef.getOffloader()` exposes the underlying instance for `cleanupAsync()` / `reconcileAsync()`.

Eviction algorithm mirrors `lru-cache`'s `dispose` + `maxSize` + `sizeCalculation` model: Phase A — `maxAge` sweep (reason `'maxAge'`); Phase B — single-pass LRU by `accessedAt` ascending until both count and byte caps are satisfied (reason `'maxFiles'` if count cap is binding, else `'maxBytes'`). The in-memory index keeps eviction adapter-agnostic: any backend (filesystem, S3, KV) gets LRU semantics for free without `stat()` round-trips. `cleanup()` overrides accept `Infinity` to disable a single cap for one call.

Cleanup is **manual only** — never auto-triggered by `compile()` (mechanism, not policy). Wire to `compile:done` event hook for per-turn enforcement, or call from your agent loop / on session end. **Out of scope (deferred)**: snapshot/restore for the VFS index (the index points at moving external state — restoring stale entries is unsound), sliding TTL (renew on access), and an `autoCleanup` config flag.

---

### ✅ Middleware: `fromAISDK()` Attachment Mapping

`fromAISDK()` now maps AI SDK `FilePart` (type `'file'`) to IR `attachments` on both user and assistant messages. This feeds `executeCompression()`'s placeholder-injection logic in the middleware path, so multimodal turns get `[image]` / `[document]` markers in the compression payload instead of raw binary. Actual file data round-trips through `_userContent`/`_assistantContent` — `attachments` serves as the metadata signal for the Janitor.

---

## Planned

### `compact()` — `toolFilter` Support

**Priority: Low** — Selective clearing by tool name.

**Reference**: Claude Code's `microCompact.ts` uses a `COMPACTABLE_TOOLS` whitelist.

**Design**: Extend `ToolResultClearTarget`:

```typescript
interface ToolResultClearTarget {
  target: 'tool-result';
  keepRecent?: number;
  toolFilter?: string[];  // only clear results from these tool names
}
```

Resolving the tool name requires scanning the preceding assistant message for the matching `tool_calls[].id` → `function.name`.

---

### Memory Injection Position Configurable

**Priority: Medium** — When using Anthropic prompt caching, memory changes (new/updated/expired keys) invalidate the cache for all content after the injection point.

Current hardcoded order in `compile()`:
```
[...systemPrompt, ...memoryMessages, ...compressedHistory, ...dynamicState]
```

If memory changes every turn, everything after `memoryMessages` loses cache.

**Design**: Add `memoryPlacement` to `MemoryConfig`:
```typescript
memoryPlacement?: 'after_system' | 'before_history_tail';
// 'after_system' (default): current behavior, memory between system prompt and history
// 'before_history_tail': memory after history, before dynamic state — system prompt cache preserved
```

---

---

---

### Strip Reasoning Model `<think>` Tags in `compact()`

**Priority: Low** — Defensive cleanup for reasoning models (DeepSeek-R1, QwQ, gpt-oss, locally hosted reasoning models).

**Context**: When an assistant message's `content` string contains `<think>...</think>` blocks (common in non-official APIs or local inference of reasoning models), these reasoning traces leak into the final context and waste tokens. The current `compact()` only strips the Anthropic-native `thinking` / `redacted_thinking` message fields, not XML-tagged reasoning in the content string.

**Reference**: Mem0's `remove_code_blocks` in `mem0/memory/utils.py` uses `re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)` for this exact purpose.

**Design**: Extend `ClearTarget` to support a new target that strips XML-tagged reasoning from content strings:

```typescript
type ClearTarget = 'thinking' | 'tool-result' | 'reasoning-tags' | ToolResultClearTarget;
```

- `'thinking'` (existing): strips Anthropic native `thinking` / `redacted_thinking` fields
- `'reasoning-tags'` (new): strips `<think>...</think>` XML blocks from the content string

Only applies when `compact()` is called; does not auto-trigger. Out of scope for `formatCompactSummary` — that handles compression model output, this handles history messages.

---

### Pruner — State-Scoped Tool Whitelists

**Status: Replaced** — see [`SKILL_SPEC.md`](./SKILL_SPEC.md).

The original "Pruner state machine + tool whitelist" design was redesigned and split into two fully independent modules:

- **Module A — Pruner Blocklist** (`Pruner.setBlockedTools` + `ContextChef.checkToolCall`): runtime tool gate for permission, environment, sandbox, rate-limiting, etc.
- **Module B — Skill Primitive** (`Skill` type + `loadSkill` / `loadSkillsDir` + `ContextChef.activateSkill`): named behavior bundle (instructions + metadata). `Skill.allowedTools` is annotation only; chef does NOT enforce it.

The original "registerStates / transitionTo / pruneByState" state-machine design and the `onToolCallReceived` config hook are explicitly dropped (see `SKILL_SPEC.md` §11). Mode-based agents wire Skill annotation to Pruner blocklist in user code; the wiring recipe is `SKILL_SPEC.md` §7.3.

---

## Not Planned

The following patterns from the industry are intentionally out of scope for ContextChef:

- **Memory tiers (core/archival)**: tier classification is an LLM decision problem; TTL + selector provides equivalent growth control without the classification burden
- **Dual-mode write protocol (inline + tool)**: inline XML tags already work; developers can wrap public API in custom tools if needed
- **`createTokenBudgetSelector` utility**: token estimation is unreliable without a real tokenizer; developers can trivially implement sorting + slicing via the `selector` hook directly
- **Token counting in compile metadata**: same reason — no reliable estimation without model-specific tokenizer dependency
- **Graph memory** (Mem0g, Zep/Graphiti, MAGMA): requires external graph DB, too heavy
- **Reflection / self-assessment**: requires extra LLM calls, belongs in agent framework layer
- **Vector retrieval / embeddings**: requires embedding model dependency, but can be plugged in via `selector` or `onBeforeCompile`
- **LLM-based importance scoring**: unreliable, adds cost
- **LLM-based memory consolidation**: same as above

These should be implemented at the agent framework layer, using ContextChef's hooks (`selector`, `onMemoryChanged`, `onMemoryUpdate`, `onMemoryExpired`) as integration points.

---

---

# Pi-Mono Comparison Roadmap

Source-verified review of [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) (`packages/ai`, `packages/agent`, `packages/coding-agent`). Items below are concrete improvements ContextChef can adopt; pi-mono is a runtime agent framework, ContextChef is a compile-time context engine — borrow patterns, not the runtime.

## Tier 1 — Quick Wins (do first)

Total ETA: < 1 day. Each item benefits every user.

### T1.1 — Boundary sanitization in `from*` input adapters

**Status**: ✅ Done (2026-05-08)
**Files**: `packages/core/src/adapters/{openAIAdapter,anthropicAdapter,geminiAdapter}.ts`, `packages/ai-sdk-middleware/src/adapter.ts`, `packages/tanstack-ai/src/adapter.ts`, `packages/core/src/utils/ensureValidHistory.ts` (placeholder text), README + README.zh-CN, plus all corresponding test files

Original plan was "call `ensureValidHistory` inside `compile()` by default" (defensive). Redesigned to **"validate at system boundary, trust internal IR"** — `from*()` is the boundary between external SDK formats and ContextChef IR; sanitize there. `chef.setHistory(IR)` and `compile()` are not boundaries (IR is the internal protocol; trust it).

**What changed:**
- All five `from*` adapters (`fromOpenAI`, `fromAnthropic`, `fromGemini`, `fromAISDK`, `fromTanStackAI`) now run their output through `ensureValidHistory` at the boundary
- Placeholder text changed from `[Tool result missing]` to neutral `[No tool result available]` (avoids implying execution failure when the real cause is incomplete loaded state — feedback from the design discussion)
- README + zh-CN README document the new boundary contract explicitly
- Existing fromX unit-test fixtures updated to satisfy invariants (added user-prefix or matching tool pairs); 5 new "boundary smoke" tests added — one per adapter — proving sanitization triggers on dirty input

**Verification**: `pnpm -r run typecheck` ✅ · `pnpm lint` ✅ · `pnpm -r run test` ✅ (688 tests across 32 files; +5 new boundary tests)

**Why design changed mid-implementation:** initial "compile() step 0.5" plan covered all paths but added per-call cost and violated "trust internal code, validate at boundary" principle (system prompt's own words). Boundary placement gives same coverage for users who use the adapters (the common path), zero cost for users who construct IR directly (they own correctness), and clean separation between translator and sanitizer responsibilities.

**Reference**: pi `providers/transform-messages.ts:155-217` runs sanitize on every request — we placed it at boundary instead, mirroring pi's intent (catch malformed history before it leaves trusted code) without paying the per-call cost.

---

### T1.2 — Defensive `slice()` in setters

**Status**: ✅ Done (already implemented prior to this review)
**Files**: `packages/core/src/index.ts`, `packages/core/src/modules/pruner/index.ts`

Audit on 2026-05-07 confirmed all stateful setters already copy on assignment:
- `setSystemPrompt` / `setHistory` use `[...messages]`
- `Pruner.registerTools` uses `[...tools]`
- `Pruner.registerNamespaces` / `registerToolkits` use `groups.map(g => ({ ...g, tools: [...g.tools] }))`
- `Pruner.setBlockedTools` uses `[...names]`
- `registerSkills` uses `structuredClone` (deeper than required)

No code change needed. Item kept here for traceability.

**Reference**: pi `agent.ts:74-85` wraps `tools` and `messages` with getter/setter pairs that always copy on assignment.

---

### T1.3 — `as Type` → `satisfies Type` for defaults/constants

**Status**: ❌ Not Applicable (no candidates exist)
**Files**: grep `as ` across all packages

Audit on 2026-05-07 found no `} as XxxType` pattern used as a default value or named constant. The two existing `as` usages are legitimate:
- `packages/core/src/adapters/anthropicAdapter.ts:226` — `msg.role as 'user' | 'assistant'` is a narrow cast in a flow-control branch
- `packages/core/src/modules/assembler/index.ts:30` — `as T` is a generic-passthrough cast required by the recursive helper signature
- `packages/core/src/adapters/openAIAdapter.ts:74` — `'function' as const` is a const assertion (different semantic from `satisfies`; do not change)

`satisfies` would not improve any of these. Item closed.

**Reference (still informative)**: pi `agent.ts:42` `const DEFAULT_MODEL = { ... } satisfies Model<any>;` — the pattern itself is good practice, just not currently triggered in our codebase.

---

### T1.4 — `Contract:` JSDoc segments on all hooks

**Status**: ✅ Done (2026-05-07)
**Files**: `packages/core/src/index.ts`, `packages/core/src/modules/janitor/index.ts`, `packages/core/src/modules/memory/index.ts`, `packages/core/src/modules/offloader/index.ts`

Added `Contract:` JSDoc segment to every hook field in core config types. Each segment specifies whether the hook may throw/reject and what happens to the calling path on failure. Three contract categories:

1. **Must not throw — error propagates out of `compile()`** (no fallback path):
   `ChefConfig.transformContext`, `ChefConfig.onBeforeCompile`, `JanitorConfig.tokenizer`, `JanitorConfig.onCompress`, `JanitorConfig.onBeforeCompress`, `MemoryConfig.selector`, `MemoryConfig.onMemoryUpdate`, `MemoryConfig.onMemoryChanged`, `MemoryConfig.onMemoryExpired`
2. **May reject — circuit breaker absorbs failures**:
   `JanitorConfig.compressionModel` (3 consecutive failures → no-op until reset)
3. **May throw — caught and swallowed by callsite**:
   `VFSConfig.onVFSEvicted` (errors logged via `console.warn`)

**Verification**: `pnpm -r run typecheck` ✅ · `pnpm lint` ✅ · `pnpm -r run test` ✅ (682 tests across 31 files)

Middleware option types deferred — middleware does not currently expose user-facing hooks beyond what flows through `ChefConfig`.

**Reference**: pi consistently writes `Contract: must not throw or reject. Return [] when no follow-up messages are available.` on every hook.

---

## Tier 2 — Near-Term (high value, moderate effort)

### T2.1 — `AdapterRegistry`

**Status**: Planned
**ETA**: half-day
**Files**: `packages/core/src/adapters/adapterFactory.ts`

Replace switch-case `getAdapter('openai' | 'anthropic' | 'gemini')` with `AdapterRegistry.register(name, adapter)` / `unregister(name)`. Ship three internal `register()` calls in a `register-builtins` module. Existing public API (`getAdapter`) keeps working.

**Why**: third parties adding Cohere / Mistral / proprietary protocols today must fork the library. Tests cannot install fake adapters cleanly.

**Reference**: pi `api-registry.ts` — registry takes optional `sourceId` so an entire source's providers can be unregistered as a group (perfect for plugins / test isolation).

---

### T2.2 — `onPayload` / `onResponse` middleware hooks

**Status**: Planned
**ETA**: half-day
**Files**: `packages/ai-sdk-middleware/src/middleware.ts`, `packages/tanstack-ai/src/middleware.ts`

```typescript
withContextChef(model, {
  onPayload: (payload, model) => modified | void,
  onResponse: (response, model) => void,
});
```

**Why**: today users add their own logger to inspect what gets sent. With these hooks, debugging cache hit rate / final payload becomes one-liner.

**Reference**: pi `StreamOptions.onPayload` / `onResponse` in `ai/types.ts:99-105`.

---

### T2.3 — `preserveThinkingAsText` opt-in for cross-provider replay

**Status**: Planned
**ETA**: half-day
**Files**: `packages/core/src/adapters/openAIAdapter.ts`, `geminiAdapter.ts`

Currently `openAIAdapter` and `geminiAdapter` strip Anthropic `thinking` blocks. Add option to convert them to `<thinking>...</thinking>` text blocks instead.

Edge case to handle correctly: **redacted thinking is opaque encrypted content**. For same-model replay it must be preserved with signature; cross-model it must be dropped (cannot be transformed).

**Reference**: pi `providers/transform-messages.ts:97-114`. Same-model match key is the triple `(provider, api, model.id)`.

---

### T2.4 — `ChefEvents` handler signature with `AbortSignal`

**Status**: Planned
**ETA**: 1h
**Files**: `packages/core/src/utils/eventEmitter.ts`, `index.ts`

Change `(event) => void | Promise<void>` to `(event, signal?: AbortSignal) => void | Promise<void>`. Handlers awaiting long operations (DB write in `compile:done`) can cooperatively cancel.

**Reference**: pi `agent.ts:540` `for (const listener of this.listeners) await listener(event, signal);`

---

### T2.5 — Granular event expansion

**Status**: Planned
**ETA**: half-day
**Files**: `packages/core/src/index.ts`

Add: `compress:start` / `compress:end` (with `tokenInfo` so handler can decide to skip), `offload:created` / `offload:resolved`, `pruner:tool-blocked`, split `memory:changed` into `memory:set` / `memory:delete`.

**Reference**: pi `AssistantMessageEvent` has 11 events (text/thinking/toolcall × {start, delta, end} + start/done/error); pi `AgentEvent` has 9.

---

### T2.6 — `transformToolResult` unified hook

**Status**: Planned
**ETA**: half-day
**Files**: `packages/core/src/index.ts`

```typescript
new ContextChef({
  transformToolResult: (call, result) => result | Promise<result>,
});
```

Common use: auto-offload large outputs, PII redaction, error format normalization. Today users do these in their agent loop with if/else chains.

**Reference**: pi `afterToolCall` field-level merge pattern in `agent-loop.ts:642-649` — `??` per field, no deep merge, omitted fields keep original values. Strict and predictable.

---

## Tier 3 — Medium-Term (larger scope, needs design doc)

### T3.1 — Snapshot DAG

**Status**: Design needed

`snapshot()` accepts `{ parentId?: string }`; new `chef.diff(snapA, snapB)` and `chef.fork(snapId)`; optional `SnapshotStore` manages the graph.

Unlocks explorative agents and branching session UX.

**Reference**: pi-coding-agent's `/tree` and `/fork` commands validate the value (in-place branching, no file duplication).

---

### T3.2 — `loadSystemPrompt({ baseDir, mode, cascade })` utility

**Status**: Design needed

Walk up the directory tree gathering `AGENTS.md` / `CLAUDE.md` / `.context-chef/SYSTEM.md`, concatenate per `mode: 'replace' | 'append'`. Mirrors `loadSkill` / `loadSkillsDir` style.

**Reference**: pi-coding-agent's `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md` / `APPEND_SYSTEM.md` cascading load.

---

### T3.3 — Compile pipeline diagram in README

**Status**: Doc-only

Visualize the fixed execution order of `transformContext` → `onBeforeCompile` → `onBeforeCompress` → `selector` → `transformToolResult` (and any additions). Today our hooks are distributed across modules; global ordering is implicit.

**Reference**: pi's three-layer separation `transformContext → convertToLlm → streamFn` is rigid and orthogonal — we should document ours with the same clarity.

---

### T3.4 — `Message._meta?: Record<string, unknown>` reservation

**Status**: Planned
**ETA**: 30min (zero-cost future-proof)

Add an optional `_meta` field to `Message`. No semantic change today; preserves headroom for future `notification` / `progress` / UI-only message kinds without a breaking change.

**Reference**: pi `CustomAgentMessages` declaration-merging pattern (`agent/types.ts:271-280`) — we shouldn't ship the full union split, but `_meta` is the cheapest insurance.

---

## Internal Code Patterns (apply in future refactors)

These are pi-mono patterns to internalize, not items to ship:

1. **Discriminated union over `throw + null`**: model two-way outcomes as `{ kind: 'a', ... } | { kind: 'b', ... }`. Failure and success share one data shape. (pi `agent-loop.ts:485-509`)
2. **Three-stage split: `prepare → execute → finalize`**: sequential and parallel paths share the prepare and finalize stages. **Apply to `Janitor.compress`**: split `prepareCompress` (prompt assembly + circuit breaker check) → `executeCompress` (LLM call) → `finalizeCompress` (`formatCompactSummary` post-process). (pi `agent-loop.ts:529-660`)
3. **`EventStream<T, R>` dual API**: implement `AsyncIterable<T>` *and* `result(): Promise<R>` from one event source via two callbacks `isComplete` + `extractResult`. Template for any future streaming compress / streaming compile work. (pi `event-stream.ts`, 67 LOC)
4. **Errors encoded into data, streams never throw**: `StopReason` field + `errorMessage` field; `done` and `error` are normal stream events. Eliminates scattered try/catch on streaming paths. (pi `ai/types.ts:212`)
5. **Saturating config rule**: `config.X || items.some(i => i.X)` — "any one on, all on." Semantically clearer than priority tables. (pi `agent-loop.ts:358`)
6. **Provider registry with `sourceId`**: batch unregister by source for plugin systems / test isolation. (pi `api-registry.ts:38`)

---

## Pi-Mono Patterns Explicitly NOT Adopted

| Pattern | Reason |
|---|---|
| TypeBox to replace Zod | Vercel AI SDK / Zod ecosystem lock-in; switching would break users |
| Built-in OAuth (`loginAnthropic` / `loginOpenAICodex` / `loginGitHubCopilot`) | Heavy dep; recommend listing `@mariozechner/pi-ai` as `peerDep` in examples instead of reimplementing |
| TUI / Web-UI packages | Out of scope for a context engine |
| Pi packages / `pi install` protocol | We're a library, not a CLI; `npx skills add` covers the core need |
| JSON mode / RPC mode | CLI-only concerns |
| MCP / sub-agent / plan mode rejection stance | pi's "minimalism" is a CLI product decision, not ours |
| **Cost tracking in `compile:done` payload** | Same reason as "token counting in compile metadata" (already in Memory Roadmap → Not Planned). Cost = token × price; we're a pre-call context engine, post-call statistics belong to the caller. Maintaining a price map = price-drift bugs. Users can compute `usage × price` from their SDK response in one line. pi does this only because it ships a CLI footer. |

---

## Strengths to Highlight (reverse-pitch material)

For a future blog post or comparison doc:

1. **IR + bidirectional `from*` / `to*` adapters** — more thorough than pi's per-provider stream functions
2. **Janitor's turn-based grouping + circuit breaker** — more robust than pi's "let the LLM manage compaction" approach; structural correctness guarantees
3. **VFS + `context://` URI scheme** — capability pi has nothing equivalent to
4. **Skill SKILL.md frontmatter + Pruner ⊥ Skill decoupling** (annotation vs enforcement separated) — more structured than pi's skill design

---

## References

- [Mem0 (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [MemGPT/Letta (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Zep/Graphiti (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [MAGMA (arXiv 2601.03236)](https://arxiv.org/abs/2601.03236)
- [Memory in the Age of AI Agents Survey (arXiv 2512.13564)](https://arxiv.org/abs/2512.13564)
- [Generative Agents (ar5iv 2304.03442)](https://ar5iv.labs.arxiv.org/html/2304.03442)
