---
"context-chef": minor
---

Add `compact()` API for mechanical history compaction on `Janitor`.

- New `janitor.compact(history, { clear: [...] })` method for zero-LLM-cost content stripping
- Supported clear targets: `'tool-result'` (replaces tool message content) and `'thinking'` (strips thinking/redacted_thinking blocks)
- Pure function — no side effects, no state mutation, extensible via `ClearTarget` union type
- Composable with `onBudgetExceeded` hook as a first-pass compaction before LLM-based compression
- New exports: `CompactOptions`, `ClearTarget`
