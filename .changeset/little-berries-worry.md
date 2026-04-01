---
"@context-chef/core": major
---

### BREAKING: Summary role changed to `user`

Compression summary messages now use `role: 'user'` instead of `role: 'system'`. This ensures valid message alternation (`[user_summary, assistant, ...]`) across all LLM providers. Summary content is wrapped with a continuation prompt to guide the model to resume naturally.

If your code asserts `summary.role === 'system'`, update it to `summary.role === 'user'`.

### BREAKING: `onBudgetExceeded` renamed to `onBeforeCompress`

`onBudgetExceeded` is deprecated in favor of `onBeforeCompress`. Both names work during the transition — the old name will be removed in the next major version.

### Tool pair protection in Janitor

Added `adjustSplitIndex()` to prevent `compress()` from splitting `tool_calls`/`tool` message pairs. When the split point would orphan a tool result, the matching assistant message is pulled into the kept range. Also ensures the kept range starts with an assistant message for valid alternation.

### New `ensureValidHistory()` utility

Standalone safety net that sanitizes any message history to satisfy LLM API invariants:

- Removes orphan tool results (no matching assistant `tool_calls`)
- Injects synthetic tool results for missing `tool_call_id`s
- Ensures the first non-system message is `role: 'user'`

### Enhanced `compact()` with `keepRecent`

`ClearTarget` now supports an object form for `tool-result`:

```typescript
janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});
```

Preserves the N most recent tool results while clearing older ones. Floored to 1 — never clears all. The string form `'tool-result'` continues to clear all (backward compatible).
