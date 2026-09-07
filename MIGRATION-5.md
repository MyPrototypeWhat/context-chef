# Migrating to ContextChef v5

ContextChef 4.2 is the five-axis refactor: selection, placement, persistence, retrieval and adaptation each get one owner. Nothing in it forces a migration — every renamed option keeps a working alias, `tools` still defaults to `'legacy'`, and a golden suite of 10 configurations × 3 targets asserts the compiled payload is byte-identical under default configuration. 5.0 is where the aliases are removed and one default flips.

This document is the forward-looking half of that: what 4.2 deprecated and what replaces it, then what actually breaks when 5.0 lands. Everything in the first table can be adopted today, on 4.2, one item at a time. Nothing in it needs to be adopted at once.

| Package | 4.1 line | 4.2 release | 5.0 (later) |
| --- | --- | --- | --- |
| `@context-chef/core` | 4.1.0 | **4.2.0** | 5.0.0 |
| `@context-chef/ai-sdk-middleware` | 3.0.1 | **3.1.0** | — |
| `@context-chef/tanstack-ai` | 1.0.1 | **1.1.0** | — |

This guide is English-only; the zh-CN README carries a parity summary for Chinese-speaking users.

---

## Deprecated in 4.2 → what to use now

Every row below still works in 4.x and is removed in 5.0. Each deprecated symbol carries an `@deprecated` JSDoc tag pointing at the same replacement, so an editor will show it inline.

| Deprecated in 4.2 | What to use now |
| --- | --- |
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(<strategy>)` |
| `janitor.archive` | `overflow.archive` — archiving is strategy-agnostic now |
| `contextManagement.strategy: 'server'` | `overflow.strategy: server(config, { fallback })` |
| `contextManagement.server` | the first argument of `server(config)` |
| `JanitorSnapshot.anchorDoc` | `JanitorSnapshot.strategy` (opaque `strategy.snapshot()` state) |
| `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', (ctx) => ctx.inject(text))` |
| `ChefConfig.transformContext` | `chef.use('after-assemble', (messages) => messages)` |
| `MemoryStore` (and `memory.store` taking one) | `StorageBackend` or `Store` — `InMemoryBackend`, `FileSystemBackend`, your own |
| `VFSStorageAdapter` (and `vfs.adapter`) | `StorageBackend` passed as `vfs.store`, or one shared `ChefConfig.store` |
| `VFSMemoryStore` | `new FileSystemBackend(dir)` for a new directory; an existing one keeps loading only through `VFSMemoryStore` itself or `Store.fromMemoryStore(new VFSMemoryStore(dir))` |
| `FileSystemAdapter` | `FileSystemBackend`, which serves every namespace from one root |
| `Memory.getToolDefinitions()` | `tools: 'unified'` — `compile()` emits the `context` tool for you |
| `create_memory` / `modify_memory` tool calls | the `context` tool: `create` / `str_replace` / `delete` under `memory/`, dispatched with `chef.handleTool(call)` |
| `recall_context` / `getRecallToolDefinition()` | the `context` tool's `view` on a `context://vfs/…` or `context://archive/…` path |
| middleware `TruncateOptions.storage` (both integrations) | `TruncateOptions.store` — a `StorageBackend` or a `Store` |

### Overflow: one strategy object instead of four option groups

Why: `compressionMode`, `compressionScheduling`, `archive` and `contextManagement.strategy` were four ways of describing one thing — what leaves the window and where it goes. In 4.2 that is an `OverflowStrategy`, and the Janitor is the runner around it (budget, circuit breaker, events, `onCompress` / `onBeforeCompress`, durable compaction).

```ts
// 4.1
janitor: {
  contextWindow: 200_000,
  compressionModel,
  compressionMode: 'incremental-anchored',
  compressionScheduling: 'background',
  archive: 'vfs',
}

// 4.2 — same behavior, said once
import { anchored, background } from '@context-chef/core';

janitor: { contextWindow: 200_000 },
overflow: {
  strategy: background(anchored({ compressionModel })),
  archive: 'vfs',
}
```

The runner options stay on `janitor` where they were: `contextWindow`, `tokenizer`, `usagePreference`, `triggerRatio`, `logger`, `onCompress`, `onBeforeCompress`. Setting both an `overflow.strategy` and the old aliases logs one warning and the strategy wins.

Server-side context management is a strategy like any other:

```ts
// 4.1
contextManagement: { strategy: 'server', server: { edits: [{ type: 'compact_20260112' }] } }

// 4.2
import { server, summarize } from '@context-chef/core';
overflow: {
  strategy: server(
    { edits: [{ type: 'compact_20260112' }] },
    { fallback: summarize({ compressionModel }) },   // used on non-Anthropic targets
  ),
}
```

### Hooks: two config callbacks became six slots

Why: `onBeforeCompile` and `transformContext` were the only two composition points, they fired at fixed places, and only one of each could exist. Slots are the general form — `before-overflow` (return `false` to skip overflow this compile), `after-overflow`, `before-assemble`, `after-assemble`, `before-adapt`, `after-adapt` — and any number of handlers may register on each, running in registration order.

```ts
// 4.1
new ContextChef({
  onBeforeCompile: async (ctx) => (await retrieve(ctx.dynamicStateXml)).join('\n'),
  transformContext: (messages) => messages.filter(keep),
});

// 4.2 — the config fields still register on exactly these slots
chef.use('before-assemble', async (ctx) => ctx.inject((await retrieve(ctx.dynamicStateXml)).join('\n')));
chef.use('after-assemble', (messages) => messages.filter(keep));
```

`transformToolResult` is not a slot and is not deprecated: it is per-message, not per-compile.

### Persistence: one backend behind one store

Why: `MemoryStore`, `VFSStorageAdapter` and `VFSMemoryStore` were three interfaces over the same idea — addressed content with metadata — and none of them could serve another module's namespace. 4.2 collapses them into `StorageBackend` (read / write / delete / list, with optional `readAll` / `append` / `search` / `snapshot` / `restore` / `getPhysicalPath` queried as capabilities) behind a `Store` that routes namespaces and owns `context://<ns>/<path>` addressing.

```ts
// 4.1 — two stores, two on-disk layouts
new ContextChef({
  memory: { store: new VFSMemoryStore('.context-memory') },
  vfs: { storageDir: '.context_vfs' },
});

// 4.2 — one backend serves memory, vfs, archive and notes
import { FileSystemBackend } from '@context-chef/core';

new ContextChef({
  store: new FileSystemBackend('.context-store'),
  memory: {},
});
```

A legacy store passed to `memory.store` or `vfs.adapter` keeps working: `Memory` and `Offloader` wrap it with `Store.fromMemoryStore` / `Store.fromVfsAdapter`, mapping every field one for one. `VFSMemoryStore` is itself rebuilt on `FileSystemBackend` and reads the same files it always wrote.

### Retrieval: one tool, one dispatcher

Why: `create_memory`, `modify_memory` and `recall_context` were three tools over three namespaces of one store, and each host wired its own dispatch. 4.2 ships one `context` tool — `view` / `create` / `str_replace` / `insert` / `delete` / `rename` / `search` over `context://<ns>/<path>` — and one dispatcher.

```ts
// 4.1 — branch per library tool name
for (const call of response.tool_calls ?? []) {
  if (call.function.name === 'create_memory') { /* … chef.getMemory().createMemory(…) */ }
  else if (call.function.name === 'modify_memory') { /* … */ }
  else if (call.function.name === 'recall_context') { /* … chef.resolveRecall(uri) */ }
  else await runMyTool(call);
}

// 4.2 — one branch, and it already understands the legacy names too
for (const call of response.tool_calls ?? []) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: 'tool', tool_call_id: call.id, content });
    continue;
  }
  await runMyTool(call);
}
```

`ownsTool` / `handleTool` are independent of `ChefConfig.tools`: the mode decides what `compile()` **emits**, not what the dispatcher understands. That is what makes the routing above safe to adopt before flipping the mode — and what makes the 5.0 flip a no-op for hosts that have adopted it.

Opting into the new tool early:

```ts
new ContextChef({
  tools: 'unified',                       // payload carries `context`, never the legacy trio
  contextTool: { writable: ['memory', 'notes'] },   // default; narrow it to make memory read-only
  store: new FileSystemBackend('.context-store'),
});
```

`tools: 'unified'` also picks the session's vocabulary: the memory instruction and memory block, the offload truncation marker, the summary wrapper and the default handoff notice are all rewritten in `context://` addressing, so the prompt never names a tool the payload does not carry.

---

## What flips in 5.0

### 1. `ChefConfig.tools` defaults to `'unified'`

**This is the one break that reaches code that changed nothing.** Today the default is `'legacy'`, so `compile()` puts the Memory module's `create_memory` and `modify_memory` in `payload.tools` whenever memory is configured. In 5.0 the default is `'unified'` and the same compile emits a single `context` tool instead (plus `new_context` when `overflow.handoff` is set); the two sets never co-exist in one payload.

Concretely, what stops working:

- An agent loop that branches on `call.function.name === 'create_memory'` / `'modify_memory'` will never match again. The model calls `context` with `{ command: 'create', path: 'memory/<key>', file_text, description }` and `{ command: 'str_replace' | 'delete', path: 'memory/<key>', … }` instead.
- The `context` tool is emitted whether or not memory is configured — it reaches `notes/`, `vfs/` and `archive/` too. Under `'legacy'` a chef with no memory config contributes no library tools at all, so a memory-less host that never saw a library tool in `payload.tools` starts seeing one.
- Anything that asserts on the emitted tool list (payload snapshots, tool-count checks, allowlists keyed by tool name) sees `context` where it expected the trio.
- Prompt bytes change with the vocabulary: the memory instruction, the memory block header, the offload truncation marker and the summary wrapper all switch to `context://` wording. Cached prefixes are invalidated once, on the upgrade.

What does **not** break: `chef.handleTool` already dispatches both vocabularies, and `Memory`'s own methods (`createMemory` / `updateMemory` / `deleteMemory`, `allowedKeys`, `onMemoryUpdate`, TTL) are untouched — a `memory/` write through the `context` tool routes through exactly the same validation.

Do this in 4.2 and the flip is a no-op: route every library tool through `chef.ownsTool` / `chef.handleTool`, then set `tools: 'unified'` explicitly and keep it set through the upgrade.

### 2. Every alias in the table above is removed

`janitor.compressionMode` / `compressionScheduling` / `archive`, `contextManagement.strategy` / `.server`, `JanitorSnapshot.anchorDoc`, `ChefConfig.onBeforeCompile` / `transformContext`, `MemoryStore` / `VFSStorageAdapter` / `VFSMemoryStore` / `FileSystemAdapter`, `Memory.getToolDefinitions()`, `getRecallToolDefinition()` and the middleware packages' `TruncateOptions.storage` all stop existing. `InMemoryStore` implements the removed `MemoryStore` interface, so it goes with them — `InMemoryBackend` is the replacement.

Snapshots taken in 4.x still restore: `JanitorSnapshot.anchorDoc` is read into the anchored strategy's state on restore, and that adoption path stays.

### 3. Archived spans move to the `archive/` namespace

In 4.x the archive writes into the `vfs` namespace so `context://vfs/<id>` URIs stay byte-identical (a golden fixture asserts it), even though `archive` has been a real namespace since 4.2. In 5.0 the archive writes to `context://archive/<id>`.

What changes:

- Newly archived spans are cited in summaries as `context://archive/…`, not `context://vfs/…`.
- `chef.resolveRecall(uri)` today parses only the Offloader's `vfs` namespace, so it grows archive awareness with the switch. The `context` tool's `view` already reads both namespaces and needs no change.
- URIs already written into persisted summaries keep pointing at `context://vfs/…`. Those entries are still where they were; keep the old VFS store around, or re-key it, if you have durable history citing them.
- Code that lists the `vfs` namespace to enumerate archives must list `archive` instead. Per-namespace eviction policy (`maxAge` / `maxFiles` / `maxBytes`) starts applying to the two namespaces separately.

### 4. `vfs.uriScheme` is removed

`vfs.uriScheme` lets the Offloader mint its own address syntax — `myscheme://<id>` in place of `context://vfs/<id>` — which puts two spellings on one store and contradicts the single addressing scheme the persistence axis settled on. 4.x keeps it working, and the read path carries an adapter for it: the dispatcher asks the Offloader to parse an address under its own scheme before falling back to `context://` parsing. That adapter exists only to serve the alternate syntax, so it goes when the option goes.

In 5.0 every address is `context://`. A host that set `uriScheme` drops the option and reads the default `context://vfs/<id>` addresses instead. URIs already written into persisted summaries keep their old spelling, and — unlike the `archive/` switch, where the old `context://vfs/…` addresses still resolve — those addresses stop resolving once the parse adapter goes: `myscheme://<id>` then reaches `context://` parsing, which rejects `myscheme:` as a namespace. The entries are still in `vfs/`; they have to be re-cited (or looked up) as `context://vfs/<id>`.

### 5. `durableCompaction` speaks the unified vocabulary

`planCompaction` / `compactHistory` in `packages/core/src/modules/janitor/durableCompaction.ts` are standalone — no chef, so no resolved `Vocabulary` — and today they call `Prompts.getCompactSummaryWrapper` directly, which is the legacy wrapper. In 5.0 they take the unified wrapper, so the summary message a durable compaction writes into your store changes wording (and gains the window-lineage line where a lineage is available).

Because durable compaction writes into a store the caller owns, that text is persisted history, not a per-compile injection: histories compacted before and after the upgrade will carry differently worded summary messages side by side. Both remain valid input — nothing parses the wrapper — but snapshot tests over stored messages will need re-baselining.

---

## Checklist (all of it is available in 4.2)

1. Route library tool calls through `chef.ownsTool(name)` / `chef.handleTool(call)` instead of branching on `create_memory` / `modify_memory` / `recall_context`.
2. Set `tools: 'unified'` explicitly once your loop routes through `handleTool`, and re-check any assertion on `payload.tools` or on prompt bytes.
3. Replace `janitor.compressionMode` / `compressionScheduling` / `archive` and `contextManagement` with one `overflow: { strategy, archive }`.
4. Replace `onBeforeCompile` / `transformContext` with `chef.use('before-assemble' | 'after-assemble', …)`.
5. Replace `MemoryStore` / `VFSStorageAdapter` implementations with one `StorageBackend`, and pass it as `ChefConfig.store` instead of `memory.store` + `vfs.adapter`. Swap `InMemoryStore` → `InMemoryBackend`, `VFSMemoryStore` / `FileSystemAdapter` → `FileSystemBackend`.
6. Middleware users: `truncate.storage` → `truncate.store`.
7. If you enumerate or persist `context://vfs/…` archive URIs, decide now whether to migrate those entries or keep the old store readable past the `archive/` switch.
8. If you set `vfs.uriScheme`, drop it and let the Offloader address offloaded output as `context://vfs/<id>` — and decide what to do about summaries that already cite the old spelling.
9. Then adopt what is new where it pays off: `overflow.handoff` + `new_context` so the model can save state before its window is cut, `reset()` / `chain()` for cheap window turnover, `notes/` as the model's own scratch space, and `pipelineChecks: true` in development.
