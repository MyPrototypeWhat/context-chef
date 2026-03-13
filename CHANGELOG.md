# context-chef

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
