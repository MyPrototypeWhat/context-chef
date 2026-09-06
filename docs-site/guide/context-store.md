# Context store <Badge type="tip" text="4.2" />

Everything ContextChef keeps outside the context window — durable memory entries, offloaded tool output, archived compression spans, the model's own working notes — is the same thing at different addresses. 4.2 collapses what used to be three unrelated storage interfaces into one substrate and one model-facing tool.

This is axis ③ (persistence) and axis ④ (retrieval) of the [five-axis architecture](/guide/architecture). Module-level details still live on their own pages: [Memory](/guide/memory) for TTL, selectors and `allowedKeys`, [Offloading & VFS](/guide/offloading-vfs) for the truncation and cleanup lifecycle, [Overflow](/guide/history-compression) for what gets archived.

## The substrate

Two layers. A `StorageBackend` moves bytes for one or more namespaces; a `Store` adds namespacing, `context://` URIs, an access index and eviction on top of it.

```typescript
interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}

interface StorageBackend {
  read(ns: string, path: string): MaybePromise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): MaybePromise<void>;
  delete(ns: string, path: string): MaybePromise<boolean>;
  list(ns: string, prefix?: string): MaybePromise<ListedEntry[]>;
  // optional capabilities, queried rather than assumed:
  readAll?(ns: string, prefix?: string): MaybePromise<StoredEntries>; // Map (backend order) or Record
  exists?(ns: string, path: string): MaybePromise<boolean>;
  append?(ns: string, path: string, content: string): MaybePromise<void>;
  search?(ns: string, query: string): MaybePromise<SearchHit[]>;
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
  getPhysicalPath?(ns: string, path: string): MaybePromise<string | null>;
  supports?(capability: StoreCapability, ns?: string): boolean;
}
```

Every method may be sync or async and the `Store` passes that choice straight through, so a synchronous backend keeps synchronous call sites (`chef.offload`, `memory.snapshot`) synchronous. Asking a namespace for something its backend cannot do throws `StoreCapabilityError` naming the missing capability — the `context` tool turns that into an error message the model can read instead of a failed turn.

Two backends ship with the library:

| Backend | Storage | Sync? |
|---|---|---|
| `InMemoryBackend` | a `Map` per namespace | yes — ephemeral, ideal for tests |
| `FileSystemBackend` | one directory per namespace under a root | yes — the on-disk one |

`FileSystemBackend` keeps a per-namespace on-disk layout, which is how the Offloader's flat `vfs_<ts>_<hash>.txt` files round-trip unchanged — the Offloader installs that layout for `vfs/`. It does **not** read `VFSMemoryStore`'s legacy `<base64url>.mem` files: that layout lives inside `VFSMemoryStore`, and a bare `FileSystemBackend` writes `memory/<key>` with a `{ content, meta }` envelope instead. See [migrating](#migrating-from-the-4-1-storage-interfaces) before pointing one at an existing memory directory.

## Namespaces

| Namespace | Holds | Written by | In the window? |
|---|---|---|---|
| `memory/` | durable facts worth carrying between conversations | [Memory](/guide/memory), the model | injected into every compile |
| `notes/` | the model's own working scratch space | the model, via the `context` tool | only when the model reads it |
| `vfs/` | tool output too large to keep inline | [the Offloader](/guide/offloading-vfs) | a truncation marker plus a URI |
| `archive/` | reserved for spans compacted out of the window | nothing in 4.x — `overflow.archive` still writes into `vfs/` | a citation in the summary |

`memory/` is the only namespace that is shown to the model automatically; everything else stays out of the window until the model asks for it. That is the whole point of `notes/`: a place to put a plan or a running log that costs nothing per turn.

::: tip Archive still writes into `vfs/` in 4.x
`overflow.archive` keeps storing spans under `context://vfs/...` so existing URIs stay byte-identical. The dedicated `archive/` namespace is reserved and read-only: nothing writes into it in 4.x, so neither the `context` tool description nor the store instruction mentions it — a namespace the model would find empty is not worth the prefix bytes. An `archive/` path it is given still resolves, through the same recall rendering as `vfs/`. It becomes the archive's home in 5.0.
:::

## `ChefConfig.store`

One backend behind every namespace:

```typescript
import { ContextChef, FileSystemBackend } from '@context-chef/core';

const chef = new ContextChef({
  store: new FileSystemBackend('./.context'),
  memory: {},
  vfs: { threshold: 5000 },
  overflow: { archive: 'vfs' },
});
```

`store` fills in what nothing else specifies. An explicit `memory.store` still wins for memory, and an explicit `vfs.store` / `vfs.adapter` / `vfs.storageDir` still wins for the VFS — with neither set, today's defaults apply unchanged, so adding `store` to an existing config never moves data behind your back.

Pass a pre-built `Store` instead of a bare backend when you want per-namespace eviction caps or URI schemes:

```typescript
import { FileSystemBackend, Store } from '@context-chef/core';

const store = new Store(new FileSystemBackend('./.context'), {
  eviction: {
    vfs: { maxFiles: 500, maxBytes: 100 * 1024 * 1024 },
    archive: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  },
});
```

## Addressing

Every entry has one address: `context://<namespace>/<path>`.

```typescript
const notes = chef.getStore().namespace('notes');

await notes.put('plan.md', '# Plan\n1. Read the failing test\n');
const entry = await notes.get('plan.md');
notes.uri('plan.md'); // 'context://notes/plan.md'

Store.parseUri('context://notes/plan.md'); // { ns: 'notes', path: 'plan.md' }
```

`chef.getStore()` returns the shared `ChefConfig.store` when one was passed, and the Offloader's own store otherwise — so it is always the store the `context` tool reads and writes. Use it to seed notes before a run, or to inspect what the model wrote after one.

A `NamespaceView` also offers `list`, `entries`, `append`, `delete`, `search`, `exists`, `getPhysicalPath` and `supports`, plus `getSync` / `putSync` / `deleteSync` / `listSync` for synchronous backends. `put` returns `{ path, uri }`; called without a path (`put(content, meta)`) it derives a content-addressed one, so re-offloading identical content in an agent loop is idempotent and the URI is stable across processes.

## The `context` tool

One tool, seven commands, every namespace:

| Command | What it does |
|---|---|
| `view` | reads an entry, or lists a directory (`context://notes/` is a directory) |
| `create` | writes a new entry; fails if one already exists |
| `str_replace` | swaps the single exact occurrence of `old_str` for `new_str` |
| `insert` | puts `insert_text` at the 0-based line `insert_line` |
| `delete` | removes an entry |
| `rename` | moves an entry to `new_path` in the same namespace |
| `search` | finds entries under `path` whose content matches `query` |

The schema is static, frozen and reference-stable: exactly one enum, and it is the command list — never a live list of your memory keys. That is what lets it sit in a cached prefix without invalidating anything. What exists *right now* is conveyed further down the prompt, in the injected memory block and in the tool's own results.

Behaviour is per-namespace, and each namespace keeps its module's semantics:

- **`memory/`** routes through the Memory module, so `allowedKeys`, the `onMemoryUpdate` veto, `onMemoryChanged`, TTL and the update counter all apply exactly as they do for a direct API call. `rename` is a create plus a delete.
- **`notes/`** goes straight to `store.namespace('notes')` — line-numbered `view`, single-occurrence `str_replace`, 0-based `insert`, and a `search` that falls back to list-plus-get when the backend has no native search.
- **`vfs/`** and **`archive/`** are view-only by default and render through the same recall path as `recall_context`.

**Paths are validated before anything is read or written.** A namespace is one plain segment: `.`, `..`, an empty name, a backslash, a `:` or a `/` inside it are all rejected, as are control characters. Every path segment gets the same treatment — no `.`, no `..`, no empty segment except the single trailing one that means "directory", no backslash. Nested paths are otherwise free: `notes/dir/file` is an ordinary key, and `view` on `notes/` lists it recursively. `FileSystemBackend` re-checks at the bottom of the stack and refuses any physical path that resolves outside its namespace directory.

Model-facing mistakes never throw. An unknown path, a rejected one, a missing argument, a write to a read-only namespace, a rejected memory key and a veto from `onMemoryUpdate` all come back as `Error: …` text the model can read and correct. Only a tool name the chef does not own throws — that is a routing bug in your loop, not something the model can fix.

### Access policy

Reading is never restricted: everything in the store is this conversation's own overflow, and a model that can be handed a `context://` URI can be handed what is behind it. Writing is:

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend('./.context'),
  memory: {},
  tools: 'unified',
  contextTool: { writable: ['notes'] }, // memory becomes read-only to the model
});
```

The default is `['memory', 'notes']`. Add `'vfs'` to let the model edit offloaded tool output. The policy is enforced when a call is dispatched, never in the store — your own code writes wherever it likes.

### Dispatch — `ownsTool` and `handleTool`

One entry point for every library-owned tool: `context`, `new_context`, and the legacy `create_memory` / `modify_memory` / `recall_context` trio.

```typescript
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: 'tool', tool_call_id: call.id, content });
    continue;
  }
  await executeYourOwnTool(call);
}
```

`arguments` is accepted both as the JSON string the OpenAI and Anthropic SDKs produce and as the already-parsed object Anthropic's `input` and Gemini's `args` carry.

`ownsTool` is independent of `ChefConfig.tools`: the mode decides what `compile()` *emits*, not what `handleTool` understands. A migration that emits `context` while the model still occasionally reaches for `create_memory` works, and so does the reverse.

## `tools` mode

```typescript
const chef = new ContextChef({ tools: 'unified' /* default: 'legacy' */ });
```

| Mode | `payload.tools` carries | Vocabulary |
|---|---|---|
| `'legacy'` (default in 4.x) | Memory's `create_memory` / `modify_memory`. `recall_context` and `new_context` stay opt-in — register them yourself | the 4.x wording: memory is its own feature with its own tools |
| `'unified'` | one `context` tool, plus `new_context` when `overflow.handoff` is configured. The legacy memory tools are not emitted | `context://` addressing throughout |

The two sets never co-exist in one payload: they describe the same operations in two vocabularies, and a model handed both has to guess which one the host actually dispatches.

**Why `'legacy'` is still the default.** Tool names are dispatch keys in your agent loop. Flipping the default would silently rename the tools your `if (name === 'create_memory')` branch is matching on, in a minor release. It becomes `'unified'` in 5.0 — a major, where you get to read the migration note first.

You do not have to wait for the mode to use the tool. Registering it yourself works on either mode:

```typescript
import { getContextToolDefinition, getNewContextToolDefinition } from '@context-chef/core';

chef.registerTools([getContextToolDefinition(), getNewContextToolDefinition()]);
```

### The vocabulary switch

The mode also picks the session's vocabulary — resolved once, in the constructor, and injected into every place the library renders text for the model:

| What the model reads | `'legacy'` | `'unified'` |
|---|---|---|
| memory usage instruction | `Prompts.MEMORY_INSTRUCTION` | `Prompts.CONTEXT_STORE_INSTRUCTION` — namespaces, addressing, which are auto-shown |
| injected memory block header | the 4.x header | `Memory (context://memory/*) currently holds:` |
| offload truncation marker | the 4.x placeholder | names the `context` tool and the `context://vfs/` URI |
| summary wrapper | the 4.x wrapper | cites `context://archive` and carries the window lineage line |
| handoff notice | `Prompts.HANDOFF_NOTICE_TEMPLATE` | the `context://`-addressed variant |

The point is that the prompt never mentions a tool the payload does not carry. `LEGACY_VOCABULARY` delegates to the existing `Prompts` strings verbatim, which is what makes the default byte-identical to 4.1 — the golden payload fixtures assert it.

Standalone modules built without a chef (`new Memory(...)`, `new Offloader(...)`) behave exactly as before unless you hand them a vocabulary.

## Migrating from the 4.1 storage interfaces

Nothing breaks. The old interfaces are deprecated wrappers over the new substrate, and every existing config keeps working.

| Deprecated | Replacement | Notes |
|---|---|---|
| `MemoryStore` | `StorageBackend` | wrapped by `Store.fromMemoryStore`; `MemoryStoreEntry` maps 1:1 onto `StoredEntry.meta` |
| `VFSStorageAdapter` | `StorageBackend` | wrapped by `Store.fromVfsAdapter` |
| `FileSystemAdapter` | `FileSystemBackend` | same on-disk format |
| `VFSMemoryStore` | `FileSystemBackend` + `memory` namespace | for a **new** directory. `VFSMemoryStore` is rebuilt on `FileSystemBackend` and still reads the files it wrote, but it installs that layout itself — see below |
| `InMemoryStore` | `InMemoryBackend` | still exported and still works |
| `memory.store` / `vfs.storage` per module | one `ChefConfig.store` | per-module stores still win when set |

`Memory` and `Offloader` accept all of these — a legacy store, a `StorageBackend`, or a `Store` — and their public APIs are unchanged. They are removed in 5.0.

### `VFSMemoryStore` is the one row that is not a directory swap

Its on-disk layout — one base64url-named `.mem` file per key, holding a bare `MemoryStoreEntry` — is installed by `VFSMemoryStore`'s own constructor, not by `FileSystemBackend`. Point a plain backend at a `./.context_memory` directory written by 4.1 and it lists nothing, reads `null`, and starts writing `memory/<key>` envelopes beside the files it ignored. Two ways to keep the entries:

```typescript
import { ContextChef, Store, VFSMemoryStore } from '@context-chef/core';

// Keep the deprecated store — it still reads and writes its own files.
new ContextChef({ memory: { store: new VFSMemoryStore('./.context_memory') } });

// Or wrap it: same files, on the new substrate.
new ContextChef({
  memory: { store: Store.fromMemoryStore(new VFSMemoryStore('./.context_memory')) },
});
```

A legacy store is a single flat keyspace, so the wrapper serves only `memory/`. Give the chef a `FileSystemBackend` for a fresh root when you want one backend behind `notes/`, `vfs/` and `archive/` too, and migrate the entries across with `memory.getAll()`.

## Where to go next

- [Memory](/guide/memory) — TTL, `selector`, `allowedKeys`, `memoryPlacement`
- [Offloading & VFS](/guide/offloading-vfs) — truncation, cleanup lifecycle, custom backends
- [Overflow](/guide/history-compression) — what gets archived, and `new_context`
- [Architecture](/guide/architecture) — where persistence and retrieval sit among the five axes
