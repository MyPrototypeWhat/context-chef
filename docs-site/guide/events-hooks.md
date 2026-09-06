# Events & Hooks

Two surfaces, two jobs. **Events** observe: they fire for logging, metrics and debugging and cannot change what gets compiled. **Slots** participate: a slot handler runs inside the compile pipeline and can veto overflow, inject context, or rewrite the assembled messages.

The 4.1 config hooks (`onBeforeCompile`, `transformContext`, `onBeforeCompress`) are slots now — same code path, registered at construction, and deprecated in favour of the slot names.

## Slots <Badge type="tip" text="4.2" />

Six composition points, one at each interesting phase boundary of the [compile pipeline](/guide/architecture#the-compile-pipeline). Register with `chef.use(slot, handler)`, remove with `chef.unuse(slot, handler)`.

| Slot | Fires | Signature | Contract |
|---|---|---|---|
| `before-overflow` | before the overflow phase | `({ history, budget }) => void \| false` | return `false` to skip overflow for this compile |
| `after-overflow` | after the overflow phase | `({ history, result }) => void` | `result` is `null` when the phase was skipped |
| `before-assemble` | before the sandwich is assembled | `(ctx) => void` | `ctx.inject(text)` adds a block to `<implicit_context>` |
| `after-assemble` | on the assembled sandwich | `(messages) => Message[]` | handlers chain — each receives the previous result |
| `before-adapt` | right before the target adapter | `(messages) => void` | observation only; `messages` is readonly |
| `after-adapt` | on the compiled payload | `(payload) => void` | observation only, before `compile:done` |

```typescript
// Veto: don't rewrite history while a response is streaming.
chef.use('before-overflow', ({ history, budget }) => {
  logger.info(`over budget by ${-budget.remaining} tokens, ${history.length} messages in window`);
  if (streamingInProgress) return false;
});

// Inject: RAG results, AST snippets, MCP queries — without touching your message array.
chef.use('before-assemble', async (ctx) => {
  ctx.inject(await retrieveSnippets(ctx.dynamicStateXml));
});

// Transform: broad rewrites of the assembled message list.
chef.use('after-assemble', (messages) =>
  messages.filter((m) => m.content !== '' || m.tool_calls !== undefined),
);

// Observe the payload.
chef.use('after-adapt', (payload) => metrics.record('compile', payload));
```

**Order.** Registration order is execution order, and handlers are awaited one after another. `use()` may register the same function more than once — every registration runs, and `unuse()` removes one at a time:

```typescript
const skipWhileStreaming = () => false as const;
chef.use('before-overflow', skipWhileStreaming);
chef.unuse('before-overflow', skipWhileStreaming); // → this
```

The list is snapshotted before a slot runs, so a handler that registers or unregisters another mid-run does not disturb the iteration it is part of.

**Errors are NOT isolated.** Unlike event handlers, a throwing slot handler fails the whole `compile()` — exactly like the legacy config hooks these slots generalize. Wrap your logic in try/catch if a failure should be survivable.

**Multiple `inject()` calls accumulate** in registration order, separated by a blank line; empty strings are ignored. `ctx` also carries `systemPrompt`, `history`, `dynamicState` and `dynamicStateXml`.

### Legacy config hooks

Still supported, still exact, removed in 5.0. Each is registered on the same slot registry at construction, **ahead of** any later `use()` call — so they always run first.

| Deprecated config field | Register instead |
|---|---|
| `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', async (ctx) => ctx.inject(await retrieve(ctx)))` — the returned string is the injection |
| `ChefConfig.transformContext` | `chef.use('after-assemble', fn)` |
| `JanitorConfig.onBeforeCompress` | `chef.use('before-overflow', fn)` — the slot sees the runner's real budget |
| `ChefConfig.transformToolResult` | stays as config: it is a per-message transform in the `transform-tool-results` phase, not a slot |

Alias-equivalence is asserted by tests: the same input produces a byte-identical payload through the old field and the new slot, on all three targets.

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
| `compress:start` | `{ historyLength, currentTokens, limit }` | Budget exceeded — the overflow strategy is about to run |
| `compress:end` | `{ compressed }` | Overflow phase finished. `compressed: false` = budget was fine or the result was rejected |
| `compress` | `{ summary, truncatedCount, details }` | Emitted after an overflow lands in the window |
| `offload:created` | `{ uri }` | Content was offloaded to the VFS (via `chef.offload` / `offloadAsync` or the overflow archive) |
| `pruner:tool-blocked` | `{ name }` | `checkToolCall()` rejected a tool call against the Pruner blocklist |
| `pipeline:invariant` <Badge type="tip" text="4.2" /> | `{ phase, message }` | A `pipelineChecks` invariant was violated. Reported only — `compile()` continues |
| `memory:changed` | `{ type, key, value, oldValue }` | Emitted after any memory mutation (set, delete, expire) |
| `memory:expired` | `MemoryEntry` | Emitted when a memory entry expires during `compile()` |

Events are **observation-only** — they don't affect control flow. Use a slot when you need to change something.

**Handler error isolation** <Badge type="tip" text="v4" />**.** A throwing or rejecting event handler is logged and the remaining handlers still run — pre-4.0, a throwing handler failed the whole `compile()`.

Events coexist with existing config callbacks: if you provide `onCompress` in `JanitorConfig`, it fires first, then the `compress` event is emitted.

## Pipeline invariants — `pipelineChecks` <Badge type="tip" text="4.2" />

Three things can go silently wrong when code participates in the compile: a slot handler drops a pinned message, splits a tool call from its result, or rewrites content ahead of the tail insertion point. None of them fails anything — you find out later, from a model that stopped obeying a policy it can no longer see.

```typescript
const chef = new ContextChef({ pipelineChecks: process.env.NODE_ENV !== 'production' });

chef.on('pipeline:invariant', ({ phase, message }) => {
  console.warn(`[pipeline] ${phase}: ${message}`);
});
```

- After every `after-assemble` handler: pinned messages still present, tool call/result pairs still paired.
- After the `tail` phase: nothing ahead of the tail insertion point changed, compared byte for byte against a pre-`tail` snapshot.

Violations are **reported, never enforced** — mechanism, not policy. Each goes to `ChefConfig.logger` (or `console`) and to the `pipeline:invariant` event; `compile()` never throws because of a check. It costs a snapshot plus a serialization pass per compile, so keep it off in production. Default `false`.

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
    // compile was cancelled mid-flight at a phase boundary
  }
  throw err;
}
```

Two effects:

1. **Forwarded to handlers** — `chef.on(event, (payload, signal?) => ...)` receives the signal as the second argument. Handler can pass it to `fetch`, DB clients, or any cooperative API.
2. **Checked at phase boundaries** — after `overflow`, `inject`, `memory`, `assemble` and `adapt`. Every one of them follows an await that can take arbitrarily long (compression model, memory store, your own handlers). Aborts throw via `signal.throwIfAborted()`.

`compile:start` fires before the first abort check, so observers may receive a `compile:start` for a compile that ultimately throws without firing `compile:done`. Memory events fired from external `memory().set()` / `delete()` calls (outside `compile()`) get `signal: undefined`.

## Concurrency model

**Canonical pattern: one `ContextChef` instance per concurrent caller.** A chef holds mutable state across `await` points (in-flight signal, memory turn counter, active skill, history reference, window lineage). Per-request instantiation gives each call its own state — no shared mutable state means no race.

```typescript
// Express / Fastify / Hono — one chef per request
app.post('/agent', async (req, res) => {
  const chef = new ContextChef({ store: sharedBackend, memory: {} });
  chef.setHistory(req.body.history);
  const payload = await chef.compile({ target: 'openai' });
  res.json(payload);
});
```

If memory needs to span requests, lift the store out (a shared `FileSystemBackend`, your own Redis-backed `StorageBackend`) and pass it to per-request chefs — store-level concurrency is the store's responsibility, not the chef's. See [Context store](/guide/context-store).

**Concurrent `compile()` calls on one instance queue (v4).** They are serialized (snapshot + serialize) instead of interleaving and corrupting shared state (turn counter, circuit breaker, signal stash). Inputs are snapshotted at call time — `setHistory()` between two queued calls means the first compile sees the old history, the second sees the new. A rejected compile does not poison the queue. The canonical pattern is still one chef per concurrent caller; the queue exists to make accidental sharing safe, not fast.
