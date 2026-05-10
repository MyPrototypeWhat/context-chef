---
"@context-chef/ai-sdk-middleware": minor
"@context-chef/tanstack-ai": minor
"@context-chef/core": minor
---

feat: add `usagePreference` to control which token source drives compression triggers

When both a `tokenizer` and a `reportTokenUsage()` value are available, you can now choose
how the Janitor decides whether to compress:

- `'max'` (default, backward-compatible) — `Math.max(tokenizer, fed)`. Most conservative;
  any over-budget signal triggers compression.
- `'feedFirst'` — prefer the API-reported usage when present, fall back to the tokenizer.
  Use when reported usage is authoritative and the tokenizer over-estimates (e.g. one
  config shared across providers, some of which report usage and some of which rely on
  the tokenizer fallback).
- `'tokenizerFirst'` — ignore the fed value entirely; trust the tokenizer.

The split-index calculation is unchanged — it always uses precise per-turn tokenization
in the tokenizer path. `usagePreference` only affects the trigger decision.

Both middleware packages expose this as `compress.usagePreference`. When `'tokenizerFirst'`
is set without a `tokenizer`, the middleware sanitizes it to `'max'` at construction time
with a console warning.

**Type-level note.** `JanitorConfig` is now a discriminated union on `tokenizer` presence.
TypeScript rejects `'tokenizerFirst'` at compile time when no tokenizer is configured.
Callers that previously passed `tokenizer: SomeFn | undefined` in a single literal will
need to split construction into two branches (`tokenizer ? new Janitor({...}) : new Janitor({...})`);
runtime behavior is unchanged.
