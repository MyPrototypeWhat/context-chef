---
"@context-chef/ai-sdk-middleware": major
---

v3: anti-double-compression guard + core v4 compression pipeline.

- When `providerOptions.anthropic.contextManagement` is present on a call and middleware compression is configured, middleware compression is skipped for that call with a one-time warning (the provider's server-side context management wins). Opt out with `allowDoubleCompression: true`.
- Inherits `@context-chef/core` v4 compression behavior — most notably the new default `triggerRatio: 0.7` (compression triggers at 70% of `contextWindow`; set `triggerRatio: 1` in the janitor options passed through for the old behavior) and the no-placeholder failure semantics.

See MIGRATION-4.md for details.
