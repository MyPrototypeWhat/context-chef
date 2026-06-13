---
'@context-chef/core': minor
'@context-chef/ai-sdk-middleware': minor
'@context-chef/tanstack-ai': minor
---

Content-addressed VFS, logger hook, compression boundaries, and placeholder-style clearing.

- **Content-addressed VFS filenames** (`vfs_<sha256-16>.txt`): re-offloading identical content is now idempotent — same filename, byte-stable truncation marker (so provider prompt-prefix caches survive long agent loops), no redundant disk writes. Storage adapters may implement an optional `exists()` to skip writes; `FileSystemAdapter` now writes atomically (tmp file + rename). Legacy timestamped files keep resolving and reconciling.
- **Optional `logger` hook** (`ChefLogger { warn }`) threaded through core (`ChefConfig`, `JanitorConfig`, `VFSConfig`) and both middlewares. Degradation warnings (storage write failures, missing usage data, missing tokenizer) route to your host logger instead of `console`. Defaults to `console`.
- **`onCompress` now receives a third `details` argument** carrying `compressedMessages` — the exact slice of history the summary replaced — so persistence layers can map the summary back to a precise boundary in their own store. Existing two-argument callbacks remain compatible.
- **New placeholder-style `clear` option** on both middlewares (core `Janitor.compact` semantics): cleared tool results become `'[Old tool result content cleared]'` and thinking is nulled, preserving message structure and tool-call pairing — unlike `compact`, which deletes. Runs after compression so the summarizer still sees full output; auto-injects a system instruction so the model doesn't read placeholders as errors. Core also exports the underlying pure `compactMessages` function.
