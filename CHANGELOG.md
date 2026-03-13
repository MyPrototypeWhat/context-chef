# context-chef

## 2.0.1

### Patch Changes

- Enhance Offloader with head+tail character-based truncation

  - Replace line-based `tailLines` with character-based `headChars` / `tailChars` options, with line-boundary snapping for clean output
  - New truncation format: show preserved head/tail content with `--- output truncated (N lines, N chars) ---` metadata and retrieval URI
  - Remove `EPHEMERAL_MESSAGE` wrapper from truncation notices in favor of actionable, transparent metadata
  - Update `offloadAsync()` to match new `offload()` API (headChars/tailChars params, head+tail coverage short-circuit)
  - Update `Prompts.getVFSOffloadReminder` signature to `(uri, totalLines, totalChars, headStr, tailStr)`

## 2.0.0

### Major Changes

- ### Breaking: Rename public APIs for clarity

  **WHAT**: Renamed several public methods and interface fields to be more descriptive and consistent.

  **WHY**: The original names (`topLayer`, `useRollingHistory`, `feedTokenUsage`, etc.) relied on internal metaphors that were not intuitive for new users.

  **HOW to migrate**:

  | Before                                     | After                        |
  | ------------------------------------------ | ---------------------------- |
  | `chef.setTopLayer(msgs)`                   | `chef.setSystemPrompt(msgs)` |
  | `chef.useRollingHistory(msgs)`             | `chef.setHistory(msgs)`      |
  | `chef.tools()`                             | `chef.getPruner()`           |
  | `chef.memory()`                            | `chef.getMemory()`           |
  | `chef.feedTokenUsage(n)`                   | `chef.reportTokenUsage(n)`   |
  | `chef.clearRollingHistory()`               | `chef.clearHistory()`        |
  | `snapshot.topLayer`                        | `snapshot.systemPrompt`      |
  | `snapshot.rawDynamicXml`                   | `snapshot.dynamicStateXml`   |
  | `ctx.topLayer` (BeforeCompileContext)      | `ctx.systemPrompt`           |
  | `ctx.rawDynamicXml` (BeforeCompileContext) | `ctx.dynamicStateXml`        |
  | `guardrail.applyGuardrails(...)`           | `guardrail.apply(...)`       |
