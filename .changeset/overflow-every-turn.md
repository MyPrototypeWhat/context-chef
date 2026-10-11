---
"@context-chef/core": patch
---

In-flight overflow no longer sends the full history on the turn after a compression.

A host that keeps its own full history and passes it to `setHistory` every turn relies on the documented in-flight behavior: the summary is recomputed on every call. Instead, the compile right after each compression skipped the budget check entirely (the "E10" cooldown), so every other turn went out uncompressed. In a long conversation that payload kept growing until the provider rejected it for exceeding the context window.

The compile after a compression now still checks the budget. It ignores only a reported usage (`reportTokenUsage` / `feedTokenUsage`), which may describe the payload from before the compression, and judges the window by its own count. A host that kept the compressed history is under budget and nothing happens; a host that passes its full history again gets it compressed again. `JanitorSnapshot.suppressNextCompression` keeps its name, so stored snapshots still restore.
