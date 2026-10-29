---
"@context-chef/core": patch
---

In-flight overflow no longer sends the full history on the turn after a compression.

A host that keeps its own full history and passes it to `setHistory` every turn relies on the documented in-flight behavior: the summary is recomputed on every call. Instead, the compile right after each compression skipped the budget check entirely (the "E10" cooldown), so every other turn went out uncompressed. In a long conversation that payload kept growing until the provider rejected it for exceeding the context window. The AI SDK and TanStack AI middlewares compress this way.

The compile after a compression now checks the budget like any other. A usage you report after the compression (`reportTokenUsage` / `feedTokenUsage`, or the middleware's automatic feed) counted the compressed request, so it is used only while the history you pass still holds the compression's summary, that is, while you kept the compressed history. If you pass your full history again, that report describes a different request: it is ignored, the window is judged by its own count, and it is compressed again. A usage reported while the compression was still running is always ignored. `JanitorSnapshot.suppressNextCompression` keeps its name, so stored snapshots still restore. The new optional `JanitorSnapshot.landedSummary` carries the compression's summary across a snapshot, so a chef restored from it still counts a usage report of the compressed history you kept; a snapshot saved without it restores with that report ignored.

The summary is recognized only as it was handed to you through `onCompress`: a user message with exactly that text. Kept in another form, as a system message, behind a prefix of your own or reflowed, it isn't, so the report is ignored and the window is judged by its own count. Without a `tokenizer` that count is an estimate, which can put a history with an image or a document in it over the trigger and compress it every turn. With a `tokenizer` the count is right either way.
