# Events & Hooks

ContextChef exposes a unified, observation-only event system for logging, metrics, and debugging across all internal modules — plus intercept hooks (`onBeforeCompile`, `onBeforeCompress`, `transformContext`) for when you need to change what gets compiled.

## Lifecycle events

Subscribe via `chef.on()`, unsubscribe via `chef.off()`.

```typescript
// Log when history gets compressed
chef.on('compress', ({ summary, truncatedCount }) => {
  console.log(`Compressed ${truncatedCount} messages`);
});

// Track compile metrics
chef.on('compile:done', ({ payload }) => {
  metrics.track('compile', { messageCount: payload.messages.length });
});

// Monitor memory changes
chef.on('memory:changed', ({ type, key, value }) => {
  console.log(`Memory ${type}: ${key}`);
});
```

### Available events

| Event | Payload | Description |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | Emitted at the start of `compile()` |
| `compile:done` | `{ payload }` | Emitted after `compile()` produces the final payload |
| `compress:start` | `{ historyLength, currentTokens, limit }` | Budget exceeded — compression is about to run (before summarization) |
| `compress:end` | `{ compressed }` | Compression phase finished. `compressed: false` = budget was fine or the result was rejected |
| `compress` | `{ summary, truncatedCount, details }` | Emitted after Janitor compresses history |
| `offload:created` | `{ uri }` | Content was offloaded to the VFS (via `chef.offload` / `offloadAsync` or the compression archive) |
| `pruner:tool-blocked` | `{ name }` | `checkToolCall()` rejected a tool call against the Pruner blocklist |
| `memory:changed` | `{ type, key, value, oldValue }` | Emitted after any memory mutation (set, delete, expire) |
| `memory:expired` | `MemoryEntry` | Emitted when a memory entry expires during `compile()` |

Events are **observation-only** — they don't affect control flow. Intercept hooks (`onBeforeCompress`, `onMemoryUpdate`, `onBeforeCompile`, `transformContext`) remain as config callbacks.

**Handler error isolation** <Badge type="tip" text="v4" />**.** A throwing or rejecting event handler is logged and the remaining handlers still run — pre-4.0, a throwing handler failed the whole `compile()`.

Events coexist with existing config callbacks: if you provide `onCompress` in `JanitorConfig`, it fires first, then the `compress` event is emitted.

## Cancellation — `compile({ signal })`

Pass an `AbortSignal` to `compile()` to cancel an in-flight compile and propagate the signal to all event handlers fired during that call.

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // hard 5s budget

chef.on('compile:done', async ({ payload }, signal) => {
  // signal === controller.signal — forward it to slow async work
  await db.write(payload, { signal });
  await metrics.report(payload, { signal });
});

try {
  await chef.compile({ target: 'openai', signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    // compile was cancelled mid-flight (Janitor / onBeforeCompile / transformContext boundary)
  }
  throw err;
}
```

Two effects:

1. **Forwarded to handlers** — `chef.on(event, (payload, signal?) => ...)` receives the signal as the second argument. Handler can pass it to `fetch`, DB clients, or any cooperative API.
2. **Checked at compile() boundaries** — after Janitor compress, after `onBeforeCompile`, after `transformContext`. Aborts throw via `signal.throwIfAborted()`.

`compile:start` fires before the first abort check, so observers may receive a `compile:start` for a compile that ultimately throws without firing `compile:done`. Memory events fired from external `memory().set()` / `delete()` calls (outside `compile()`) get `signal: undefined`.

## Concurrency model

**Canonical pattern: one `ContextChef` instance per concurrent caller.** A chef holds mutable state across `await` points (in-flight signal, memory turn counter, active skill, history reference). Per-request instantiation gives each call its own state — no shared mutable state means no race.

```typescript
// Express / Fastify / Hono — one chef per request
app.post('/agent', async (req, res) => {
  const chef = new ContextChef({ memory: { store: sharedMemoryStore } });
  chef.setHistory(req.body.history);
  const payload = await chef.compile({ target: 'openai' });
  res.json(payload);
});
```

If memory needs to span requests, lift the store out (`VFSMemoryStore`, your own Redis-backed store) and pass it to per-request chefs — store-level concurrency is the store's responsibility, not the chef's.

**Concurrent `compile()` calls on one instance queue (v4).** They are serialized (snapshot + serialize) instead of interleaving and corrupting shared state (turn counter, circuit breaker, signal stash). Inputs are snapshotted at call time — `setHistory()` between two queued calls means the first compile sees the old history, the second sees the new. A rejected compile does not poison the queue. The canonical pattern is still one chef per concurrent caller; the queue exists to make accidental sharing safe, not fast.

## `onBeforeCompile` hook

Inject external context (RAG, AST snippets, MCP queries) right before compilation without modifying the message array.

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.dynamicStateXml);
    return snippets.map((s) => s.content).join("\n");
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```
