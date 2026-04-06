---
"@context-chef/core": patch
---

Janitor compression pipeline improvements and internal type cleanup.

**New `Prompts.formatCompactSummary(raw)` utility** — strips `<analysis>` scratchpad blocks and extracts content from `<summary>` tags, falling back to cleaned raw text when no tags are present. `executeCompression()` now pipes `compressionModel` output through this cleaner before wrapping with `getCompactSummaryWrapper`, preventing XML scaffolding from leaking into the next context window. Before this change, the default prompt asked the model to wrap its output in `<summary></summary>` but nothing stripped the tags — they silently leaked into the continuation context.

**Upgraded `CONTEXT_COMPACTION_INSTRUCTION`** — now uses a two-phase `<analysis>` + `<summary>` + `<example>` pattern (inspired by Claude Code's compact prompt) for measurably better summary quality. The 5 output sections remain domain-agnostic (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve) so the prompt works for support, research, shopping, coding, or any other conversational agent — no coding-specific language introduced.

**New `JanitorConfig.customCompressionInstructions?: string`** — additional focused instructions appended to the default prompt as an "Additional Instructions:" section. Additive (not replacement) so the default scaffolding that enforces the `<analysis>`/`<summary>` parsing contract is always preserved. Users who need radically different compression behavior can still provide their own `compressionModel` entirely.

```typescript
new ContextChef({
  janitor: {
    compressionModel,
    customCompressionInstructions:
      'Focus on customer sentiment, unresolved issues, and preserve ticket IDs verbatim.',
  },
});
```

**Compression circuit breaker** — after three consecutive `compressionModel` failures, subsequent `compress()` calls return history unchanged instead of retrying. This prevents sessions from hammering a broken compression endpoint on every turn (e.g. expired API key, rate limit lockout). The counter resets on successful compression, explicit `janitor.reset()`, or `chef.clearHistory()`. The `consecutiveFailures` field is part of `JanitorSnapshot` and preserved by `chef.snapshot()` / `chef.restore()`. `restoreState()` uses `?? 0` for defensive backward compatibility with snapshots serialized by older versions.

**Removed `Prompts.DEEP_CONVERSATION_SUMMARIZATION`** — this export was unreferenced internal dead code with an inconsistent `<history_summary>` contract that diverged from the default prompt's `<summary>` contract. External code that imported it (unlikely, as it was never documented) should migrate to `CONTEXT_COMPACTION_INSTRUCTION`, which now covers the same detailed-summary use case via the upgraded scaffolding.

**Internal type cleanup** — replaced scattered `as` type assertions with generics, type guards, and typed helpers across core source and test files. From 40+ cast sites, only two unavoidable assertions remain, both documented:

- `Assembler.orderKeysDeterministically<T>` — single boundary assertion to express the "same shape, reordered keys" transformation which TypeScript cannot model at the type level. Function is now generic, so call sites no longer need their own casts.
- `TypedEventEmitter.emit` — necessary widening to call stored `EventHandler<never>` with a concrete payload. Storage now uses contravariance (`Set<EventHandler<never>>`), so `on()` and `off()` no longer need casts; only the call site in `emit()` retains one, guarded by a runtime invariant established in `on()`.

Additional source cleanups: `Pruner` uses a new `isRecord()` type guard; `VFSMemoryStore` uses typed variable coercion instead of `JSON.parse(...) as T`; adapter implementations (`anthropicAdapter`, `openAIAdapter`, `geminiAdapter`) declare SDK types explicitly instead of trailing `as SDKType` on object literals.
