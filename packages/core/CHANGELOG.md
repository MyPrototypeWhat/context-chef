# context-chef

## 3.3.0

### Minor Changes

- [`6500178`](https://github.com/MyPrototypeWhat/context-chef/commit/6500178af18821e3cf59ba4e3688f19f88efa8cd) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - feat(offloader): add VFS lifecycle management

  Adds `cleanup()` / `cleanupAsync()` for sweeping expired or over-cap entries, and `reconcile()` / `reconcileAsync()` for adopting orphan files after process restart (modeled on `npm cache verify`).

  New `VFSConfig` fields: `maxAge` (ms since createdAt), `maxFiles`, `maxBytes` (true UTF-8 byte length via Buffer.byteLength), `onVFSEvicted` hook (errors logged and swallowed).

  `VFSStorageAdapter` gains optional `list()` / `delete()` methods — capability-checked at runtime so existing custom adapters keep working unchanged. `FileSystemAdapter` implements both.

  Eviction: maxAge sweep first, then single-pass LRU by accessedAt until both count and bytes caps are satisfied. Cleanup is never auto-triggered — call from your agent loop or wire to `compile:done`.

  Public additions: `chef.getOffloader()`, `Offloader.cleanup`/`cleanupAsync`/`reconcile`/`reconcileAsync`/`getEntries`, `VFSEntryMeta`, `VFSCleanupResult`, `VFSEvictionReason`, `VFSCleanupNotSupportedError`, `CleanupOptions`.

## 3.2.1

### Patch Changes

- [`05d713c`](https://github.com/MyPrototypeWhat/context-chef/commit/05d713cf885277835013c407dc3326839933b360) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add Pruner blocklist + Skill primitive (two independent additions, no breaking changes).

  **Pruner blocklist** — `setBlockedTools(names)` + `checkToolCall(call)` for runtime tool restriction (permission, environment, sandbox, rate-limiting). KV-cache preserved across blocklist changes; enforcement happens at dispatch time, not by mutating the compiled `tools` array.

  **Skill primitive** — SKILL.md-compatible behavior bundle. `loadSkill` / `loadSkillsDir` / `formatSkillListing` load and render skills; `chef.registerSkills` + `chef.activateSkill` activate them, injecting instructions as a dedicated `{ role: 'system' }` message between the user system prompt and the memory block.

  **Decoupled by design** — `activateSkill` does NOT touch the Pruner. `Skill.allowedTools` is annotation only (Claude Code semantics); wire it to `setBlockedTools` yourself if you want skill-driven tool gating. See `SKILL_SPEC.md` for the full design and recipes.

  New public API: `Pruner.setBlockedTools` / `Pruner.getBlockedTools` / `ContextChef.checkToolCall` / `ToolCallCheckResult` / `Skill` / `SkillLoadResult` / `FormatSkillListingOptions` / `loadSkill` / `loadSkillsDir` / `formatSkillListing` / `ContextChef.registerSkills` / `ContextChef.getRegisteredSkills` / `ContextChef.activateSkill` / `ContextChef.getActiveSkill`. New snapshot fields: `ChefSnapshot.activeSkillName` / `ChefSnapshot.skillInstructions`. New meta field: `CompileMeta.activeSkillName`.

## 3.2.0

### Minor Changes

- [`2e13c66`](https://github.com/MyPrototypeWhat/context-chef/commit/2e13c662be94e288371291d6fb8f54e11eacd3c1) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### Compression now strips media attachments to text placeholders

  `Janitor.executeCompression()` no longer ships binary attachment data through the compression call. Each attachment in the messages being compressed is replaced inline with a `[image]` / `[image: photo.png]` / `[document]` / `[document: report.pdf]` text marker before the compressionModel is invoked. The summarizer sees that media existed at this point in the conversation without being asked to process raw base64.

  - Modeled on Claude Code's `stripImagesFromMessages` strategy
  - Avoids prompt-too-long failures on the compression call itself when histories contain many images
  - Empty `mediaType` produces `[attachment]` instead of misleading `[document]`
  - `toKeep` (the recent messages preserved verbatim) is untouched — its attachments still reach the main model through the target adapter

  ### Removed `Prompts.MEDIA_DESCRIPTION_INSTRUCTION`

  The constant is gone from the exported `Prompts` object. It was previously appended to the compression prompt when attachments were detected, asking the compression model to "describe the visual content." In practice this never worked — `compressionModel` is a `(Message[]) => Promise<string>` function with no adapter pipeline, so the binary data on `Message.attachments` was never actually forwarded to the LLM. The new placeholder-based strategy supersedes it.

  If you imported `Prompts.MEDIA_DESCRIPTION_INSTRUCTION` directly, remove the reference — the behavior it described was already a no-op.

## 3.1.1

### Patch Changes

- [`246175c`](https://github.com/MyPrototypeWhat/context-chef/commit/246175c31f713af6d7a50c303391f8409595871a) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Change license from ISC to MIT

## 3.1.0

### Minor Changes

- [`d6169e4`](https://github.com/MyPrototypeWhat/context-chef/commit/d6169e408d89fa6caee2153a48f8ad5d38cba958) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### Multimodal Attachment Support

  - Added `Attachment` interface and `Message.attachments` field to IR for provider-neutral media representation
  - Janitor detects `attachments` during compression and augments the prompt with `MEDIA_DESCRIPTION_INSTRUCTION` to guide the compression model toward describing image/media content in summaries
  - Output adapters (`compile()`) now convert `attachments` to provider-specific formats:
    - OpenAI: `image_url` / `file` content parts
    - Anthropic: `image` / `document` content blocks
    - Gemini: `inlineData` / `fileData` parts

  ### Input Adapters (Provider → IR)

  - Added `fromOpenAI()`, `fromAnthropic()`, `fromGemini()` to convert provider-native messages to ContextChef IR
  - Returns `{ system, history }` — automatically separates system messages from conversation history
  - Multimodal content (images, files, documents) automatically mapped to IR `attachments`
  - New types: `HistoryMessage`, `ParsedMessages`

## 3.0.3

### Patch Changes

- [`25b2b98`](https://github.com/MyPrototypeWhat/context-chef/commit/25b2b98308b195519b6066120acc67aaba3a8536) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Janitor compression pipeline improvements and internal type cleanup.

  **New `Prompts.formatCompactSummary(raw)` utility** — strips `<analysis>` scratchpad blocks and extracts content from `<summary>` tags, falling back to cleaned raw text when no tags are present. `executeCompression()` now pipes `compressionModel` output through this cleaner before wrapping with `getCompactSummaryWrapper`, preventing XML scaffolding from leaking into the next context window. Before this change, the default prompt asked the model to wrap its output in `<summary></summary>` but nothing stripped the tags — they silently leaked into the continuation context.

  **Upgraded `CONTEXT_COMPACTION_INSTRUCTION`** — now uses a two-phase `<analysis>` + `<summary>` + `<example>` pattern (inspired by Claude Code's compact prompt) for measurably better summary quality. The 5 output sections remain domain-agnostic (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve) so the prompt works for support, research, shopping, coding, or any other conversational agent — no coding-specific language introduced.

  **New `JanitorConfig.customCompressionInstructions?: string`** — additional focused instructions appended to the default prompt as an "Additional Instructions:" section. Additive (not replacement) so the default scaffolding that enforces the `<analysis>`/`<summary>` parsing contract is always preserved. Users who need radically different compression behavior can still provide their own `compressionModel` entirely.

  ```typescript
  new ContextChef({
    janitor: {
      compressionModel,
      customCompressionInstructions:
        "Focus on customer sentiment, unresolved issues, and preserve ticket IDs verbatim.",
    },
  });
  ```

  **Compression circuit breaker** — after three consecutive `compressionModel` failures, subsequent `compress()` calls return history unchanged instead of retrying. This prevents sessions from hammering a broken compression endpoint on every turn (e.g. expired API key, rate limit lockout). The counter resets on successful compression, explicit `janitor.reset()`, or `chef.clearHistory()`. The `consecutiveFailures` field is part of `JanitorSnapshot` and preserved by `chef.snapshot()` / `chef.restore()`. `restoreState()` uses `?? 0` for defensive backward compatibility with snapshots serialized by older versions.

  **Removed `Prompts.DEEP_CONVERSATION_SUMMARIZATION`** — this export was unreferenced internal dead code with an inconsistent `<history_summary>` contract that diverged from the default prompt's `<summary>` contract. External code that imported it (unlikely, as it was never documented) should migrate to `CONTEXT_COMPACTION_INSTRUCTION`, which now covers the same detailed-summary use case via the upgraded scaffolding.

  **Internal type cleanup** — replaced scattered `as` type assertions with generics, type guards, and typed helpers across core source and test files. From 40+ cast sites, only two unavoidable assertions remain, both documented:

  - `Assembler.orderKeysDeterministically<T>` — single boundary assertion to express the "same shape, reordered keys" transformation which TypeScript cannot model at the type level. Function is now generic, so call sites no longer need their own casts.
  - `TypedEventEmitter.emit` — necessary widening to call stored `EventHandler<never>` with a concrete payload. Storage now uses contravariance (`Set<EventHandler<never>>`), so `on()` and `off()` no longer need casts; only the call site in `emit()` retains one, guarded by a runtime invariant established in `on()`.

  Additional source cleanups: `Pruner` uses a new `isRecord()` type guard; `VFSMemoryStore` uses typed variable coercion instead of `JSON.parse(...) as T`; adapter implementations (`anthropicAdapter`, `openAIAdapter`, `geminiAdapter`) declare SDK types explicitly instead of trailing `as SDKType` on object literals.

## 3.0.2

### Patch Changes

- [`dd44437`](https://github.com/MyPrototypeWhat/context-chef/commit/dd4443746489a409826790271c282ac3b3439e59) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add compact + compress interaction guidance to JSDoc and README

  - Document that clearing `tool-result` in compact before compress causes the compression model to receive empty placeholders, producing low-quality summaries
  - Add recommended usage patterns: use `compact` for `thinking` only when combined with `compress`, use `tool-result` clearing only without `compress`
  - Update `preserveRecentMessages` description to clarify it counts turns (not individual messages)
  - Add Compact section to core README with usage examples and interaction notes

## 3.0.1

### Patch Changes

- [`bfa527b`](https://github.com/MyPrototypeWhat/context-chef/commit/bfa527bdf39e8f05bc20eff42bd74b5d8c416b25) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Replace `adjustSplitIndex` with turn-based grouping in Janitor compression

  - Add `groupIntoTurns()` utility that groups messages into atomic "turns" (assistant + tool_calls + tool results as one unit)
  - Refactor `evaluateBudget()` to split on turn boundaries instead of individual messages, structurally guaranteeing tool pair integrity
  - Remove `adjustSplitIndex()` — no longer needed since turn-based grouping handles tool pair protection by design
  - Remove system message filtering in `executeCompression()`
  - Export `groupIntoTurns` and `Turn` type from public API
  - Fix `preserveRatio` docstring (was "70%", actual default is 80%)
  - Add `Prompts.TOOL_RESULT_CLEARED_INSTRUCTION` — system-level instruction explaining cleared tool results to the model
  - Export `ToolResultClearTarget` type and refactor `ClearTarget` union for object-form tool-result clearing with `keepRecent`

  **Behavioral change:** `preserveRecentMessages` now counts turns instead of individual messages. A "turn" is a single message, or an assistant with tool_calls plus all its subsequent tool results.

## 3.0.0

### Major Changes

- [`c96a04c`](https://github.com/MyPrototypeWhat/context-chef/commit/c96a04c4d5d55f2e50197137b8ba40d335259cf7) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### BREAKING: Summary role changed to `user`

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
    clear: [{ target: "tool-result", keepRecent: 5 }],
  });
  ```

  Preserves the N most recent tool results while clearing older ones. Floored to 1 — never clears all. The string form `'tool-result'` continues to clear all (backward compatible).

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
