# @context-chef/ai-sdk-middleware

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
