---
'@context-chef/core': minor
'@context-chef/ai-sdk-middleware': patch
---

Add caller-owned durable compaction helpers (provider-agnostic in core), and warn when in-flight `compress` is used without persistence.

- **`@context-chef/core` — `planCompaction` / `compactHistory`**: the durable compaction engine, operating on the IR `Message[]` so any provider path can use it.
  - **`compactHistory(history, compress, options)`**: one-shot durable compaction — splits on turn boundaries, summarizes the old slice via `summarizeHistory`, and returns a new history ready to persist (`[...system, <wrapped summary>, ...recent turns]`). Returns the input `history` reference unchanged when there is nothing old enough to compact or the summarizer yields no text, so callers can skip persistence via `result === history`. `compress` is injected (core never calls a model directly).
  - **`planCompaction(history, { keepRecentTurns })`**: the synchronous split, returning `{ system, toSummarize, toKeep }`. Cuts only on turn boundaries (an assistant + its tool results stay together), so it never orphans a tool result or splits a multi-block assistant message; system messages are preserved verbatim and never summarized. Input is a flat `Message[]` with system inline.
- **`@context-chef/ai-sdk-middleware` — `compactHistory(prompt, model, options)` / `planCompaction(prompt, options)`**: thin AI-SDK wrappers over the core engine — they convert the prompt to core's IR and back, and bind the model into the compression callback. Same signatures and behavior as before, including the no-op reference guarantee.
- **Persistence warning**: the middleware now logs a one-time warning when `compress` keeps firing without an `onCompress` hook. In-flight compression only rewrites each outgoing request — without write-back the history re-expands every call and the payload grows unbounded. Steers users toward `onCompress` persistence or `compactHistory` for sustained over-budget conversations.

No behavior change to existing configurations; the new exports are additive.
