---
"@context-chef/ai-sdk-middleware": patch
---

Pass-through upgrade for the compression pipeline improvements in `@context-chef/core`. No middleware-specific API changes; users of `compress: { ... }` in `createContextChefMiddleware` automatically benefit from:

- **Clean compression output** — `<analysis>` scratchpads and `<summary>` tag wrappers are now stripped from the compression model's raw output by `Prompts.formatCompactSummary` before injection into the next context window. Previously these XML tags leaked through silently.
- **Higher-quality default prompt** — the upgraded `CONTEXT_COMPACTION_INSTRUCTION` uses a two-phase `<analysis>` + `<summary>` + `<example>` pattern for measurably better summaries, while remaining domain-agnostic (support, research, shopping, coding, etc.).
- **Circuit breaker protection** — if the configured compression model fails three times in a row, the underlying Janitor stops calling it until the next successful compression or an explicit reset, preventing wasted API calls in sessions where the compression endpoint is broken.
- **`customCompressionInstructions`** — available via the underlying `JanitorConfig`; pass domain-specific focus instructions without breaking the parser contract.
