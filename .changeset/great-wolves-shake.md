---
"@context-chef/ai-sdk-middleware": minor
---

Session isolation, lossless-er tool output flattening, and tighter peer ranges.

- **Session isolation**: compression state (fed token usage, compression suppression, the failure circuit breaker) is now tracked per session instead of per middleware instance. Pass `providerOptions: { contextChef: { sessionId } }` on each call; calls without a `sessionId` share one default session (prior behavior). New `maxSessions` option caps concurrently tracked sessions (default 256, LRU-evicted). Previously a middleware created at module scope leaked Janitor state across every conversation it served.
- `stringifyToolOutput` no longer silently drops non-text content parts: file/media parts flatten to a `[tool result file: <mediaType>]` placeholder so compression and truncation see that they exist. The truncator's duplicate text extraction now delegates to the same implementation.
- Tighten peerDependency ranges from `>=4` / `>=7` to `^4.0.0` / `^7.0.0`. The middleware depends on `LanguageModelV4*` type shapes from `@ai-sdk/provider` v4 — an unbounded range would let a future major install silently and fail at runtime.
- Compression flattening now reuses `flattenForCompression` from `@context-chef/core` (behavior unchanged).
- An invalid `sessionId` (empty string, non-string, or a malformed `contextChef` namespace) now warns once and routes to the default session instead of failing silently. The Janitor missing-compression-config nag fires once per middleware instead of once per session.
