---
'@context-chef/ai-sdk-middleware': minor
---

Add ModelMessage-altitude durable compaction.

`compactModelMessages`, `planCompactionModelMessages`, and `summarizeModelMessages` operate on `ModelMessage[]` — the message type `generateText`/`prepareStep` actually use — so you can run durable compaction directly against your own message store, or inside a `ToolLoopAgent` `prepareStep`. They reuse the provider-agnostic core engine, and `compactModelMessages` preserves the no-op reference-identity contract (returns the input array unchanged when there is nothing old enough to compact, so callers can skip persistence).

`createCompressionAdapter` now accepts `ai`'s `LanguageModel` (a model id string, or a V3/V2 model) — matching what `prepareStep`/`generateText` hand you — instead of only `LanguageModelV3`.

Deprecates the `LanguageModelV3Prompt`-typed `compactHistory` / `planCompaction` (still exported and fully working) in favor of the ModelMessage variants; they are slated for removal in the next major. `summarizeMessages` is unchanged.

Also fixes three round-trip issues in both AI-SDK adapters (V3 and ModelMessage): provider-executed (inline) tool-results no longer trigger a spurious `[No tool result available]` placeholder; tool-message-level `providerOptions` (e.g. Anthropic cache control) is now preserved; and a tool-call with `undefined` input serializes to `"{}"` instead of a non-string value.
