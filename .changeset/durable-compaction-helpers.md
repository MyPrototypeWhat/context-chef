---
'@context-chef/ai-sdk-middleware': patch
---

Add caller-owned durable compaction helpers, and warn when in-flight `compress` is used without persistence.

- **`compactHistory(prompt, model, options)`**: one-shot durable compaction — splits the prompt on turn boundaries, summarizes the old slice via `summarizeMessages`, and returns a new prompt ready to persist (`[...system, <wrapped summary>, ...recent turns]`). Returns the prompt unchanged when there is nothing old enough to compact or the summarizer yields no text. The recommended way to keep a long agent loop / chat lean when you own the message store.
- **`planCompaction(prompt, { keepRecentTurns })`**: the synchronous split behind `compactHistory`, returning `{ system, toSummarize, toKeep }`. Cuts only on turn boundaries (an assistant + its tool results stay together), so it never orphans a tool result or splits a multi-block assistant message; system messages are preserved verbatim and never summarized.
- **Persistence warning**: the middleware now logs a one-time warning when `compress` keeps firing without an `onCompress` hook. In-flight compression only rewrites each outgoing request — without write-back the history re-expands every call and the payload grows unbounded. Steers users toward `onCompress` persistence or `compactHistory` for sustained over-budget conversations.

No behavior change to existing configurations; the new exports are additive.
