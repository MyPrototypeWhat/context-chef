---
'@context-chef/core': minor
---

feat(offloader): add VFS lifecycle management

Adds `cleanup()` / `cleanupAsync()` for sweeping expired or over-cap entries, and `reconcile()` / `reconcileAsync()` for adopting orphan files after process restart (modeled on `npm cache verify`).

New `VFSConfig` fields: `maxAge` (ms since createdAt), `maxFiles`, `maxBytes` (true UTF-8 byte length via Buffer.byteLength), `onVFSEvicted` hook (errors logged and swallowed).

`VFSStorageAdapter` gains optional `list()` / `delete()` methods — capability-checked at runtime so existing custom adapters keep working unchanged. `FileSystemAdapter` implements both.

Eviction: maxAge sweep first, then single-pass LRU by accessedAt until both count and bytes caps are satisfied. Cleanup is never auto-triggered — call from your agent loop or wire to `compile:done`.

Public additions: `chef.getOffloader()`, `Offloader.cleanup`/`cleanupAsync`/`reconcile`/`reconcileAsync`/`getEntries`, `VFSEntryMeta`, `VFSCleanupResult`, `VFSEvictionReason`, `VFSCleanupNotSupportedError`, `CleanupOptions`.
