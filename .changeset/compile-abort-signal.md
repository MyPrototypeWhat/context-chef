---
'@context-chef/core': patch
---

Add `AbortSignal` support to `compile()` and event handlers (T2.4).

`CompileOptions.signal?: AbortSignal` propagates cooperative cancellation in two ways:

1. **Forwarded to event handlers** as the second argument. `chef.on(event, async (payload, signal) => { await db.write(payload, { signal }); })` lets observers honor cancellation in slow async work (DB writes, metric exports, fetch calls).
2. **Checked at compile() phase boundaries** — after `compile:start`, after Janitor compress, after `onBeforeCompile`, after memory sweep, after `transformContext`. Aborting throws via `signal.throwIfAborted()` (`DOMException` with `name: 'AbortError'`).

`EventHandler<T>` signature widened to `(payload: T, signal?: AbortSignal) => void | Promise<void>`. Backward compatible — handlers that don't declare the second parameter continue to work unchanged.

Memory events fired from external `memory().set()` / `memory().delete()` calls (outside `compile()`) receive `signal: undefined`.

**Caveats** (documented in `CompileOptions.signal` JSDoc):
- `compile:start` is emitted before any abort check — observers may receive a `compile:start` for a compile that ultimately throws without firing `compile:done`.
- Memory turn counter advances at step 4; aborting after step 4 leaves `Memory.turnCount` advanced even though no payload was produced.
- Cancellation is coarse-grained — long-running phases run to completion; abort honored at the next phase boundary.

**Known limitation**: `compile()` is not concurrency-safe on the same chef instance — concurrent calls clobber `_currentSignal`, double-advance the memory turn counter, and interleave skill/history reads. Serialize per chef instance, or create separate instances for parallel work. Snapshot+serialize support is planned (see `TODO.md` T2.4.1).
