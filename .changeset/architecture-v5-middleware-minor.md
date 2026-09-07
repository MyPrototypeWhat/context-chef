---
"@context-chef/ai-sdk-middleware": minor
---

Track core 4.2: one context store, one overflow strategy.

- **`truncate.store`** replaces **`truncate.storage`** (now `@deprecated`): pass a `StorageBackend` — `InMemoryBackend`, `FileSystemBackend`, your own — or a pre-built `Store` shared with an archive, instead of a bare `VFSStorageAdapter`. `store` wins when both are set; a legacy adapter still works and is wrapped with `Store.fromVfsAdapter`. Truncated output carries the same `context://vfs/` URI either way, readable back through `chef.resolveRecall(uri)` or the `context` tool's `view`.
- **`overflow: { strategy, archive }`**: pass an explicit `OverflowStrategy` — `summarize()`, `anchored()`, `reset()`, composed with `chain()` / `background()` — in place of the policy the `compress` options describe, and an `archive` that keeps the evicted span retrievable behind the URI its summary cites. Setting `overflow.strategy` ignores the `compress` tuning options (two descriptions of one thing would disagree); the runner concerns — `contextWindow`, `tokenizer`, `compress.triggerRatio`, `compress.usagePreference`, `onCompress`, `onBeforeCompress` — keep applying whatever the strategy is, and `contextWindow` stays required. `archive` takes the explicit `{ store }` form: the `'vfs'` shorthand substitutes a ContextChef-owned Offloader, which a middleware does not have.
- Internally the per-session Janitor assembly, the missing-`contextWindow` throw and the compress-without-persistence warning now come from core's shared `createJanitorPool()` instead of a copy maintained here. No behavior change.

`tools` mode has no target in this package: it neither constructs a `ContextChef` nor dispatches library-owned tools, so the `context` tool is reached through a chef in your own loop.
