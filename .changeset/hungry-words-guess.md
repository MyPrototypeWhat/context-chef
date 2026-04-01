---
"@context-chef/core": minor
---

### Tool pair protection in Janitor

Added `adjustSplitIndex()` to prevent `compress()` from splitting `tool_calls`/`tool` message pairs. When the split point would orphan a tool result, the matching assistant message is pulled into the kept range. Also ensures the kept range starts with an assistant message (when possible) for valid user/assistant alternation.

### Summary role changed to `user`

Compression summary messages now use `role: 'user'` instead of `role: 'system'`. This ensures valid message alternation (`[user_summary, assistant, ...]`) across all LLM providers (Anthropic and Gemini require the first non-system message to be user).

### New `ensureValidHistory()` utility

Standalone safety net that sanitizes any message history to satisfy LLM API invariants:

- Removes orphan tool results (no matching assistant `tool_calls`)
- Injects synthetic tool results for missing `tool_call_id`s
- Ensures the first non-system message is `role: 'user'`
