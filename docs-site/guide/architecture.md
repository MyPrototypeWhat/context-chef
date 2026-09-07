# Architecture <Badge type="tip" text="4.2" />

ContextChef compiles unbounded information into a bounded window. Every feature the library has — and every feature it will grow — sits on exactly one of five axes. This page is the map: one paragraph per axis, a link to the chapter that documents it, and the compile pipeline the five axes run through.

| Axis | The question it answers | Owned by |
|---|---|---|
| **① Selection** | What goes into the window | [overflow strategies](/guide/history-compression), the [Pruner](/guide/tool-management), `memory.selector` |
| **② Placement** | Where in the window it goes | the Assembler sandwich, the tail channel, the cache-stable prefix |
| **③ Persistence** | Where it lives while it is out of the window | one [context store](/guide/context-store) |
| **④ Retrieval** | How the model reaches back outside the window | the `context` tool and `new_context` |
| **⑤ Adaptation** | What the provider's wire format wants | [adapters](/guide/adapters) |

Overflow is not a sixth axis. It is information moving from ① to ③, kept reachable through ④ — which is why `summarize` / `anchored` / `reset` are selection policies, `memory` / `notes` / `vfs` / `archive` are persistence namespaces, and `view` / `search` are retrieval handles.

## ① Selection — what goes into the window

Two independent budgets: the conversation and the tool list.

History is bounded by an **overflow strategy**. The Janitor is the runner — it reads the budget, decides when the trigger is crossed, keeps the circuit breaker, and emits `compress:*` — while the strategy decides what actually leaves: `summarize()`, `anchored()`, `server()`, `reset()`, composed with `chain()` and `background()`. Pinned messages (`pinned: true`) are the one thing a strategy may not touch. See [Overflow](/guide/history-compression).

The tool list is bounded by the [Pruner](/guide/tool-management): prune by task, allowlist, or the two-layer namespace + lazy-loading architecture that keeps the compiled tool list byte-stable across turns. Memory selection is a third, much smaller budget — `memory.selector` picks which entries get injected each compile ([Memory](/guide/memory)).

## ② Placement — where in the window it goes

The compiled payload is a sandwich: a stable, cacheable prefix (system prompt, tool schemas, skill instructions, the memory usage instruction) and a volatile tail stitched into the last user message (memory data, dynamic state, implicit context, announcements, the handoff notice).

The rule that makes prompt caching work is that nothing volatile may enter the prefix. Every library-owned tool schema is static — the `context` tool has exactly one enum, and it is a fixed list of commands, never a list of your memory keys. Everything that changes turn to turn goes through the tail channel instead. `memoryPlacement`, `dynamicStatePlacement`, `skillPlacement` and the announcement `channel` are the knobs; `cacheAudit: true` tells you when you got it wrong. See [Memory](/guide/memory#memory-placement-—-memoryplacement), [Skills](/guide/skills) and [Tool Management](/guide/tool-management#announcements-—-telling-the-model-what-changed).

## ③ Persistence — where it lives while it is out of the window

One substrate: addressed content with metadata. A `StorageBackend` moves bytes; a `Store` adds namespaces, `context://` URIs, an access index and eviction. Four namespaces are in use — `memory/` (durable facts, injected every compile), `notes/` (the model's own scratch space), `vfs/` (tool output too large to keep inline) and `archive/` (spans compacted out of the window).

Before 4.2 these were three unrelated storage interfaces. They are now one, and the old ones (`MemoryStore`, `VFSStorageAdapter`, `VFSMemoryStore`, `FileSystemAdapter`) still work as deprecated wrappers. See [Context store](/guide/context-store).

## ④ Retrieval — how the model reaches back outside the window

One model-facing tool. `context` covers all seven commands (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`, `search`) across every namespace, and `new_context` lets the model close a window it is done with. `chef.ownsTool(name)` and `chef.handleTool(call)` are the single dispatch entry point for both, plus the legacy `create_memory` / `modify_memory` / `recall_context` trio.

`ChefConfig.tools` chooses which set `compile()` emits: `'legacy'` (the default in 4.x — tool names are dispatch keys in your loop, so the default cannot flip in a minor release) or `'unified'`. The mode also picks the session's vocabulary, so the prompt never names a tool the payload does not carry. See [Context store](/guide/context-store#the-context-tool).

## ⑤ Adaptation — what the provider's wire format wants

The same compiled IR becomes an OpenAI, Anthropic, Gemini or OpenAI-Responses payload: prefill, cache breakpoints, system-message hoisting, thought signatures and tool-call shapes are all adapter concerns. Input adapters (`fromOpenAI` / `fromAnthropic` / `fromGemini`) run the reverse direction and sanitize on the way in. See [Adapters](/guide/adapters).

## The compile pipeline

`compile()` runs a fixed, ordered list of phases. Each one has a declared contract, and slots fire at the boundaries between them.

```
start → transform-tool-results → handoff → overflow → inject
      → memory → skill → assemble → tail → adapt → audit → done
```

| Phase | What it does |
|---|---|
| `start` | `compile:start` event, abort check, target resolution |
| `transform-tool-results` | `transformToolResult` over every `role: 'tool'` message — before overflow, so the summarizer sees transformed content |
| `handoff` | when the headroom falls into the handoff band, render the notice once per window |
| `overflow` | budget check, then the installed strategy; archive whatever was evicted |
| `inject` | `before-assemble` handlers → `<implicit_context>` |
| `memory` | sweep expired entries, apply the selector, derive the injection block and tool definitions from one store read |
| `skill` | the active skill's instructions, into the prefix or the tail |
| `assemble` | sandwich assembly — system layers, history, guardrails, placements |
| `tail` | tail stitch: skill, memory data, dynamic state, implicit context, announcements, anchor |
| `adapt` | target adapter, tools, server-managed payload fields |
| `audit` | `cacheAudit` on the Anthropic target, plus the optional `pipelineChecks` invariants |
| `done` | `compile:done` event |

Abort checks (`compile({ signal })`) sit after `overflow`, `inject`, `memory`, `assemble` and `adapt` — every boundary that follows an await which can take arbitrarily long.

## Slots

Slots are the composition surface. Unlike [events](/guide/events-hooks#lifecycle-events), which only observe, a slot handler participates in the compile: it can veto overflow, inject context, or rewrite the assembled messages. Handlers run in registration order and are awaited one after another.

| Slot | Signature | Contract |
|---|---|---|
| `before-overflow` | `({ history, budget }) => void \| false` | return `false` to skip overflow for this compile |
| `after-overflow` | `({ history, result }) => void` | `result` is `null` when the phase was skipped |
| `before-assemble` | `(ctx) => void` | `ctx.inject(text)` adds a block to `<implicit_context>` |
| `after-assemble` | `(messages) => Message[]` | handlers chain — each receives the previous result |
| `before-adapt` | `(messages) => void` | observation, right before the adapter runs |
| `after-adapt` | `(payload) => void` | observation, before `compile:done` |

```typescript
chef.use('before-overflow', ({ budget }) => {
  // One more turn of headroom before the summarizer gets involved.
  if (budget.remaining > -2000) return false;
});

chef.use('before-assemble', async (ctx) => {
  ctx.inject(await retrieveSnippets(ctx.dynamicStateXml));
});

chef.use('after-adapt', (payload) => {
  metrics.record('compile', payload);
});
```

`chef.unuse(slot, handler)` removes one registration; registering the same function twice needs two `unuse` calls. The legacy `onBeforeCompile` and `transformContext` config hooks register on this same registry at construction, so they always run first — see [Events & Hooks](/guide/events-hooks#slots).

## Non-negotiables

- **Mechanism, not policy.** No combination of options is rejected. `reset()` without an archive is lossy and allowed; a handoff budget larger than the trigger is allowed. Silent-failure classes — a rewritten prefix, a dropped pinned message, a split tool pair — are *reported* through the audit and event channels, never blocked. `pipelineChecks: true` turns the reporting on in development.
- **Prefix byte-stability.** Every library-owned tool schema is static and reference-stable, so `payload.tools` stays deep-equal between compiles. Volatile content only ever enters through the tail.
- **Zero forced migration in 4.x.** Every renamed option keeps a deprecated alias that maps onto the new shape. Aliases are removed in 5.0.

## Where to go next

- [Overflow](/guide/history-compression) — strategies, the handoff budget, `new_context`, window lineage
- [Context store](/guide/context-store) — one backend, four namespaces, the `context` tool
- [Events & Hooks](/guide/events-hooks) — slots, events, cancellation, concurrency
- [Tool Management](/guide/tool-management) — pruning, blocklists, announcements
- [Adapters](/guide/adapters) — input and target adapters
