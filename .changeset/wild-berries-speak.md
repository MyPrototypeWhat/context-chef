---
"@context-chef/ai-sdk-middleware": major
---

### Breaking Changes

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
