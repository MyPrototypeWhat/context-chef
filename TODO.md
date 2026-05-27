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

### ✅ Memory Injection Position Configurable

`MemoryConfig.memoryPlacement?: 'after_system' | 'before_history_tail'`. Default `'after_system'` is bit-for-bit compatible with pre-3.5 behavior (single combined system message). `'before_history_tail'` splits the memory message into two parts:

- **Stable usage instruction** stays as a `role: 'system'` message at the top of the sandwich (cacheable).
- **Volatile `<memory>` data block** is appended to the last user message via the existing assembler tail-injection path (alongside `<dynamic_state>` / `<implicit_context>` when those are also tail-placed).

**Why the split matters (the real cross-provider win):** the Anthropic and Gemini adapters extract every `role: 'system'` message into the top-level `system` / `systemInstruction` parameter. Under `'after_system'`, the volatile memory text rides into that block; every cache breakpoint positioned further down the message stream hashes it, so any memory mutation invalidates the cache. Under `'before_history_tail'`, the data stays in `messages` instead — cache breakpoints on earlier history blocks (or on stable system prefix) no longer see the changing text. OpenAI (inline system messages) benefits the same way because the auto-prefix cache window now extends past the memory section.

Implementation notes:
- Assembler API: renamed `AssembleOptions.dynamicStateXml` → `tailXml` and dropped the `placement` field. The Assembler is now a pure tail-injection primitive; `compile()` composes the stitch (memory data → dynamic state → implicit context → anchor) based on each module's placement config.
- The "Above is the current system state..." anchor only fires when dynamic state or implicit context is in the tail; memory-only tail injections rely on the data block's own `"You recall the following..."` self-anchor (no double anchor).
- `_getMemoryMessages` → `_buildMemorySandwichParts` consolidates the previously-duplicated `getSelectedEntries()` round-trips into a single read.
- `Memory.placement` getter is public for observability.

**Verification**: `pnpm -r run typecheck` ✅ · `pnpm lint` ✅ · `pnpm -r run test` ✅ (757 tests across 35 files; +20 new — full coexistence matrix with `dynamicStatePlacement`, Anthropic adapter behavior, KV-cache stability assertions, selector interaction, transformContext observation order).

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

**Status**: ✅ Done (2026-05-10)
**Files**: `packages/core/src/adapters/{adapterRegistry,registerBuiltins,adapterFactory,targetAdapter}.ts`, `packages/core/src/types/index.ts`, `packages/core/src/index.ts`, plus tests (`adapterRegistry.test.ts`, `compileTarget.test.ts`), README + zh-CN README, core README

Replaced the closed switch-case in `getAdapter()` with an open `AdapterRegistry` so users can plug in custom `ITargetAdapter` implementations without forking. The `ITargetAdapter` interface was already exported, but the dispatch was hard-coded — this PR opens the last gate.

**What changed:**
- New `adapterRegistry` singleton + `AdapterRegistry` class with `register` / `unregister` / `unregisterBySource` / `get` / `has` / `list`
- Built-ins (`openai`, `anthropic`, `gemini`) auto-registered under `sourceId: 'builtin'` via side-effect import in `registerBuiltins.ts`
- `ChefConfig.defaultTarget?: TargetProvider | ITargetAdapter` — instance-wide default
- `compile({ target })` now accepts three forms: built-in literal (strict payload type), registered name, or `ITargetAdapter` instance (bypasses registry)
- Resolution order: `options.target → defaultTarget → 'openai'` (final fallback kept for backward compat → `patch` bump, not `major`)
- `TargetProvider` widened to `BuiltinTargetProvider | (string & {})` — keeps IDE auto-complete on the three literals
- `ITargetAdapter` definition moved into `types/index.ts` to remove a circular-dep hazard; `targetAdapter.ts` becomes a re-export shim

**Verification**: `pnpm -r run typecheck` ✅ · `pnpm lint` ✅ · `pnpm -r run test` ✅ (707 tests across 33 files; +17 new — 10 registry CRUD + 7 compile() target resolution)

**Reference**: pi `api-registry.ts` — `sourceId` enables batch unregister for plugins / test isolation.

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

**Status**: ✅ Done (2026-05-14)
**Files**: `packages/core/src/utils/eventEmitter.ts`, `packages/core/src/types/index.ts`, `packages/core/src/index.ts`, plus tests (`eventEmitter.test.ts` +3, `events.test.ts` +9), README + zh-CN README, core README

`EventHandler<T>` now accepts `(payload: T, signal?: AbortSignal) => void | Promise<void>`. `TypedEventEmitter.emit()` takes an optional third `signal` argument and pass-through-forwards it to every handler — no short-circuit on `signal.aborted`, observability is preserved on cancel paths.

`CompileOptions.signal?: AbortSignal` propagates the signal in two ways:

1. **Stash + bridge**: `ContextChef._currentSignal` holds the in-flight signal so the Janitor `onCompress` / Memory `onMemoryChanged` / Memory `onMemoryExpired` event-bridge closures (constructed once at chef creation) can forward it on every `emit()` during the current compile. Cleared in a `finally` block. Memory events from external `memory().set()` / `delete()` (outside compile) receive `signal: undefined`.
2. **Phase-boundary checks**: `signal?.throwIfAborted()` runs after `compile:start`, after Janitor compress, after `onBeforeCompile`, and after `transformContext`. `compile:start` fires before the first abort check by design — observers may see a `compile:start` for a compile that throws without firing `compile:done`.

All 6 typed `compile()` overloads now accept `signal?: AbortSignal` alongside `target`. Existing handler signatures keep working — the second argument is optional and ignored by handlers that don't declare it.

**Verification**: `pnpm lint` ✅ · `pnpm -r run typecheck` ✅ · `pnpm -r run test` ✅ (737 tests; +12 new — 3 eventEmitter signal pass-through, 9 compile cancellation)

**Reference**: pi `agent.ts:540` `for (const listener of this.listeners) await listener(event, signal);` — same pass-through semantics; we additionally honor `throwIfAborted()` at compile() phase boundaries based on user choice.

---

### T2.4.1 — `compile()` Concurrency Safety (Snapshot + Serialize)

**Status**: Planned (queued from T2.4 self-review on 2026-05-14, demoted on 2026-05-15)
**Priority**: **Low** — defensive hardening, not a critical fix. The canonical "one chef per concurrent caller" pattern (documented in README → "Concurrency Model") sidesteps the hazard entirely. T2.4.1's value is only catching user bugs where someone accidentally shares a chef across concurrent `compile()` calls.
**Estimated scope**: ~80 LOC implementation + ~120 LOC tests + ~30 LOC docs ≈ 230-line diff
**Files**: `packages/core/src/index.ts`, `packages/core/tests/concurrency.test.ts` (new), README + zh-CN + core README

**Why demoted (2026-05-15):** User question — "if every concurrent request is its own chef instance, does the problem go away?" — surfaced that per-instance is the canonical pattern (matches Express/Fastify/Hono server style, also what pi-mono / Letta / LangGraph use). Cross-request memory sharing is solved by lifting the Memory store out (e.g. `VFSMemoryStore` or external Redis-backed) and passing it to per-request chefs; store-level concurrency is the store's responsibility, not the chef's. So 99%+ of users never hit this. T2.4.1 is now positioned as defensive hardening for the misuse case (developer accidentally shares one chef and concurrent compiles silently corrupt state). Worth doing eventually for fail-fast diagnostics, but not blocking anything.

**Trigger to revisit:** if a user files an issue about concurrent compile corruption, or if we want a stronger safety story for a 1.0 release.

**Problem (preserved for when this is implemented).** `compile()` reads and mutates instance state across `await` points. Concurrent calls on the same chef instance corrupt each other:

| State | Mutation source | compile() touch | Hazard |
|---|---|---|---|
| `systemPrompt` / `history` / `dynamicState*` | `setX` setters | reads at multiple steps | Stale read mid-compile |
| `_currentSignal` | compile() entry/finally | event bridges | Signal clobbering across overlapping compiles |
| `_activeSkill` / `_skillInstructions` | `activateSkill()` | step 5b + payload meta | Skill switches mid-compile, output inconsistent |
| `memory` KV + `turnCount` | `set` / `delete` / `sweep` / `advanceTurn` | step 4-5 | Turn double-advance, KV race, TTL pollution |
| `janitor._consecutiveFailures` | `compress()` | step 1 | Circuit breaker counter races |

**Recommended design (B): Snapshot + Serialize.**

```typescript
private _compileQueue: Promise<unknown> = Promise.resolve();

interface CompileSnapshot {
  systemPrompt: Message[];
  history: Message[];
  dynamicState: Message[];
  dynamicStatePlacement: DynamicStatePlacement;
  dynamicStateXml: string;
  activeSkill: Skill | undefined;
  skillInstructions: string;
}

async compile(options?: CompileOptions): Promise<TargetPayload> {
  options?.signal?.throwIfAborted();         // pre-queue check
  const snapshot: CompileSnapshot = {
    systemPrompt: [...this.systemPrompt],
    history: [...this.history],
    dynamicState: [...this.dynamicState],
    dynamicStatePlacement: this.dynamicStatePlacement,
    dynamicStateXml: this.dynamicStateXml,
    activeSkill: this._activeSkill,
    skillInstructions: this._skillInstructions,
  };
  const myTurn = this._compileQueue.then(async () => {
    options?.signal?.throwIfAborted();       // post-queue, pre-execute check
    return this._compileImpl(options, snapshot);
  });
  // Failure isolation — one rejected compile must not poison the queue
  this._compileQueue = myTurn.then(() => undefined, () => undefined);
  return myTurn;
}
```

**Key semantics:**
- **Snapshot at call time** (not execution time) for simple value-type inputs (history, system prompt, dynamic state, skill). Mental model: "what you set is what gets compiled, regardless of subsequent mutations."
- **Memory and Janitor state intentionally NOT snapshot** — these have cross-compile accumulation semantics (turn counter is a logical clock; circuit breaker counts failures across attempts). Snapshotting would be wrong.
- **Serialization** ensures Memory/Janitor mutations during one compile are visible to the next, in the natural order.
- **Failure isolation** — rejected compile clears via `.then(noop, noop)`, so the next queued call still runs.

**Alternatives rejected:**
- **A. Auto-serialize, no snapshot** (~10 LOC) — solves Memory/Janitor races, but queued compiles read `this.X` at execution time, so a `setHistory()` between calls "time-travels" into earlier queued compiles. Reverse-debugging nightmare in production.
- **C. Detect-and-throw** (~5 LOC) — fail-fast `if (this._inflight) throw`. Honest but anti-pattern; pushes lock management onto users. Library should "just work."

**Tests required:**
- Two concurrent compiles serialize and both succeed
- Snapshot semantics: `setHistory(h2)` between two `compile()` calls → first sees h1, second sees h2
- Failure isolation: rejected compile does not block subsequent compiles
- Signal abort while waiting in queue throws immediately (no execution)
- Memory turn counter advances exactly once per compile (not per call)
- Skill switches between calls: each compile sees the skill that was active at its call time

**Documentation impact:**
- Add "Concurrency" subsection to README under Cancellation
- JSDoc on `compile()` explaining serialization + snapshot semantics
- Note that Memory/Janitor state is shared (not snapshot) by design

**Why not bundle into T2.4:** T2.4 was a clean +12-test addition to existing event semantics. Concurrency safety is an architectural change that touches compile()'s execution model. Better as its own changeset entry so users understand both the hazard fix and the new semantics. Per `feedback_bundle_small_patches`, this is a real bugfix that justifies its own release.

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
| **`onPayload` / `onResponse` middleware hooks** (was T2.2) | Users can already inspect via `chef.compile()` output (pre-send) or wrap the AI SDK middleware to inspect (post-send). The only unique value would be modifying payload after context-chef converts but before SDK dispatches — niche enough that no concrete user pain has surfaced. Adds cross-package surface area (ai-sdk-middleware + tanstack-ai) and tests for a "nice-to-have." Revisit if a user files an issue with a use case that genuinely cannot be done from outside. |
| **`Message._meta?: Record<string, unknown>` reservation** (was T3.4) | Speculative future-proofing — no concrete demand for `notification` / `progress` / UI message kinds in a compile-time context library. Adds surface area (adapters must decide whether to round-trip it; tests must verify nothing relies on it) and invites misuse ("just stash it in `_meta`"). pi has it because it ships a TUI/Web-UI framework; ContextChef does not. Cost of adding later when a real use case appears is low (additive optional field, no breaking change). |

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
