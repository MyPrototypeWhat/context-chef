# Memory Module Optimization Roadmap

## Background

Current memory module uses inline XML tags (`<update_core_memory>` / `<delete_core_memory>`) in LLM responses, with a flat KV store that injects all entries into the system prompt. Based on industry research (Mem0, Letta/MemGPT, Zep, A-MEM, MAGMA), the following optimizations are planned.

Design principle: **ContextChef provides mechanisms (hooks + utility functions), not policies.**

---

## Architecture Overview

### Unified Config

```typescript
memory: {
  store: myStore,                    // single store, shared by both tiers

  core: {
    mode: 'inline' | 'tool',        // write protocol (default: 'inline')
    selector?: (entries) => entries,  // filter/sort within core tier
    allowedKeys?: string[],
  },

  archival?: {                       // optional, low priority
    search: (query: string) => MemoryEntry[] | Promise<MemoryEntry[]>,
    // developer provides search implementation (string match, vector DB, etc.)
    // search logic stays out of MemoryStore interface
  },

  onMemoryUpdate?: (key, value, oldValue) => boolean,  // veto hook
  onMemoryChanged?: (event) => void,                    // notification hook
}
```

### Tier Separation: By Call Path, Not By LLM Decision

Tier is determined by **which code path writes the entry**, not by LLM or developer manually tagging:

| Call path | Writes to tier | Why |
| --- | --- | --- |
| `extractAndApply(response)` | core | inline mode is core_memory's write protocol |
| `core_memory_update` tool call | core | core_memory's tool |
| `archival_memory_insert` tool call | archival | archival_memory's tool |
| `chef.memory().set(key, val)` | core (default) | developer direct call, can override with `{ tier: 'archival' }` |

LLM never sees or decides tier. The two tiers are exposed to the LLM as **separate interfaces with distinct prompts/tool descriptions** to prevent confusion.

### Core Memory: Read via Injection, Write via Mode

In **both** inline and tool mode, core memory content is always injected into the system prompt. LLM can read core memory directly from context without any tool call.

The `mode` only determines the **write protocol**:

- **inline**: LLM writes `<update_core_memory>` tags in response
- **tool**: LLM calls `core_memory_update` / `core_memory_delete` tools

There is no `core_memory_read` tool — it would be redundant since all core entries are already visible in the system prompt.

### Prompt/Tool Isolation Between Tiers

**Critical**: core and archival must have clearly separated instructions so the LLM doesn't conflate them.

**Core memory** (inline mode prompt):

- "You have persistent core memory for key facts and preferences. Update it with `<update_core_memory>` tags."
- Injected content is labeled `<core_memory>` in system prompt
- Framing: small, stable, high-importance facts

**Core memory** (tool mode description):

- `core_memory_update`: "Save or update a key fact in your core memory (preferences, rules, conventions)."
- `core_memory_delete`: "Remove a key from your core memory."
- No read tool — core memory is already visible in the system prompt
- Framing: write-only tools for known keys

**Archival memory** (tool description):

- `archival_memory_search`: "Search your long-term knowledge archive for relevant information. Use when you need to recall details not in your core memory."
- `archival_memory_insert`: "Store information in your long-term archive for future retrieval."
- Framing: search-based, for large/infrequent knowledge

The distinction is reinforced by:

1. Different tool name prefixes (`core_memory_*` vs `archival_memory_*`)
2. Different tool descriptions (write-only CRUD vs search semantics)
3. System prompt guidance: "Core memory = always-available key facts. Archive = searchable long-term storage."

---

## P0 — Immediate

> **Implementation order**: #3 metadata → #2 dual-mode → #1 stripMemoryTags
>
> Rationale: metadata (#3) provides the `tier` field that dual-mode (#2) depends on for routing.
> stripMemoryTags (#1) has zero dependencies and is simplest, so it goes last.

### 1. Entry metadata

Extend `MemoryEntry`:

```typescript
interface MemoryEntry {
  key: string;
  value: string;
  tier: 'core' | 'archival';   // determined by call path, default: 'core'
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  importance?: number;          // developer-set, 1-10, optional
}
```

- `MemoryStore` interface updated to support metadata
- `InMemoryStore` and `VfsMemoryStore` both updated
- `lastAccessedAt` auto-updated when entry is injected during `compile()`
- `tier` field enables two-tier memory without separate stores

### 2. Dual-mode memory (inline + tool)

**inline mode** (current behavior, default):

- `compile()` injects XML instruction + core memory content into system prompt
- Developer calls `extractAndApply()` + `stripMemoryTags()` post-response

**tool mode**:

- `compile()` injects core memory content into system prompt (same as inline — always readable)
- `compile()` registers write-only tools via Pruner namespace instead of XML instruction
- Core tools: `core_memory_update(key, value)`, `core_memory_delete(key)`
- No `core_memory_read` — content already in system prompt
- Provide a resolver function for developers to route tool calls to memory operations
- No tag stripping needed — tool calls are structurally separate from assistant content

### 3. Export `stripMemoryTags(content: string): string`

- Strip `<update_core_memory>` and `<delete_core_memory>` tags from LLM response
- Pure utility function, no side effects
- Reuse existing regexes from `Memory` class (`UPDATE_RE`, `DELETE_RE`)
- Rationale: ContextChef defines the tags, so it should provide the cleanup tool
- Only needed for inline mode; tool mode doesn't produce tags

---

## P1 — Extension

### 4. `selector` hook

```typescript
core: {
  selector?: (entries: MemoryEntry[]) => MemoryEntry[]
}
```

- Called during `compile()` before core memory injection
- Developer controls filtering, sorting, truncation **within core tier**
- Default: return all core entries
- Enables custom token budgeting, priority filtering, etc.

### 5. `onMemoryChanged` event hook

```typescript
onMemoryChanged?: (event: {
  type: 'set' | 'delete';
  key: string;
  tier: 'core' | 'archival';
  value: string | null;
  oldValue: string | null;
}) => void
```

- Pure notification, does not affect write flow (unlike `onMemoryUpdate` which is a veto)
- Use cases: logging, external sync, multi-agent shared memory

### 6. `compile()` metadata return

```typescript
const result = chef.compile(history);
result.meta.injectedMemoryKeys  // ['user_lang', 'project_rules']
result.meta.memoryTokenCount    // 342
```

- Observability for debugging and monitoring
- Know which memories were actually injected and at what cost

---

## P2 — Utilities

### 7. `createTokenBudgetSelector` utility

```typescript
import { createTokenBudgetSelector } from 'context-chef';

const selector = createTokenBudgetSelector({
  budget: 2000,
  scorer?: (entry: MemoryEntry) => number
  // default scorer: recency-based decay 0.995^hoursSinceLastAccess
});
```

- Deterministic scoring, no LLM dependency
- Default: pure time decay based on `lastAccessedAt`
- Developer can set `importance` manually and provide custom scorer
- Accumulate token count, stop when budget exceeded

---

## P3 — Low Priority (Pending User Demand)

### 8. Two-tier memory (core + archival)

Builds on P0's metadata `tier` field and tool infrastructure:

- `archival` config field enables archival tier
- Archival tools: `archival_memory_search(query)`, `archival_memory_insert(key, value)`
- Search logic provided by developer via config, not built into MemoryStore:

  ```typescript
  archival: {
    search: (query: string) => MemoryEntry[] | Promise<MemoryEntry[]>
  }
  ```

- Tool descriptions clearly differentiate from core tools (see Architecture section)
- Core and archival tool sets are orthogonal, can coexist
- Deferred until real user demand: most memory use cases involve short entries that fit comfortably in core

---

## Observability & Time Travel Enhancements

> Inspired by [tape.systems](https://tape.systems/) / [bubbuild/bub](https://github.com/bubbuild/bub) comparison.
> Core insight: context-chef currently treats everything as flat `Message[]`. Adding lightweight type annotations and per-module state ownership improves time travel, debugging, and observability — without changing the compilation model.

### 9. `MessageKind` — typed message annotations

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

### 10. `CompileEvent` — compilation event log

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
  implicitContext: boolean;   // whether onBeforeCompile injected content
  tokenEstimate?: number;
}
```

- `ContextChef` maintains an internal `CompileEvent[]` log
- Accessible via `chef.getCompileHistory(): readonly CompileEvent[]`
- Combined with snapshots, provides full causality: snapshot = "state at a point", CompileEvent = "what happened between states"
- Included in `ChefSnapshot.events` for time travel replay

### 11. Module state ownership pattern

Each stateful module implements a consistent state interface. `ChefSnapshot` composes module states instead of reaching into module internals.

**Current problem:**

```typescript
// ContextChef manually picks fields from each module
interface ChefSnapshot {
  readonly _janitor: JanitorSnapshot;     // _ prefix on public API
  readonly _memoryStore?: Record<string, string>;  // leaks store implementation
  // Pruner state? missing. Pointer state? missing.
}
```

**Target:**

```typescript
// Each stateful module defines its own state type
interface JanitorState { externalTokenUsage: number | null; suppressNextCompression: boolean; }
interface MemoryState  { entries: Record<string, string>; }
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

- **Graph memory** (Mem0g, Zep/Graphiti, MAGMA): requires external graph DB, too heavy
- **Reflection / self-assessment**: requires extra LLM calls, belongs in agent framework layer
- **Vector retrieval / embeddings**: requires embedding model dependency, but can be plugged in via archival `search` implementation
- **LLM-based importance scoring**: unreliable, adds cost
- **LLM-based memory consolidation**: same as above

These should be implemented at the agent framework layer, using ContextChef's hooks (`selector`, `onMemoryChanged`, `onMemoryUpdate`) as integration points.

---

## References

- [Mem0 (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [MemGPT/Letta (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Zep/Graphiti (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [MAGMA (arXiv 2601.03236)](https://arxiv.org/abs/2601.03236)
- [Memory in the Age of AI Agents Survey (arXiv 2512.13564)](https://arxiv.org/abs/2512.13564)
- [Generative Agents (ar5iv 2304.03442)](https://ar5iv.labs.arxiv.org/html/2304.03442)
