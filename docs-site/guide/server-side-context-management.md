# Server-Side Context Management <Badge type="tip" text="v4" />

Providers now run compaction server-side (Anthropic `compact_20260112`, OpenAI `/responses/compact`) — one model call fewer and exact token accounting. `ChefConfig.contextManagement` lets you delegate LLM compression to the provider; everything servers don't do stays client-side: tool pruning, skills, memory, VFS offloading, dynamic state.

::: tip This is the `server()` overflow strategy <Badge type="tip" text="4.2" />
Since 4.2, server-side context management is one of the [overflow strategies](/guide/history-compression#strategies): `overflow.strategy = server(config, { fallback })`. `contextManagement` is a deprecated alias that builds exactly that — `server(cfg, { fallback: <the default client strategy> })` — and keeps working unchanged until 5.0. Write it the new way when you want a fallback for non-Anthropic targets in the same config.
:::

```typescript
const chef = new ContextChef({
  contextManagement: { strategy: "server" }, // 'client' (default) keeps client-side LLM compression
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `server` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

## Semantics

- `strategy: 'server'` skips client-side LLM compression entirely on a target that supports it. A construction-time warning fires if a `compressionModel` is also configured — pick one.
- **On a non-Anthropic target** the strategy has nothing to delegate to. The `contextManagement` alias falls back to the default client-side strategy (v4 behavior); an explicit `server(config)` with no `fallback` leaves the history alone and reports why. See [Overflow](/guide/history-compression#strategies).
- `server` is a provider-shaped edits config passed through verbatim, e.g. `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` or `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`. `payload.betas` is auto-derived: `'compact-2026-01-12'` for compaction edits, `'context-management-2025-06-27'` for the clear-tool-uses / clear-thinking edits.
- **Compaction block round-trip**: `fromAnthropic` maps the API's `{ type: 'compaction', content }` blocks to passthrough messages marked `pinned: true`, and the Anthropic adapter re-emits the block first, verbatim, on the next compile — server-produced summaries survive the client pipeline untouched.

## A hybrid positioning, not an either/or

LLM compression can be delegated to the provider while ContextChef keeps doing the parts servers don't — pruning, skills, memory, VFS, and dynamic state.

AI SDK users get a matching guard: the middleware detects `providerOptions.anthropic.contextManagement` on a call and skips its own compression for that call (server wins), logging a one-time warning. To intentionally run both, disable the guard:

```typescript
const model = withContextChef(anthropic('claude-sonnet-4-6'), {
  contextWindow: 200_000,
  compress: { model: anthropic('claude-haiku-4-5') },
  allowDoubleCompression: true, // skip the guard: no skip, no warning
});
```

See the [ai-sdk-middleware package page](/packages/ai-sdk-middleware#anthropic-server-side-context-management) for details.
