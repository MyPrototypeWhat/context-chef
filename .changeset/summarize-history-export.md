---
'@context-chef/core': minor
'@context-chef/ai-sdk-middleware': minor
---

Expose one-shot history summarization as a standalone API.

- **`summarizeHistory(messages, compress, opts?)`** (core): produces a compression summary for a message slice using the same prompt, attachment/tool-result stripping, and `<summary>` extraction as the in-flight `compress` path. Extracted from `Janitor.executeCompression`, which now delegates to it (behavior-identical). Pure — an empty slice returns `''` without a model call, and it throws on model failure (the Janitor keeps its own circuit breaker + fallback). The `compress` callback must role-flatten tool/assistant-tool-call messages.
- **`summarizeMessages(prompt, model, opts?)`** (ai-sdk-middleware): thin AI-SDK wrapper — `fromAISDK` (drops system messages) → compression adapter (role-flattening) → `summarizeHistory`. Returns the raw summary text (wrap with `Prompts.getCompactSummaryWrapper` for the continuation framing).

For hosts that own their conversation store and persist compression themselves (durable compaction) rather than relying on in-flight middleware compression. When driving summarization this way, do not also configure `compress` (with a `model`) on the same path — that would compress twice. A notification-only `onCompress`, plus `truncate`/`clear`/`dynamicState`, remain safe alongside.
