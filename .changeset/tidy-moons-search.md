---
"@context-chef/core": minor
---

Fix Gemini tool call correlation, harden Janitor compression failure paths, and add shared middleware infrastructure.

- `fromGemini` now synthesizes tool call IDs with per-name counters spanning the whole conversation and correlates each `functionResponse` to the oldest unconsumed call of the same name (FIFO). Previously the correlation state was scoped to a single message, so responses arriving in a later content entry always fell back to the `-0` suffix — repeat calls of the same tool produced duplicate IDs and misattributed results.
- When the compression model throws, the raw error is no longer appended to the LLM-bound fallback summary. It now goes to the configured `logger` (default `console`) instead, keeping stack traces out of model context.
- A throwing/rejecting `onCompress` hook no longer aborts `compile()`. It is caught and logged via `logger`; the compression result is kept. Hooks that follow the documented "must not throw" contract see no behavior change.
- `onBeforeCompress` (and the deprecated `onBudgetExceeded`) now degrade the same way: a throwing hook is caught, logged via `logger`, and treated as if it returned `null` — default compression proceeds. Both hooks now share one failure stance: a broken hook never fails `compile()`.
- The text-placeholder vocabulary is centralized in `Prompts`: new `getAttachmentPlaceholder` (previously janitor-internal), `getToolResultFilePlaceholder`, and `getToolResultPartPlaceholder`. Formats are unchanged — this gives each convention a single source instead of scattered string literals.
- New export `SessionPool<T>` — a keyed instance pool with LRU eviction, used by the middleware packages to hold one Janitor per conversation. `maxSize` is validated (throws `RangeError` unless a positive integer — a non-positive cap would silently evict every entry on insert, disabling pooling). Companion exports `DEFAULT_SESSION_KEY`, `normalizeSessionKey`, and `dedupeConstructionWarnings` back the middlewares' shared session-key normalization and construction-nag dedupe.
- New export `flattenForCompression(messages)` — the canonical role-flattening implementation required by the `summarizeHistory` compress-callback contract (tool results → user messages, tool calls → assistant text).
- `OpenAIAdapter.compile` replaces its per-message `JSON.parse(JSON.stringify(...))` deep clone with a direct clone that skips `undefined` properties — same output, no string serialization detour (noticeable with base64 attachments). The clone honors `toJSON`, so a `Date` still lands as its ISO string.
