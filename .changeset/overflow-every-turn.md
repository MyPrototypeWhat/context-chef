---
"@context-chef/core": patch
---

In-flight overflow no longer skips the budget check on the turn after a compression.

A host that keeps its own full history and passes it to `setHistory` every turn relies on the documented in-flight behavior: the summary is recomputed on every call. Instead, the compile right after each compression skipped the budget check entirely (the "E10" cooldown), so every other turn went out uncompressed. In a long conversation that payload kept growing until the provider rejected it for exceeding the context window.

The compile after a compression now checks the budget like any other. A usage reported after the compression (`reportTokenUsage` / `feedTokenUsage`) counted the compressed request and is used as usual. Only a usage reported while the compression was running, which may describe the payload from before it, is ignored, and the window is judged by its own count. A host that kept the compressed history is under budget and nothing happens. A host that passes its full history again gets it compressed again whenever its own count of that history decides: with a `tokenizer` (under the default `usagePreference: 'max'`), or with no usage reported since the compression. Without a tokenizer a reported usage stands for the next request, so a host that reports the usage of the compressed request and then passes its full history still sends that history uncompressed every other turn; keep the compressed history, or configure a tokenizer. `JanitorSnapshot.suppressNextCompression` keeps its name, so stored snapshots still restore.
