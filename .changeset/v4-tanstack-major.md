---
"@context-chef/tanstack-ai": major
---

1.0: full rewrite for `@tanstack/ai` ^0.44 (the ^0.10 API this package previously targeted no longer exists upstream).

**Breaking**

- Peer dependency is now `@tanstack/ai ^0.44.0`; integration goes through the 0.44 `ChatMiddleware` contract (return-based `onConfig`, fires at init and every agent iteration — all injections are idempotent).
- `contextWindow` is now optional and required only when a compression option (`compress`, `onCompress`, `onBeforeCompress`) is configured (throws otherwise).
- Compression state is keyed by `ctx.threadId` (with deprecated `conversationId` fallback). Calls without an explicit `threadId` get per-run isolation only — pass `threadId` to `chat()` for cross-call continuity.
- `compact` window semantics now mirror AI SDK `pruneMessages` (last-N counts messages of the whole array); `emptyMessages` defaults to `'remove'`.
- `clear: ['thinking']` now actually strips reasoning (previously a warned no-op).
- `transformContext` gained a third `ctx` parameter and `systemPrompts` widened from `string[]` to `SystemPrompt[]` (source-compatible for string-based two-arg callbacks).
- The compression adapter no longer caps summarizer output tokens (0.44 removed top-level `maxTokens`).

**New**

- Durable compaction parity with ai-sdk-middleware: `planCompactionTanStackMessages`, `compactTanStackMessages`, `summarizeTanStackMessages`, `createCompressionAdapter`.
- `CompactConfig.reasoning` (`'all' | 'before-last-message' | 'none'`) and per-tool-name `toolCalls` granularity.
- Middleware hooks never throw into the host `chat()` run — internal errors degrade to pass-through with a logged warning.

See MIGRATION-4.md and the package README for the new usage.
