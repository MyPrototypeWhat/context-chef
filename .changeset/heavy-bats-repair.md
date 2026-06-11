---
'@context-chef/core': patch
---

`FileSystemAdapter.write()` now recreates the storage directory and retries once when it has been removed externally (e.g. OS temp cleaners purging `/var/folders` on long-running hosts). Previously the directory was only created in the constructor, so a purged directory made every subsequent offload write throw `ENOENT` — and chef's truncator would silently degrade to discard-the-original truncation for the rest of the process.
