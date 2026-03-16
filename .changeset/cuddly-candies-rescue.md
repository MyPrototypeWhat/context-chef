---
"context-chef": patch
---

Fix snapshot/restore reference leaks by replacing shallow copies with `structuredClone`

- **ContextChef**: `snapshot()` / `restore()` now deep-clone messages, isolating nested fields (`tool_calls`, `thinking`, `redacted_thinking`, custom fields)
- **InMemoryStore**: `snapshot()` / `restore()` now deep-clone `MemoryStoreEntry` references
- **Pruner**: `snapshotState()` / `restoreState()` now deep-clone tool `parameters` and `tags`
- **VFSMemoryStore**: Added `snapshot()` / `restore()` support (previously returned `null`, breaking memory state rollback)
