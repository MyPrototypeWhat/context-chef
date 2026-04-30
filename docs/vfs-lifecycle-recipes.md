# VFS Lifecycle — Production Recipes

The Offloader's `.context_vfs/` (or any custom storage backend) grows without bound unless you sweep it. ContextChef gives you the mechanism — `cleanup()`, `reconcile()`, and the `onVFSEvicted` hook — but never auto-triggers anything. This doc collects five production-grade patterns for wiring those mechanisms into real systems.

**Quick reference:**

| Method | What it does | When to call |
|---|---|---|
| `chef.getOffloader().cleanupAsync()` | Sweep maxAge, then LRU-evict to fit maxFiles/maxBytes | Periodically; per turn; on session end |
| `chef.getOffloader().cleanupAsync({...})` | Same, with one-call cap overrides | Aggressive purge before snapshot/shutdown |
| `chef.getOffloader().reconcileAsync()` | Adopt orphan files into the in-memory index | Once on startup / cold boot |
| `onVFSEvicted` hook | Per-entry eviction notification | Wire telemetry, audit logs, side effects |

**Eviction order (single pass):**

1. **Phase A** — every entry where `now - createdAt > maxAge` is evicted (reason `'maxAge'`).
2. **Phase B** — while count > maxFiles or bytes > maxBytes, evict the least-recently-accessed entry (reason `'maxFiles'` if count is binding, else `'maxBytes'`).

UTF-8 byte length is computed via `Buffer.byteLength(content, 'utf8')` — `maxBytes` is true storage size, not JS `string.length`.

---

## Recipe 1 — Long-running server with periodic cleanup

The default for any always-on service (Express, Fastify, Hono, NestJS, persistent worker). One scheduler thread, fixed cadence, errors logged but never propagated to request handlers.

```typescript
import { ContextChef } from '@context-chef/core';

const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    storageDir: './.context_vfs',
    maxAge: 24 * 60 * 60 * 1000,   // 24h
    maxFiles: 500,
    maxBytes: 100 * 1024 * 1024,   // 100 MiB
    onVFSEvicted: (entry, reason) => {
      logger.debug({ uri: entry.uri, reason, bytes: entry.bytes }, 'vfs evicted');
    },
  },
});

// Sweep every 10 minutes. Detached from request handling — failures are logged, never thrown.
const sweepInterval = setInterval(() => {
  chef.getOffloader()
    .cleanupAsync()
    .then(({ evicted, evictedBytes, failed }) => {
      logger.info({ evicted: evicted.length, evictedBytes, failed: failed.length }, 'vfs swept');
    })
    .catch((err) => {
      logger.error({ err }, 'vfs sweep failed');
    });
}, 10 * 60 * 1000);

// Don't keep the event loop alive just for cleanup.
sweepInterval.unref();

// On graceful shutdown: one final aggressive sweep so disk is bounded for the next process.
process.on('SIGTERM', async () => {
  clearInterval(sweepInterval);
  await chef.getOffloader().cleanupAsync({ maxAge: 0 }).catch(() => {});
  process.exit(0);
});
```

**Per-turn variant (lower-throughput agents):** if your agent processes one user turn at a time and turns are seconds apart (chat UI, copilot loop), call `cleanupAsync()` at the end of each turn instead of running an interval. This bounds disk to roughly one turn's worth of overflow:

```typescript
async function handleTurn(userMessage: string) {
  // ... append, compile, call LLM, append response ...
  await chef.getOffloader().cleanupAsync();
}
```

The interval pattern is better when turns can fire faster than cleanup completes (concurrent requests on a server).

---

## Recipe 2 — Serverless / process-restart with `reconcile()`

The classic footgun: in serverless or container redeploys, the in-memory index dies but the storage backend (mounted volume, /tmp, S3 bucket) keeps the files. A fresh `Offloader` instance has no idea those files exist, so `cleanup()` becomes a silent no-op until you adopt them.

`reconcile()` walks `adapter.list()`, parses `createdAt` from the filename pattern `vfs_<ts>_<hash>.txt`, and inserts each orphan into the index. It's the equivalent of `npm cache verify`.

```typescript
import { ContextChef } from '@context-chef/core';

// One-time module-level construction (cold start runs this once, then warm invocations reuse it).
const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    storageDir: '/tmp/.context_vfs',  // serverless writable scratch
    maxAge: 60 * 60 * 1000,           // 1h — Lambda /tmp is ephemeral but can persist across warm invocations
    maxFiles: 100,
    maxBytes: 50 * 1024 * 1024,
  },
});

// On first invocation: adopt files left by previous warm-instance lifecycles.
let reconciled = false;
async function ensureReconciled() {
  if (reconciled) return;
  reconciled = true;
  const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
  if (adopted > 0) logger.info({ adopted }, 'reconciled orphan VFS entries from prior invocation');
}

export async function handler(event: LambdaEvent) {
  await ensureReconciled();

  // ... process event ...

  // Sweep before returning so the next warm invocation starts within budget.
  await chef.getOffloader().cleanupAsync();

  return { statusCode: 200 };
}
```

**`measureBytes: true`?** Without it, reconciled entries get `bytes: 0` (since we don't read content during the list walk). That makes them invisible to `maxBytes`-driven eviction until they're re-resolved. Pay the one-time read cost on cold start if you care about byte-accurate eviction; skip it if you only care about `maxAge` / `maxFiles`.

**Filename parsing:** orphans whose names don't match `vfs_<digits>_<hex>.txt` (e.g., files written by tools that bypass the Offloader) get `Date.now()` as their `createdAt` fallback — they survive a full `maxAge` from the moment of reconciliation, never longer.

---

## Recipe 3 — AI SDK middleware: shared adapter, externally-managed lifecycle

**The problem:** `@context-chef/ai-sdk-middleware` constructs a fresh `Offloader` inside `truncateToolResults()` on every request (see `packages/ai-sdk-middleware/src/truncator.ts`). That instance's in-memory index is single-use and discarded — calling `cleanup()` on it would do nothing useful.

**The pattern:** instantiate ONE shared `VFSStorageAdapter` at module scope, pass it to the middleware via `truncate.storage`, AND construct your own long-lived `Offloader` wrapping the same adapter. Use the long-lived one for lifecycle; the middleware's short-lived one just writes through to the same backend.

```typescript
import { generateText } from 'ai';
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { Offloader, FileSystemAdapter } from '@context-chef/core';

// Shared storage backend.
const storageAdapter = new FileSystemAdapter('./.vfs');

// Long-lived Offloader wrapping the same adapter. Used ONLY for lifecycle.
const lifecycleOffloader = new Offloader({
  threshold: 5000,
  adapter: storageAdapter,
  maxAge: 12 * 60 * 60 * 1000,
  maxFiles: 200,
  maxBytes: 50 * 1024 * 1024,
  onVFSEvicted: (entry, reason) => {
    logger.debug({ uri: entry.uri, reason }, 'vfs evicted');
  },
});

// Adopt orphans on startup (process may have restarted).
await lifecycleOffloader.reconcileAsync();

// Wire the SAME adapter into the middleware. The middleware constructs its own
// short-lived Offloader internally — that's fine; both write through to storageAdapter.
const wrapped = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: { threshold: 5000, storage: storageAdapter },
});

// Periodic cleanup runs on the lifecycle Offloader, which sees every file the middleware wrote.
setInterval(() => {
  lifecycleOffloader.cleanupAsync().catch((err) => logger.error({ err }, 'vfs sweep failed'));
}, 10 * 60 * 1000).unref();

// Use the wrapped model normally:
const result = await generateText({ model: wrapped, ... });
```

**Why this works:** `cleanup()` is keyed by filename via the in-memory index. The middleware's transient Offloader writes a file (filename ends up in storage), then is GC'd — but the file persists. When `lifecycleOffloader.reconcileAsync()` runs (on startup or before each cleanup if you want maximum safety), it adopts every file the middleware wrote and `cleanupAsync()` evicts them per your caps.

**Belt-and-suspenders variant** — if middleware writes are continuous and you don't want to wait for the next interval to surface new files, reconcile before every cleanup:

```typescript
async function sweep() {
  await lifecycleOffloader.reconcileAsync();
  await lifecycleOffloader.cleanupAsync();
}
```

`reconcile()` is idempotent and cheap (one `adapter.list()` call); doing it before every sweep is fine.

---

## Recipe 4 — Custom storage adapter (Redis example)

`FileSystemAdapter` is the only built-in. Anything else — Redis, S3, SQLite, IndexedDB, in-memory — needs a custom adapter. To enable `cleanup()` and `reconcile()`, the adapter must implement the optional `list()` and `delete()` methods. Without them, `cleanup()` throws `VFSCleanupNotSupportedError({ missing: ['list'?, 'delete'?] })`.

```typescript
import type { VFSStorageAdapter } from '@context-chef/core';
import type { RedisClientType } from 'redis';

class RedisVFSAdapter implements VFSStorageAdapter {
  constructor(
    private redis: RedisClientType,
    private keyPrefix = 'vfs:',
  ) {}

  async write(filename: string, content: string): Promise<void> {
    await this.redis.set(this.keyPrefix + filename, content);
  }

  async read(filename: string): Promise<string | null> {
    return await this.redis.get(this.keyPrefix + filename);
  }

  // Required for cleanup(). Returns bare filenames (no prefix), matching what write/delete expect.
  async list(): Promise<string[]> {
    const keys = await this.redis.keys(this.keyPrefix + '*');
    return keys.map((k) => k.slice(this.keyPrefix.length));
  }

  // Required for cleanup(). MUST be idempotent — deleting a missing file must not throw.
  async delete(filename: string): Promise<void> {
    await this.redis.del(this.keyPrefix + filename);  // redis DEL is naturally idempotent
  }
}

const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    adapter: new RedisVFSAdapter(redisClient),
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7d in Redis
    maxBytes: 500 * 1024 * 1024,
  },
});

// Same lifecycle pattern as Recipe 1 — periodic cleanupAsync(), with reconcileAsync() on startup.
```

**Production checklist for custom adapters:**

- [ ] `list()` returns filenames only, NOT full keys / paths / URIs (the Offloader prepends `uriScheme` itself).
- [ ] `list()` returns `[]` if the namespace is empty — never throw on "no entries."
- [ ] `delete()` is idempotent — must not throw `ENOENT` / "key not found." Cleanup retries fail-fast on any thrown error and pushes it to `result.failed`.
- [ ] If your storage has its own native TTL (Redis `EXPIRE`, S3 lifecycle rules), prefer that for actual data eviction and use ContextChef's `cleanup()` purely to keep the in-memory index in sync. Configure `maxAge` to roughly match the backend's TTL.
- [ ] Filter out non-VFS keys in `list()` — if the same Redis namespace holds other data, restrict the prefix carefully (`FileSystemAdapter` filters by `vfs_` filename prefix for the same reason).
- [ ] Async adapters MUST be paired with `cleanupAsync()` / `reconcileAsync()`. The sync `cleanup()` will throw `'use cleanupAsync() instead'` if `list()` returns a Promise.

---

## Recipe 5 — Choosing your eviction strategy

There's no single "right" config; the answer depends on what's scarce.

| If your bottleneck is… | Set… | Skip… |
|---|---|---|
| Disk space | `maxBytes` | `maxFiles` (count doesn't matter if total bytes are bounded) |
| File handle / inode count (large numbers of tiny files) | `maxFiles` | `maxBytes` |
| Stale data accuracy (must not serve content older than X) | `maxAge` only — the others are insurance | — |
| All of the above | All three — Phase A clears stale, Phase B then enforces both bytes + count caps | — |
| Hard cap on storage with no per-entry age semantics | `maxFiles` + `maxBytes`, leave `maxAge` undefined | — |

**`Infinity` to disable a single cap for one call:**

```typescript
// Before snapshot: nuke everything older than 1h, ignore count/byte caps for this call.
await chef.getOffloader().cleanupAsync({
  maxAge: 60 * 60 * 1000,
  maxFiles: Infinity,
  maxBytes: Infinity,
});
```

**`0` to evict everything matching a phase:**

```typescript
// Session end: evict EVERY entry regardless of age (Phase A: now - createdAt > 0 is true for all).
await chef.getOffloader().cleanupAsync({ maxAge: 0 });
```

**Telemetry:** the `onVFSEvicted` hook is per-entry, fires after each successful eviction, and ignores its own throws (logged via `console.warn`, never propagates). Use it for metrics, audit logs, or downstream cache invalidation:

```typescript
const chef = new ContextChef({
  vfs: {
    maxFiles: 500,
    onVFSEvicted: (entry, reason) => {
      metrics.increment('vfs.eviction', { reason });
      metrics.distribution('vfs.evicted_age_ms', Date.now() - entry.createdAt);
      metrics.distribution('vfs.evicted_bytes', entry.bytes);
    },
  },
});
```

The `VFSCleanupResult` returned from `cleanup()` / `cleanupAsync()` already gives you aggregate counts (`evicted.length`, `evictedBytes`, `evictedByAge`, `evictedByCount`, `evictedByBytes`, `failed.length`); use the hook only when you need per-entry attribution.
