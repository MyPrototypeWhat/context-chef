---
"@context-chef/tanstack-ai": minor
---

Conversation isolation: compression state (fed token usage, compression suppression, the failure circuit breaker) is now tracked per `ctx.conversationId` instead of per middleware instance. Calls without a `conversationId` share one default slot (prior behavior). New `maxSessions` option caps concurrently tracked conversations (default 256, LRU-evicted). Previously a middleware instance reused across chat() calls leaked Janitor state across every conversation it served. Compression flattening now reuses `flattenForCompression` from `@context-chef/core` (behavior unchanged).

An empty-string `conversationId` now warns once and routes to the default slot (previously it was silently treated as a distinct conversation, diverging from the AI SDK middleware's semantics). The Janitor missing-compression-config nag fires once per middleware instead of once per conversation.
