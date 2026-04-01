# context-chef

## 2.2.0

### Minor Changes

- [`6182d09`](https://github.com/MyPrototypeWhat/context-chef/commit/6182d09a953cf484401ead48d69b485af4200e1f) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### Tool pair protection in Janitor

  Added `adjustSplitIndex()` to prevent `compress()` from splitting `tool_calls`/`tool` message pairs. When the split point would orphan a tool result, the matching assistant message is pulled into the kept range. Also ensures the kept range starts with an assistant message (when possible) for valid user/assistant alternation.

  ### Summary role changed to `user`

  Compression summary messages now use `role: 'user'` instead of `role: 'system'`. This ensures valid message alternation (`[user_summary, assistant, ...]`) across all LLM providers (Anthropic and Gemini require the first non-system message to be user).

  ### New `ensureValidHistory()` utility

  Standalone safety net that sanitizes any message history to satisfy LLM API invariants:

  - Removes orphan tool results (no matching assistant `tool_calls`)
  - Injects synthetic tool results for missing `tool_call_id`s
  - Ensures the first non-system message is `role: 'user'`

  ### `@context-chef/ai-sdk-middleware`

  Bump to pick up `@context-chef/core` minor update.

## 2.1.3

### Patch Changes

- [`03687d3`](https://github.com/MyPrototypeWhat/context-chef/commit/03687d3821808a6560ac61d4fd782782ba9af20f) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - - Remove `skills` directory from npm package to reduce bundle size. Skills are now maintained at the repository root.

## 2.1.0

### Minor Changes

- [`3e948d7`](https://github.com/MyPrototypeWhat/context-chef/commit/3e948d7e9dc124b542029600d5fa974a687dc9c8) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add `compact()` API for mechanical history compaction on `Janitor`.

  - New `janitor.compact(history, { clear: [...] })` method for zero-LLM-cost content stripping
  - Supported clear targets: `'tool-result'` (replaces tool message content) and `'thinking'` (strips thinking/redacted_thinking blocks)
  - Pure function — no side effects, no state mutation, extensible via `ClearTarget` union type
  - Composable with `onBudgetExceeded` hook as a first-pass compaction before LLM-based compression
  - New exports: `CompactOptions`, `ClearTarget`

## 2.0.3

### Patch Changes

- [`2b86f2b`](https://github.com/MyPrototypeWhat/context-chef/commit/2b86f2bd00cc82f4f005730ca61417b99040ea10) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Fix `objectToXml` losing array field names and breaking indentation

  When an object contained an array field (e.g. `{ tasks: [{...}, {...}] }`), the key name was discarded and items were output as bare `<item>` tags without a wrapper. Now arrays are wrapped in their field name tag with properly indented items:

  ```xml
  <!-- Before: key "tasks" lost, indentation broken -->
  <item><name>Task 1</name></item>
  <item><name>Task 2</name></item>

  <!-- After: key preserved as wrapper tag -->
  <tasks>
    <item><name>Task 1</name></item>
    <item><name>Task 2</name></item>
  </tasks>
  ```

## 2.0.2

### Patch Changes

- [`577a65b`](https://github.com/MyPrototypeWhat/context-chef/commit/577a65b4f4575e59e1e3cfd81b2b2a847019c292) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Fix snapshot/restore reference leaks by replacing shallow copies with `structuredClone`

  - **ContextChef**: `snapshot()` / `restore()` now deep-clone messages, isolating nested fields (`tool_calls`, `thinking`, `redacted_thinking`, custom fields)
  - **InMemoryStore**: `snapshot()` / `restore()` now deep-clone `MemoryStoreEntry` references
  - **Pruner**: `snapshotState()` / `restoreState()` now deep-clone tool `parameters` and `tags`
  - **VFSMemoryStore**: Added `snapshot()` / `restore()` support (previously returned `null`, breaking memory state rollback)

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
