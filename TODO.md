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

## Observability & Time Travel Enhancements

> Inspired by [tape.systems](https://tape.systems/) / [bubbuild/bub](https://github.com/bubbuild/bub) comparison.
> Core insight: context-chef currently treats everything as flat `Message[]`. Adding lightweight type annotations and per-module state ownership improves time travel, debugging, and observability — without changing the compilation model.

### 1. `MessageKind` — typed message annotations

Add an optional `kind` field to `Message` to distinguish messages generated by context-chef internals from user-provided conversation messages.

```typescript
type MessageKind = 'compression' | 'memory' | 'implicit' | 'checkpoint';

interface Message {
  // ... existing fields
  kind?: MessageKind;  // undefined = normal conversation message
}
```

| `kind` | Produced by | Purpose |
| --- | --- | --- |
| `undefined` | User-provided message / tool_call / tool_result | Default. No annotation needed — message, tool_call, and tool_result are all "conversation" and distinguished by existing `role` / `tool_calls` / `tool_call_id` fields |
| `'compression'` | Janitor `executeCompression()` | Marks summary messages so time travel can show "⚠️ compression happened here" |
| `'memory'` | `_getMemoryMessages()` during `compile()` | Distinguishes injected core memory from developer-authored system prompts |
| `'implicit'` | `onBeforeCompile` hook during `compile()` | Marks externally injected context (RAG, AST, MCP) |
| `'checkpoint'` | Developer-initiated (future anchor/phase API) | Explicit stage boundary marker for structured time travel |

- Janitor sets `kind: 'compression'` on summary messages
- `_getMemoryMessages()` sets `kind: 'memory'` on injected memory messages
- `onBeforeCompile` implicit context injection sets `kind: 'implicit'`
- Adapters strip `kind` before sending to LLM (internal metadata only)

### 2. `CompileEvent` — compilation event log

Each `compile()` call produces a `CompileEvent` record. Not sent to the LLM — purely for developer observability and time travel causality tracking.

```typescript
interface CompileEvent {
  turn: number;
  ts: number;
  target: TargetProvider;
  inputMessages: number;      // message count before compression
  outputMessages: number;     // message count after compression
  compressed: boolean;
  compressedCount?: number;
  memoryInjected: string[];   // which memory keys were injected
  memoryExpired: string[];    // which memory keys expired this turn
  implicitContext: boolean;   // whether onBeforeCompile injected content
}
```

- `ContextChef` maintains an internal `CompileEvent[]` log
- Accessible via `chef.getCompileHistory(): readonly CompileEvent[]`
- Combined with snapshots, provides full causality: snapshot = "state at a point", CompileEvent = "what happened between states"
- Included in `ChefSnapshot.events` for time travel replay

### 3. Module state ownership pattern

Each stateful module implements a consistent state interface. `ChefSnapshot` composes module states instead of reaching into module internals.

**Target:**

```typescript
// Each stateful module defines its own state type
interface JanitorState { externalTokenUsage: number | null; suppressNextCompression: boolean; }
interface MemoryState  { entries: Record<string, MemoryStoreEntry>; turnCount: number; }
interface PrunerState  { flatTools: ToolDefinition[]; namespaces: ToolGroup[]; lazyToolkits: ToolGroup[]; }
interface PointerState { offloadRecords: OffloadRecord[]; }

// ChefSnapshot composes them under a clean namespace
interface ChefSnapshot {
  readonly label?: string;
  readonly createdAt: number;
  readonly topLayer: Message[];
  readonly rollingHistory: Message[];
  readonly dynamicState: Message[];
  readonly dynamicStatePlacement: DynamicStatePlacement;
  readonly rawDynamicXml: string;
  readonly modules: {
    readonly janitor: JanitorState;
    readonly memory: MemoryState | null;
    readonly pruner: PrunerState;
    readonly pointer: PointerState;
  };
  readonly events: CompileEvent[];  // compile history up to this snapshot
}
```

Benefits:
- No `_` prefix on public-facing types — `modules.janitor` instead of `_janitor`
- New modules automatically participate in snapshot by implementing `snapshot(): S` and `restore(state: S): void`
- Pruner and Pointer state are captured (currently missing from snapshots)
- Each module owns its state shape — changes don't require updating `ChefSnapshot` manually

Modules without state (Stitcher, Governor) are pure functions and do not participate.

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
