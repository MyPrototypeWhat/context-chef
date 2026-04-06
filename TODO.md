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

### VFS Lifecycle Management

**Priority: High** — `.context_vfs/` directory grows unboundedly in long-running agents. No cleanup mechanism exists.

**Implementation**:
- Add `maxAge?: number` (ms) to `VFSConfig` — files older than maxAge are eligible for cleanup
- Add `maxFiles?: number` to `VFSConfig` — LRU eviction when file count exceeds limit
- Add `Offloader.cleanup()` method — scans storage, deletes expired/excess files
- Add `Offloader.cleanupAsync()` for async adapters
- Cleanup is developer-triggered (mechanism, not policy) — call in agent loop, on session end, etc.
- Optional: `autoCleanup?: boolean` in config to run cleanup on each `offload()` call

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

### Strip Media Before Compression

**Priority: Medium** — Prevents wasted tokens and potential prompt-too-long errors during compression.

**Reference**: Claude Code's `stripImagesFromMessages()` replaces image/document blocks with `[image]`/`[document]` text markers before sending to the compression model.

**Implementation**:
- Add `stripMediaFromHistory(history: Message[]): Message[]` utility
- Pattern-based detection: if content exceeds 50KB and contains base64 data URI prefix, replace with `[large binary content cleared for compression]`
- Call in `executeCompression()` before passing to `compressionModel`
- Since IR uses `content: string`, detection is heuristic-based

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

## References

- [Mem0 (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [MemGPT/Letta (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Zep/Graphiti (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [MAGMA (arXiv 2601.03236)](https://arxiv.org/abs/2601.03236)
- [Memory in the Age of AI Agents Survey (arXiv 2512.13564)](https://arxiv.org/abs/2512.13564)
- [Generative Agents (ar5iv 2304.03442)](https://ar5iv.labs.arxiv.org/html/2304.03442)
