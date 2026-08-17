---
"@context-chef/core": major
---

v4: compression pipeline v2, server-side context management, structural cleanup.

**Breaking**

- Removed deprecated APIs: `TokenUtils` (use `estimate` / `estimateObject`, now exported), `XmlGenerator` (use `objectToXml`), `AdapterFactory` (use `getAdapter` / `adapterRegistry`), `JanitorConfig.onBudgetExceeded` (use `onBeforeCompress`).
- Compression now triggers at `contextWindow * triggerRatio` with a default `triggerRatio` of **0.7** ("pre-rot"), and `preserveRatio` applies to that effective budget. Set `triggerRatio: 1` for the old trigger-at-window behavior.
- Compression failures (model throw, shrink-guard rejection, `validateCompression` rejection) now leave history **unchanged** — the old behavior of truncating with a placeholder summary is gone. Failures count toward the circuit breaker but no longer set the one-turn suppression flag.
- New shrink guard: a summary that does not shrink the compressed span by `minShrinkRatio` (default 0.5, spans ≥ 2000 chars) is treated as a failed compression.
- `withGuardrails` is now deferred to `compile()` (order-independent vs `setDynamicState`), uses replace semantics, accepts `null` to clear, is persisted in snapshots, and emits its own message at the sandwich tail instead of merging into the dynamic-state message.
- Event handlers are error-isolated: a throwing `chef.on(...)` observer logs a warning and no longer fails `compile()`.
- `compile()` calls on one instance are serialized (concurrent callers queue instead of interleaving state).

**New**

- Constraint pinning: `Message.pinned` survives `compress()` verbatim and is never cleared by `compact()` (turn-scoped).
- Reversible compression: `JanitorConfig.archive` (`'vfs'` or `{ store }`) archives compressed spans and cites a `context://` URI in the summary; pair with `getRecallToolDefinition()` + `chef.resolveRecall(uri)`.
- Server-side context management: `ChefConfig.contextManagement` (`strategy: 'client' | 'server'`); on the Anthropic target the payload carries `context_management` + `betas`, and API-returned compaction blocks round-trip verbatim through `fromAnthropic` (pinned).
- New target `'openai-responses'`: `OpenAIResponsesAdapter` + `fromOpenAIResponses` with reasoning-item (`encrypted_content`) preservation and `call_id` tool pairing.
- Gemini thought signatures round-trip (`ToolCall.thoughtSignature`, text-part signatures) and are immune to `compact(['thinking'])`.
- `compressionGuidelines`, `compressionMode: 'incremental-anchored'` (persistent anchor document), `compressionScheduling: 'background'` (staleness-checked swap-in), `validateCompression` gate.
- `compact()` targets: `'reasoning-tags'` (strips `<think>` blocks), `toolFilter` / `exemptTools` on tool-result clearing.
- `ChefConfig.transformToolResult`: uniform tool-result rewrite before compression.
- `preserveThinkingAsText` option on `OpenAIAdapter` / `GeminiAdapter` (thinking → `<thinking>` text; `redacted_thinking` never textified).
- `ToolDefinition.deferLoading` annotation (Anthropic Tool Search).
- New events: `compress:start`, `compress:end`, `offload:created`, `pruner:tool-blocked`.
- Memory compiles with a single store scan per `compile()` (`Memory.compileArtifacts()`); the selector runs exactly once.

See MIGRATION-4.md for the full migration guide.
