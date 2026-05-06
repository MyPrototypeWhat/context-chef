---
'@context-chef/ai-sdk-middleware': minor
'@context-chef/tanstack-ai': minor
---

feat(middleware): per-tool truncate overrides via `perTool`

Adds an opt-in `truncate.perTool` field to both middleware packages. Each entry is either a bare string (preserve the tool's result entirely — original text goes into the prompt unchanged and the storage adapter is bypassed) or an object `{ name, threshold?, headChars?, tailChars? }` that overrides one or more truncation params for a single tool. Tools not listed fall back to the top-level defaults; duplicate names follow last-wins semantics.

Lookup key is `part.toolName` in the AI SDK middleware (per-part filtering, so a single tool message can mix preserved and truncated parts) and `ModelMessage.name` in the TanStack AI middleware (tool messages without `name` silently fall through to the defaults). Wildcards are not supported and `storage` cannot be overridden per-tool. `perTool` only affects mechanical truncation — preserved messages can still be summarized later by `compress`.
