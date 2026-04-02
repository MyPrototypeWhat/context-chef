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

---

## Planned

### Turn-Based Grouping for Janitor

**Priority: High** — Replaces `adjustSplitIndex` with a structurally correct, predictable split mechanism. Also resolves the `compact(keepRecent)` vs `adjustSplitIndex` conflict where the two mechanisms have incompatible definitions of "recent."

**Problem**: `adjustSplitIndex` is a post-hoc patch that moves the split point unpredictably to preserve API invariants (tool pairs, message alternation). When combined with `compact(keepRecent)`, cleared tool results near the split boundary can trigger unnecessary pair protection, pulling already-cleared messages into the "clear present" range.

Claude Code avoids this problem by using a very small, fixed `preserveRecentMessages` and running compact/compress in separate lifecycle events. ContextChef's token-ratio-based split + same-call compact/compress pipeline exposes the conflict.

**Design**: Group messages into atomic "turns" before split calculation. Split only on turn boundaries.

```typescript
interface Turn {
  messages: Message[];
  startIndex: number;
  endIndex: number;  // exclusive
}

// Grouping rules:
// - user message → single-message turn
// - system message → single-message turn
// - assistant (no tool_calls) → single-message turn
// - assistant (with tool_calls) + all subsequent tool results → one atomic turn
```

**Implementation**:
- Add `groupIntoTurns(history: Message[]): Turn[]` utility
- In `evaluateBudget()`, iterate turns (not messages) from the tail, accumulating token costs per turn
- `splitIndex = turns[splitTurn].startIndex` — always lands on a turn boundary
- Remove `adjustSplitIndex()` — tool pair protection and alternation are guaranteed by the grouping
- Update `compact(keepRecent)` to count turns (not individual tool messages) for consistent "recent" semantics
- `feedTokenUsage` path: `preserveRecentMessages` counts turns, not messages

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

### Remove System Message Protection in `executeCompression`

**Priority: High** — Current diff adds defensive code to filter system messages from the compressed range. This is unnecessary because:

1. Core path: `setSystemPrompt()` and `setHistory()` are separate APIs — system messages shouldn't be in history
2. Middleware path: system messages are filtered out before compression (`allIR.filter(m => m.role === 'system')`)
3. Anthropic/Gemini APIs don't allow system messages in the messages array — adapters extract them to top-level
4. OpenAI allows system anywhere, but developers don't put system messages in `setHistory()`

**Action**: Remove the `systemMessages` filtering in `executeCompression()`. If a system message appears in history, that's a caller bug, not Janitor's responsibility.

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

### Compression Circuit Breaker

**Priority: Medium** — Prevents infinite retry loops when `compressionModel` consistently fails.

**Reference**: Claude Code's `autoCompact.ts` tracks `consecutiveFailures` and stops retrying after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`.

**Implementation**:
- Add `consecutiveFailures: number` to Janitor private state
- Add `MAX_FAILURES = 3` constant
- In `compress()`: if `consecutiveFailures >= MAX_FAILURES`, return `history` unchanged
- In `executeCompression()`: on success, reset to 0; on catch, increment
- Add to `JanitorSnapshot` and `snapshotState()`/`restoreState()`/`reset()`
- Add optional `onCompressError?: (info: { failures: number; tripped: boolean }) => void` to `JanitorConfig`

---

### Built-in Compression Prompt Utilities

**Priority: Medium** — Reduces boilerplate for developers using `compressionModel`.

**Reference**: Claude Code's `prompt.ts` uses a two-phase `<analysis>` + `<summary>` pattern where the LLM first reasons in an `<analysis>` scratchpad (stripped from final output), then produces a structured `<summary>`. This measurably improves summary quality.

**Implementation**:
- `Prompts.COMPACT_PROMPT` — structured prompt with the analysis+summary pattern, usable as the final user message in a `compressionModel` call
- `Prompts.formatCompactSummary(raw: string): string` — strips `<analysis>...</analysis>`, extracts content from `<summary>...</summary>`, cleans whitespace
- `Prompts.PARTIAL_COMPACT_PROMPT` — variant for partial history compression (only summarize the old portion, recent messages are preserved separately)

These are pure utilities, not policies — developers choose whether to use them.

Example:
```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 128_000,
    compressionModel: async (msgs) => {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [...msgs, { role: 'user', content: Prompts.COMPACT_PROMPT }],
      });
      return Prompts.formatCompactSummary(resp.choices[0].message.content);
    },
  },
});
```

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
