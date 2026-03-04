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

  archival?: {                       // optional, always tool-based
    // future: searchOptions, etc.
  },

  onMemoryUpdate?: (key, value, oldValue) => boolean,  // veto hook
  onMemoryChanged?: (event) => void,                    // notification hook
}
```

### Tier Separation: By Call Path, Not By LLM Decision

Tier is determined by **which code path writes the entry**, not by LLM or developer manually tagging:

| Call path | Writes to tier | Why |
|---|---|---|
| `extractAndApply(response)` | core | inline mode is core_memory's write protocol |
| `core_memory_update` tool call | core | core_memory's tool |
| `archival_memory_insert` tool call | archival | archival_memory's tool |
| `chef.memory().set(key, val)` | core (default) | developer direct call, can override with `{ tier: 'archival' }` |

LLM never sees or decides tier. The two tiers are exposed to the LLM as **separate interfaces with distinct prompts/tool descriptions** to prevent confusion.

### Prompt/Tool Isolation Between Tiers

**Critical**: core and archival must have clearly separated instructions so the LLM doesn't conflate them.

**Core memory** (inline mode prompt):

- "You have persistent core memory for key facts and preferences. Update it with `<update_core_memory>` tags."
- Injected content is labeled `<core_memory>` in system prompt
- Framing: small, stable, high-importance facts

**Core memory** (tool mode description):

- `core_memory_update`: "Save or update a key fact in your core memory (preferences, rules, conventions)."
- `core_memory_read`: "Read a specific entry from your core memory."
- Framing: CRUD on known keys

**Archival memory** (tool description):

- `archival_memory_search`: "Search your long-term knowledge archive for relevant information. Use when you need to recall details not in your core memory."
- `archival_memory_insert`: "Store information in your long-term archive for future retrieval."
- Framing: search-based, for large/infrequent knowledge

The distinction is reinforced by:

1. Different tool name prefixes (`core_memory_*` vs `archival_memory_*`)
2. Different tool descriptions (CRUD vs search semantics)
3. System prompt guidance: "Core memory = always-available key facts. Archive = searchable long-term storage."

---

## P0 — Immediate

### 1. Export `stripMemoryTags(content: string): string`

- Strip `<update_core_memory>` and `<delete_core_memory>` tags from LLM response
- Pure utility function, no side effects
- Reuse existing regexes from `Memory` class (`UPDATE_RE`, `DELETE_RE`)
- Rationale: ContextChef defines the tags, so it should provide the cleanup tool

### 2. Dual-mode memory (inline + tool)

**inline mode** (current behavior, default):

- `compile()` injects XML instruction into system prompt
- Developer calls `extractAndApply()` + `stripMemoryTags()` post-response

**tool mode**:

- `compile()` registers core memory tools via Pruner namespace system instead of XML instruction
- Core tools: `core_memory_update(key, value)`, `core_memory_delete(key)`, `core_memory_read(key)`
- Provide a resolver function for developers to route tool calls to memory operations
- No tag stripping needed — tool calls are structurally separate from assistant content

### 3. Entry metadata

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

---

## P1 — Extension

### 4. Two-tier memory (core + archival)

Builds on P0's metadata `tier` field and tool infrastructure:

- `archival` config field enables archival tier
- Archival tools: `archival_memory_search(query)`, `archival_memory_insert(key, value)`
- Tool descriptions clearly differentiate from core tools (see Architecture section)
- Developer provides search implementation (simple string match, or plug in vector search externally)
- Core and archival tool sets are orthogonal, can coexist

### 5. `selector` hook

```typescript
core: {
  selector?: (entries: MemoryEntry[]) => MemoryEntry[]
}
```

- Called during `compile()` before core memory injection
- Developer controls filtering, sorting, truncation **within core tier**
- Default: return all core entries
- Enables custom token budgeting, priority filtering, etc.

---

## P2 — Utilities & Observability

### 6. `createTokenBudgetSelector` utility

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

### 7. `onMemoryChanged` event hook

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

### 8. `compile()` metadata return

```typescript
const result = chef.compile(history);
result.meta.injectedMemoryKeys  // ['user_lang', 'project_rules']
result.meta.memoryTokenCount    // 342
```

- Observability for debugging and monitoring
- Know which memories were actually injected and at what cost

---

## Not Planned

The following patterns from the industry are intentionally out of scope for ContextChef:

- **Graph memory** (Mem0g, Zep/Graphiti, MAGMA): requires external graph DB, too heavy
- **Reflection / self-assessment**: requires extra LLM calls, belongs in agent framework layer
- **Vector retrieval / embeddings**: requires embedding model dependency, but can be plugged in via archival search implementation
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
