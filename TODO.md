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

---

## Planned

### Tool Pair Protection in Janitor — Correctness Fix

**Priority: Critical** — Without this, `compress()` can produce invalid API payloads.

When Janitor splits history at `splitIndex`, it may separate a `tool_calls` assistant message from its corresponding `tool` result message. All LLM APIs (OpenAI, Anthropic, Gemini) require every `tool_use`/`tool_calls` to have a matching `tool_result`/`tool` response — splitting the pair causes a hard API error.

**Reference**: Claude Code's `adjustIndexToPreserveAPIInvariants()` in `sessionMemoryCompact.ts` handles this by:
1. Collecting all `tool_call_id`s in the kept range
2. Scanning backwards for assistant messages with matching `tool_calls`
3. Expanding `splitIndex` backwards to include the full pair

**Implementation**:
- Add `adjustSplitIndex(history: Message[], splitIndex: number): number` to Janitor
- After calculating `splitIndex` in `evaluateBudget()`, run the adjustment before returning
- Walk kept messages for `role: 'tool'` entries, collect their `tool_call_id`s
- Scan backwards from `splitIndex` for `role: 'assistant'` messages whose `tool_calls[].id` matches
- Expand `splitIndex` backwards to include those assistant messages

```typescript
// Pseudo-code
private adjustSplitIndex(history: Message[], splitIndex: number): number {
  // Collect tool_call_ids from kept messages (splitIndex..end)
  const keptToolCallIds = new Set<string>();
  for (let i = splitIndex; i < history.length; i++) {
    if (history[i].role === 'tool' && history[i].tool_call_id) {
      keptToolCallIds.add(history[i].tool_call_id!);
    }
  }
  if (keptToolCallIds.size === 0) return splitIndex;

  // Scan backwards for matching assistant tool_calls
  let adjusted = splitIndex;
  for (let i = splitIndex - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'assistant' && msg.tool_calls?.some(tc => keptToolCallIds.has(tc.id))) {
      adjusted = i;
    }
  }
  return adjusted;
}
```

---

### Enhanced `compact()` — Fine-Grained Tool Result Clearing

**Priority: High** — Current `compact({ clear: ['tool-result'] })` clears ALL tool results indiscriminately. Real agent loops need selective clearing.

**Reference**: Claude Code's `microCompact.ts` uses a `COMPACTABLE_TOOLS` whitelist and `keepRecent` count to selectively clear old tool results while preserving recent ones and specific tool types.

**Design**: Extend `ClearTarget` union to support object form with options:

```typescript
type ClearTarget =
  | 'thinking'                               // simple targets stay as string
  | {
      target: 'tool-result';
      keepRecent?: number;                    // preserve last N tool results (default: 0 = clear all)
      toolFilter?: string[];                  // only clear results from these tool names (matches tool_call_id's corresponding function name)
    };
```

The object form is only needed for `'tool-result'` since it's the only target that benefits from selective clearing. `'thinking'` remains a simple string — there's no meaningful "keep recent N thinking blocks" use case.

**Implementation**:
- Update `ClearTarget` type in `types/index.ts`
- In `Janitor.compact()`, when processing a `tool-result` target object:
  - Collect all `role: 'tool'` messages in reverse order
  - Skip the last `keepRecent` entries
  - If `toolFilter` is set, only clear messages whose corresponding `tool_calls` function name is in the filter
  - Resolving function name requires scanning the preceding assistant message for the matching `tool_calls[].id` → `function.name`

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

### Strip Media Before Compression

**Priority: Low** — Small change, prevents wasted tokens and potential prompt-too-long errors during compression.

**Reference**: Claude Code's `stripImagesFromMessages()` in `compact.ts` replaces image/document blocks with `[image]`/`[document]` text markers before sending to the compression model. Images waste compression model tokens and contribute nothing to a text summary.

**Implementation**:
- Add `stripMediaFromHistory(history: Message[]): Message[]` utility
- Replace any message content containing base64 image data patterns or known media markers with `[media content]` placeholder
- Call this in `executeCompression()` before passing `toCompress` to `compressionModel`
- Since context-chef IR uses a flat `content: string`, detection is pattern-based (e.g., base64 data URI prefixes, or messages with `role: 'tool'` that contain very large content likely from image tools)
- For now, scope to a simple heuristic: if a tool result message's content exceeds a threshold (e.g., 50KB) and looks like base64, replace with `[large binary content cleared for compression]`

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
