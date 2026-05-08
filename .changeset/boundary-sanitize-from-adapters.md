---
'@context-chef/core': patch
'@context-chef/ai-sdk-middleware': patch
'@context-chef/tanstack-ai': patch
---

feat: boundary sanitization in input adapters; trust IR internally

All input adapters now sanitize their output via `ensureValidHistory` at the
system boundary. This fixes a class of `400` errors caused by malformed
history (orphan tool results, missing tool results, non-user first message)
that previously would leak through to the LLM and get rejected.

**Affected adapters** (all auto-sanitize on the way in):
- `fromOpenAI`, `fromAnthropic`, `fromGemini` (`@context-chef/core`)
- `fromAISDK` (middleware-internal, used by `@context-chef/ai-sdk-middleware`)
- `fromTanStackAI` (middleware-internal, used by `@context-chef/tanstack-ai`)

**Design philosophy** — validate at boundary, trust internal code. `from*()`
is the system boundary between external SDK formats and ContextChef IR;
sanitize there. `chef.setHistory(IR)` is *not* a boundary — IR is the internal
protocol, and history you build (or mutate) directly is trusted to satisfy
the invariants. If you're loading dirty IR from somewhere external (DB,
serialized state), wrap with `ensureValidHistory(messages)` explicitly.

**Behavior changes:**
- Missing-tool-result placeholder text changed from `[Tool result missing]`
  to `[No tool result available]` (more neutral — does not imply tool
  execution failed, since the cause may simply be incomplete loaded state).
- Single-message inputs to `from*()` that are not `role: 'user'` now get a
  `[Conversation continues]` placeholder user message prepended, satisfying
  provider invariants.
- Tool-result blocks without a matching preceding tool call are dropped
  rather than emitted as orphan IR messages.

If you relied on `from*()` returning IR exactly mirroring the input shape,
sanitize manually with `ensureValidHistory()` and bypass the boundary
adapters — but in practice the previous behavior would have caused provider
rejection on the next compile.

Borrowed pattern from `pi-mono`'s `transform-messages.ts:155-217`, adapted
to keep `compile()` itself a fast path (no per-call sanitize).
