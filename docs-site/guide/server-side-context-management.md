# Server-Side Context Management <Badge type="tip" text="v4" />

Providers now run compaction server-side (Anthropic `compact_20260112`, OpenAI `/responses/compact`) — one model call fewer and exact token accounting. `ChefConfig.contextManagement` lets you delegate LLM compression to the provider; everything servers don't do stays client-side: tool pruning, skills, memory, VFS offloading, dynamic state.

```typescript
const chef = new ContextChef({
  contextManagement: { strategy: "server" }, // 'client' (default) keeps Janitor LLM compression
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `server` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

## Semantics

- `strategy: 'server'` skips client-side LLM compression entirely. A construction-time warning fires if a `compressionModel` is also configured — pick one.
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
