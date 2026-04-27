# @context-chef/ai-sdk-middleware

## 1.1.4

### Patch Changes

- Updated dependencies [[`05d713c`](https://github.com/MyPrototypeWhat/context-chef/commit/05d713cf885277835013c407dc3326839933b360)]:
  - @context-chef/core@3.2.1

## 1.1.3

### Patch Changes

- [`2e13c66`](https://github.com/MyPrototypeWhat/context-chef/commit/2e13c662be94e288371291d6fb8f54e11eacd3c1) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - `fromAISDK()` now maps AI SDK `FilePart` (type `'file'`) on user and assistant messages to IR `attachments`, so multimodal turns participate in the new core compression placeholder logic (`[image]` / `[document]` markers in the compression payload).

  `Attachment.data` in the middleware path is a presence/metadata signal only — Janitor reads `m.attachments?.length` for placeholder injection but never the binary itself. The actual `Uint8Array` / `URL` / string payload round-trips losslessly through `_userContent` / `_assistantContent`, which `toAISDK()` hands back to the underlying AI SDK provider verbatim. No re-encoding, no data loss.

- Updated dependencies [[`2e13c66`](https://github.com/MyPrototypeWhat/context-chef/commit/2e13c662be94e288371291d6fb8f54e11eacd3c1)]:
  - @context-chef/core@3.2.0

## 1.1.2

### Patch Changes

- [`246175c`](https://github.com/MyPrototypeWhat/context-chef/commit/246175c31f713af6d7a50c303391f8409595871a) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Change license from ISC to MIT

- Updated dependencies [[`246175c`](https://github.com/MyPrototypeWhat/context-chef/commit/246175c31f713af6d7a50c303391f8409595871a)]:
  - @context-chef/core@3.1.1

## 1.1.1

### Patch Changes

- Updated dependencies [[`d6169e4`](https://github.com/MyPrototypeWhat/context-chef/commit/d6169e408d89fa6caee2153a48f8ad5d38cba958)]:
  - @context-chef/core@3.1.0

## 1.1.0

### Minor Changes

- [`dceea52`](https://github.com/MyPrototypeWhat/context-chef/commit/dceea52d86bed9de058f621a4a0d680c27c04e1b) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Replace compact implementation with AI SDK's `pruneMessages`

  **Breaking change to `CompactConfig`:**

  Before:

  ```typescript
  compact: {
    clear: ["thinking", { target: "tool-result", keepRecent: 5 }];
  }
  ```

  After:

  ```typescript
  compact: { reasoning: 'all', toolCalls: 'before-last-message' }
  ```

  - `CompactConfig.clear` replaced with `reasoning`, `toolCalls`, and `emptyMessages` fields, matching `pruneMessages` parameters
  - Compact now runs before IR conversion (on raw AI SDK messages) instead of after
  - Removed `TOOL_RESULT_CLEARED_INSTRUCTION` system prompt injection — `pruneMessages` removes chunks entirely rather than replacing with placeholders
  - Per-tool pruning support via `toolCalls` array form: `[{ type: 'before-last-message', tools: ['search'] }]`

## 1.0.7

### Patch Changes

- [`25b2b98`](https://github.com/MyPrototypeWhat/context-chef/commit/25b2b98308b195519b6066120acc67aaba3a8536) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Pass-through upgrade for the compression pipeline improvements in `@context-chef/core`. No middleware-specific API changes; users of `compress: { ... }` in `createContextChefMiddleware` automatically benefit from:

  - **Clean compression output** — `<analysis>` scratchpads and `<summary>` tag wrappers are now stripped from the compression model's raw output by `Prompts.formatCompactSummary` before injection into the next context window. Previously these XML tags leaked through silently.
  - **Higher-quality default prompt** — the upgraded `CONTEXT_COMPACTION_INSTRUCTION` uses a two-phase `<analysis>` + `<summary>` + `<example>` pattern for measurably better summaries, while remaining domain-agnostic (support, research, shopping, coding, etc.).
  - **Circuit breaker protection** — if the configured compression model fails three times in a row, the underlying Janitor stops calling it until the next successful compression or an explicit reset, preventing wasted API calls in sessions where the compression endpoint is broken.
  - **`customCompressionInstructions`** — available via the underlying `JanitorConfig`; pass domain-specific focus instructions without breaking the parser contract.

- Updated dependencies [[`25b2b98`](https://github.com/MyPrototypeWhat/context-chef/commit/25b2b98308b195519b6066120acc67aaba3a8536)]:
  - @context-chef/core@3.0.3

## 1.0.6

### Patch Changes

- [`771743c`](https://github.com/MyPrototypeWhat/context-chef/commit/771743c5c86eb5f67679634a8b609998d651d955) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add banner image and Chinese README

  - Add Quick Start code screenshot as banner below package description
  - Add ToolLoopAgent to compatibility list in Quick Start and How It Works
  - Create README.zh-CN.md with full Chinese translation
  - Add language navigation links between English and Chinese READMEs

## 1.0.5

### Patch Changes

- [`dd44437`](https://github.com/MyPrototypeWhat/context-chef/commit/dd4443746489a409826790271c282ac3b3439e59) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add compact + compress interaction guidance to README and JSDoc

  - Document that `compact` should only clear `thinking` when combined with `compress`
  - Add Compact section to README with usage examples and interaction notes
  - Add `compact` option to API reference table

- Updated dependencies [[`dd44437`](https://github.com/MyPrototypeWhat/context-chef/commit/dd4443746489a409826790271c282ac3b3439e59)]:
  - @context-chef/core@3.0.2

## 1.0.4

### Patch Changes

- [`bfa527b`](https://github.com/MyPrototypeWhat/context-chef/commit/bfa527bdf39e8f05bc20eff42bd74b5d8c416b25) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Separate system messages from conversation before compact/compress pipeline

  - System messages are now filtered out before compact/compress, preventing them from being compressed or cleared
  - Auto-inject `TOOL_RESULT_CLEARED_INSTRUCTION` into system prompt when tool-result compaction is active
  - Add `Prompts.TOOL_RESULT_CLEARED_INSTRUCTION` to core — explains cleared tool results so the model doesn't interpret placeholders as errors
  - Export `ToolResultClearTarget` type and refactor `ClearTarget` union for object-form tool-result clearing with `keepRecent`

- Updated dependencies [[`bfa527b`](https://github.com/MyPrototypeWhat/context-chef/commit/bfa527bdf39e8f05bc20eff42bd74b5d8c416b25)]:
  - @context-chef/core@3.0.1

## 1.0.3

### Patch Changes

- [`c96a04c`](https://github.com/MyPrototypeWhat/context-chef/commit/c96a04c4d5d55f2e50197137b8ba40d335259cf7) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Bump to pick up `@context-chef/core` v3 changes. Added `onBeforeCompress` alongside deprecated `onBudgetExceeded`.

- Updated dependencies [[`c96a04c`](https://github.com/MyPrototypeWhat/context-chef/commit/c96a04c4d5d55f2e50197137b8ba40d335259cf7)]:
  - @context-chef/core@3.0.0

## 1.0.2

### Patch Changes

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

- Updated dependencies [[`6182d09`](https://github.com/MyPrototypeWhat/context-chef/commit/6182d09a953cf484401ead48d69b485af4200e1f)]:
  - @context-chef/core@2.2.0

## 1.0.1

### Patch Changes

- [`03687d3`](https://github.com/MyPrototypeWhat/context-chef/commit/03687d3821808a6560ac61d4fd782782ba9af20f) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### New Features

  - **`compact` option**: Mechanical, zero-LLM-cost compaction before compression. Configure `compact: { clear: ['tool-result', 'thinking'] }` to strip specified content types from history before LLM-based compression triggers.
  - **`onBudgetExceeded` hook**: Called when token budget is exceeded, before automatic compression. Return modified messages to intervene, or null to let default compression handle it.
  - **`dynamicState` injection**: Inject structured state as XML into the prompt. Supports `last_user` (default, leverages Recency Bias) and `system` placement. State object is auto-converted to XML via `objectToXml`.
  - **`transformContext` hook**: Transform the AI SDK prompt after compression, before sending to the model. Enables RAG injection, Memory integration via core, and custom prompt manipulation.

- Updated dependencies [[`03687d3`](https://github.com/MyPrototypeWhat/context-chef/commit/03687d3821808a6560ac61d4fd782782ba9af20f)]:
  - @context-chef/core@2.1.3

## 1.0.0

### Major Changes

- [`def13f0`](https://github.com/MyPrototypeWhat/context-chef/commit/def13f0cebfef252f55c20dd48b293344b51b702) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### Breaking Changes

  - Upgrade to AI SDK v6 (`@ai-sdk/provider@^3`, `ai@^6`)
  - All types migrated from `LanguageModelV2*` to `LanguageModelV3*`
  - `withContextChef()` now accepts and returns `LanguageModelV3`
  - Middleware uses `specificationVersion: 'v3'`
  - Token usage format changed: `usage.inputTokens` is now `{ total, noCache, cacheRead, cacheWrite }` instead of a plain number

  ### New Features

  - **Storage adapter for truncation**: `truncate.storage` option accepts a `VFSStorageAdapter` to persist original content before truncation, with `context://vfs/` URI in truncated output. Supports filesystem, database, or any custom adapter.
  - **Compression via `generateText`**: Compression model calls now use AI SDK's `generateText()` instead of raw `model.doGenerate()`, gaining automatic error handling and provider adaptation.
  - **Tool message handling in compression**: Tool messages are properly converted to user messages before sending to the compression model, preventing silent degradation.
  - **`providerOptions` preservation**: Message-level `providerOptions` (e.g. Anthropic cache control) are preserved through the compression round-trip.
  - **Usage warning**: Logs a warning when model responses lack token usage data and no custom tokenizer is configured.
  - **Storage write fallback**: If the storage adapter fails during truncation, falls back to simple truncation with a warning instead of crashing.

  ### Improvements

  - **Type safety**: Eliminated all `as` type casts. Introduced `AISDKMessage` extended interface with per-role typed content fields (`_userContent`, `_assistantContent`, `_toolContent`).
  - **Janitor modification detection**: `toAISDK` now detects when Janitor modifies content (e.g. `compact()`) via `_originalText` comparison, correctly using modified content instead of silently reverting to the original.
  - **Typecheck coverage**: `typecheck` script now covers both `src/` and `tests/`.
