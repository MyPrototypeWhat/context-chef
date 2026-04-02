---
"@context-chef/ai-sdk-middleware": patch
---

Separate system messages from conversation before compact/compress pipeline

- System messages are now filtered out before compact/compress, preventing them from being compressed or cleared
- Auto-inject `TOOL_RESULT_CLEARED_INSTRUCTION` into system prompt when tool-result compaction is active
- Add `Prompts.TOOL_RESULT_CLEARED_INSTRUCTION` to core — explains cleared tool results so the model doesn't interpret placeholders as errors
- Export `ToolResultClearTarget` type and refactor `ClearTarget` union for object-form tool-result clearing with `keepRecent`
