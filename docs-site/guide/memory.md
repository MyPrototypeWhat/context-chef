# Memory

> **This page documents the Memory module.** For where memory *lives* — the one storage substrate, the `context://memory/` addressing it shares with `notes/`, `vfs/` and `archive/`, and the unified `context` tool — see [Context store](/guide/context-store). Memory is the `memory/` namespace plus the things that are genuinely Memory's own: TTL, the selector, `allowedKeys`, the write hooks, and where the block lands in the payload.

Persistent key-value memory that survives across sessions: the model writes via tool calls, and existing memories are auto-injected into the compiled payload on every `compile()`.

```typescript
import { ContextChef, FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend("./.context"), // one backend for every namespace
  memory: {},
});

// In your agent loop, dispatch memory tool calls through chef:
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");
```

On `compile()`: the memory tools are auto-injected into `payload.tools` (`create_memory` / `modify_memory` under `tools: 'legacy'`, the single `context` tool under `'unified'`), and existing entries are injected as a `<memory>` XML block.

`chef.handleTool` dispatches both vocabularies, so the loop above is the same either way. The 4.1 pattern — parsing `create_memory` / `modify_memory` arguments yourself and calling `createMemory` / `updateMemory` / `deleteMemory` — still works unchanged.

## `MemoryConfig`

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `MemoryStore \| StorageBackend \| Store` | — | Where entries live. Omit it and `ChefConfig.store` fills in; see [Context store](/guide/context-store). |
| `defaultTTL` | `TTLValue` | — | Default expiry for every write. Bare number = turns; `{ ms }` / `{ turns }` are explicit. Undefined = never expire. |
| `allowedKeys` | `string[]` | — | Restricts which keys the model may write. Becomes the `key` enum of `create_memory`, and is enforced again at dispatch. |
| `selector` | `(entries: MemoryEntry[]) => MemoryEntry[]` | all entries | Filter / sort / truncate before injection, once per compile, after the expiry sweep. |
| `memoryPlacement` | `'after_system' \| 'before_history_tail'` | `'after_system'` | Where the volatile data block lands. See below. |
| `onMemoryUpdate` | `(key, value, oldValue) => boolean` | — | Veto hook. Return `false` to block the write. |
| `onMemoryChanged` | `(event: MemoryChangeEvent) => void` | — | Notification after any change (`set` / `delete` / `expire`). |
| `onMemoryExpired` | `(entry: MemoryEntry) => void` | — | Fires per entry expired during `compile()`. |

## TTL — entries that age out

An entry can expire by wall clock or by conversation turn, which are genuinely different things: "this deploy token is valid for an hour" is wall clock, "remember the file we're editing for the next five turns" is turns.

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    defaultTTL: { turns: 20 }, // everything ages out after 20 compiles unless overridden
    onMemoryExpired: (entry) => logger.info(`memory expired: ${entry.key}`),
  },
});

await chef.getMemory().set("active_file", "auth.ts", { ttl: { turns: 5 } });
await chef.getMemory().set("deploy_token", "…", { ttl: { ms: 60 * 60 * 1000 } });
await chef.getMemory().set("persona", "…", { ttl: null }); // never expires
```

A bare number is turns: `defaultTTL: 20` and `defaultTTL: { turns: 20 }` are the same thing. The turn counter advances once per `compile()`, and the expiry sweep runs at the start of the `memory` phase — so an entry written with `{ turns: 1 }` survives exactly the next compile. Expired entries fire `onMemoryExpired` and the `memory:expired` event, and land in `payload.meta.memoryExpiredKeys`.

## `selector` — deciding what gets injected

Memory is a selection budget like any other: everything in `memory/` is injected on every compile unless you say otherwise. `selector` runs once per compile, after the expiry sweep, on the entries about to be injected.

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    // Only inject the 10 most recently updated entries.
    selector: (entries) => [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
  },
});
```

Each `MemoryEntry` carries `key`, `value`, `description?`, `createdAt`, `updatedAt`, `updateCount`, `importance?` and the resolved expiry. `importance` is yours to set and yours to interpret — the library never sorts by it. The selector must not throw: errors propagate out of `compile()`, so return the original array if you want to swallow one. Injected keys end up in `payload.meta.injectedMemoryKeys`.

## `allowedKeys` — a closed key set

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: { allowedKeys: ["persona", "project_rules", "user_preferences"] },
});
```

Two enforcement points, on purpose. The list becomes the `key` enum of the `create_memory` tool definition, so the model is steered rather than corrected; and every write is checked again at dispatch, so a model that ignores the enum (or the `context` tool, whose schema is deliberately static and carries no key list) gets a readable `Error: … is not an allowed memory key. Allowed keys: …` back instead of writing junk.

`allowedKeys` is construction-time config, which is what keeps the tool schema static across compiles.

## Write hooks

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    onMemoryUpdate: (key, value, oldValue) => {
      if (key === "persona" && oldValue !== null) return false; // write-once
      return true;
    },
    onMemoryChanged: (event) => audit.record(event.type, event.key),
  },
});
```

`onMemoryUpdate` is the veto: it runs before `createMemory` / `updateMemory` / `deleteMemory` and a `false` blocks the write. When the write came from a tool call, the veto surfaces to the model as an error message rather than a thrown exception. `onMemoryChanged` is pure notification, and fires for expiries too. Neither may throw — errors propagate out of the calling write method.

Direct `set()` / `delete()` calls bypass the veto by design: they are the developer's own writes, not the model's.

## Memory placement — `memoryPlacement`

Controls where the volatile `<memory>` data block lands in the compiled payload. Defaults to `'after_system'` (backward compatible). For applications using **Anthropic prompt caching** with cache breakpoints on history, switch to `'before_history_tail'` so memory mutations don't invalidate the history cache.

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: { memoryPlacement: 'before_history_tail' },
});
```

| Placement | Top of sandwich | Last user message | When to use |
|---|---|---|---|
| `'after_system'` (default) | INSTRUCTION + `<memory>` data, combined into one `role: 'system'` message | untouched | Simple agents; you don't rely on cache breakpoints past the system parameter |
| `'before_history_tail'` | INSTRUCTION only (stable, cacheable) | appends the `<memory>` data block to the original user content | You want cache breakpoints on history (or earlier `system` blocks) to survive memory mutations on every turn |

The split keeps the stable usage instruction at the top of the sandwich where it caches cleanly, and ships the volatile data block at the tail of the conversation. Anthropic / Gemini adapters extract every `role: 'system'` message into the top-level `system` parameter — under `'before_history_tail'` the data block stays in `messages` instead, so any cache breakpoint earlier in the message stream no longer hashes the changing memory text.

When dynamic state is also injected at the tail (`dynamicStatePlacement: 'last_user'`), the order inside the last user message is: original content → `<memory>` → `<dynamic_state>` → `<implicit_context>` → announcements → anchor line. When dynamic state goes to its own system message (`dynamicStatePlacement: 'system'`), memory still injects at the user tail with no anchor.

This is axis ② of the [five-axis architecture](/guide/architecture): the instruction is prefix, the data is tail.
