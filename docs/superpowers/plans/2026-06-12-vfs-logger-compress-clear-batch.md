# VFS Content-Addressing + Logger + Compress Boundary + Placeholder Clear — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agreed 4-item batch: (#5) content-addressed VFS filenames, (#7) optional logger hook, (#2) `onCompress` boundary metadata, (#3) placeholder-style `clear` option in both middlewares. Item #4 (dynamicState null sentinel) is explicitly OUT of scope.

**Architecture:** All semantics live in `@context-chef/core`; the two middleware packages (`ai-sdk-middleware`, `tanstack-ai`) only adapt and pass through. New core surface: `exists?()` on `VFSStorageAdapter`, `ChefLogger`, `CompressionDetails` (3rd `onCompress` arg), and pure `compactMessages()` extracted from `Janitor.compact`.

**Tech Stack:** TypeScript, pnpm workspace, vitest (`pnpm test` per package), `tsc --noEmit` typecheck, biome lint (root `pnpm lint`), changesets.

**Verified facts this plan relies on** (re-verify nothing; these were read from source on 2026-06-12):
- `packages/core/src/modules/offloader/index.ts:213` — `vfs_${Date.now()}_${hash}.txt`, md5 8-hex; no dedup before write; `ORPHAN_FILENAME_RE = /^vfs_(\d+)_[a-f0-9]+\.txt$/` at line 157 feeds `_buildOrphanMeta` createdAt parsing with `Date.now()` fallback.
- `VFSStorageAdapter` already has optional `list?()`, `delete?()`, `getPhysicalPath?()`; NO `exists()`.
- Both `toAISDK` (ai-sdk `adapter.ts:183`) and `toTanStackAI` (tanstack `adapter.ts:96`) rebuild content when `_originalText !== msg.content` — a placeholder written into IR `content` survives the round-trip (tool messages keep `toolCallId`/`toolName`).
- `Janitor.compact` (core `janitor/index.ts:453-507`) reads only its arguments — it is pure and can be extracted.
- `executeCompression` (core `janitor/index.ts:604-683`) already holds `splitIndex` and `toCompress`; `onCompress` fires in both the model branch and the no-`compressionModel` fallback branch (fallback does NOT insert the summary into returned history).
- `ChefEvents.compress` payload at core `index.ts:227-230`; event bridge at `index.ts:278-287`.
- Eleven non-test `console.warn` sites: core offloader 545/550/596, core janitor 334, ai-sdk middleware 106/128/167 + truncator 72, tanstack middleware 58/134 + truncator 67.
- ai-sdk truncator (`truncator.ts:19`) creates a **fresh Offloader per call**: `new Offloader({ threshold, adapter: storage, storageDir: '' })` — so cross-call idempotency MUST come from the content-addressed filename + `adapter.exists()`, never from `_index`.
- Existing offloader test asserts old filename format at `offloader/index.test.ts:1052`: `expect(stored[0]).toMatch(/^vfs_\d+_[a-f0-9]+\.txt$/)`.
- `TOOL_RESULT_CLEARED_INSTRUCTION` (core `prompts.ts:266`) is currently dead — defined, never injected by anyone.

**Phase gates (repo CLAUDE.md):** Complete each phase, run that phase's verification, then STOP and wait for explicit user approval before the next phase. Commit per task.

---

## Phase A — #5 Content-addressed VFS filenames

### Task 1: Offloader content addressing + idempotent writes

**Files:**
- Modify: `packages/core/src/modules/offloader/index.ts`
- Test: `packages/core/src/modules/offloader/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new describe block to `packages/core/src/modules/offloader/index.test.ts` (reuse the file's existing imports — `Offloader`, `vi`, `fs`, `path` are already imported there):

```typescript
function makeMemoryAdapter() {
  const store = new Map<string, string>();
  return {
    store,
    write: vi.fn((filename: string, content: string) => {
      store.set(filename, content);
    }),
    read: vi.fn((filename: string) => store.get(filename) ?? null),
    exists: vi.fn((filename: string) => store.has(filename)),
    list: () => [...store.keys()],
    delete: (filename: string) => {
      store.delete(filename);
    },
  };
}

describe('Offloader — content-addressed filenames', () => {
  const BIG = 'x'.repeat(100) + '\n' + 'y'.repeat(100);

  it('filename is vfs_<16-hex>.txt derived from content only', () => {
    const adapter = makeMemoryAdapter();
    const o = new Offloader({ threshold: 10, adapter, storageDir: '' });
    const r = o.offload(BIG, { tailChars: 20 });
    expect(r.isOffloaded).toBe(true);
    const filename = r.uri?.replace('context://vfs/', '');
    expect(filename).toMatch(/^vfs_[a-f0-9]{16}\.txt$/);
  });

  it('same content → same filename and identical marker across instances', () => {
    const adapter = makeMemoryAdapter();
    const a = new Offloader({ threshold: 10, adapter, storageDir: '' });
    const b = new Offloader({ threshold: 10, adapter, storageDir: '' });
    const r1 = a.offload(BIG, { tailChars: 20 });
    const r2 = b.offload(BIG, { tailChars: 20 });
    expect(r1.uri).toBe(r2.uri);
    expect(r1.content).toBe(r2.content); // marker is byte-stable → provider prefix cache holds
  });

  it('re-offloading identical content on the same instance skips the adapter write', () => {
    const adapter = makeMemoryAdapter();
    const o = new Offloader({ threshold: 10, adapter, storageDir: '' });
    o.offload(BIG, { tailChars: 20 });
    o.offload(BIG, { tailChars: 20 });
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('a fresh instance skips the write when adapter.exists reports the file', () => {
    const adapter = makeMemoryAdapter();
    new Offloader({ threshold: 10, adapter, storageDir: '' }).offload(BIG, { tailChars: 20 });
    new Offloader({ threshold: 10, adapter, storageDir: '' }).offload(BIG, { tailChars: 20 });
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.exists).toHaveBeenCalled();
  });

  it('re-offload refreshes accessedAt so identical content stays LRU-warm', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const adapter = makeMemoryAdapter();
    const o = new Offloader({ threshold: 10, adapter, storageDir: '' });
    o.offload(BIG, { tailChars: 20 });
    vi.setSystemTime(5000);
    o.offload(BIG, { tailChars: 20 });
    const entry = o.getEntries()[0];
    expect(entry?.accessedAt).toBe(5000);
    vi.useRealTimers();
  });

  it('different content → different filename', () => {
    const adapter = makeMemoryAdapter();
    const o = new Offloader({ threshold: 10, adapter, storageDir: '' });
    const r1 = o.offload(BIG, { tailChars: 20 });
    const r2 = o.offload(`${BIG}!`, { tailChars: 20 });
    expect(r1.uri).not.toBe(r2.uri);
  });

  it('legacy timestamped files still resolve and reconcile with parsed createdAt', () => {
    const adapter = makeMemoryAdapter();
    adapter.store.set('vfs_1000_abcdef00.txt', 'legacy content');
    const o = new Offloader({ threshold: 10, adapter, storageDir: '' });
    expect(o.resolve('context://vfs/vfs_1000_abcdef00.txt')).toBe('legacy content');
    const o2 = new Offloader({ threshold: 10, adapter, storageDir: '' });
    o2.reconcile();
    expect(o2.getEntries()[0]?.createdAt).toBe(1000);
  });

  it('FileSystemAdapter writes atomically: no tmp residue, list() sees only complete files', () => {
    // reuse the file's existing temp-dir fixture pattern (see the cleanup tests)
    const dir = makeTempStorageDir();
    const adapter = new FileSystemAdapter(dir);
    adapter.write('vfs_0123456789abcdef.txt', 'data');
    expect(adapter.read('vfs_0123456789abcdef.txt')).toBe('data');
    expect(adapter.list()).toEqual(['vfs_0123456789abcdef.txt']);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp_'))).toHaveLength(0);
  });
});
```

Note: check the actual `getEntries()` accessor name in the file before writing (the existing cleanup tests at ~line 962 use `o.getEntries()` — copy whatever they use).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @context-chef/core test -- offloader`
Expected: the new describe block FAILS (old filenames contain timestamps; `write` called twice; `exists` never called). Pre-existing tests pass.

- [ ] **Step 3: Implement**

In `packages/core/src/modules/offloader/index.ts`:

3a. Add `exists?` to `VFSStorageAdapter` (after `read`, before `list?`):

```typescript
  /**
   * Optional. Lets the Offloader skip redundant writes when a
   * content-addressed file already exists. Adapters that can't answer
   * cheaply may leave this unset — the Offloader then overwrites, which
   * is harmless (same filename ⇒ same content).
   *
   * Contract: only return true for FULLY persisted content. With
   * content-addressed names the Offloader treats existence as proof the
   * bytes are complete and skips the write — a partially written entry
   * reported as existing would be trusted forever. Make writes atomic
   * (FileSystemAdapter does: tmp file + rename).
   */
  exists?(filename: string): boolean | Promise<boolean>;
```

3b. Implement it on `FileSystemAdapter` (next to `read`), and make `write` atomic so the exists-skip contract holds — a crash mid-write must not leave a partial file occupying the content address (old timestamped names self-healed by writing a fresh file next step; content-addressed names would trust the corrupt file forever). Temp name starts with `.tmp_` so `list()` (filters `startsWith('vfs_')`) and reconcile never adopt residue:

```typescript
  write(filename: string, content: string): void {
    const filepath = path.join(this.storageDir, filename);
    const tmppath = path.join(this.storageDir, `.tmp_${process.pid}_${filename}`);
    try {
      fs.writeFileSync(tmppath, content, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The storage dir can vanish mid-process — OS temp cleaners purge
      // /var/folders & friends on long-running hosts, and the constructor's
      // mkdir only ran once. Recreate and retry once.
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(tmppath, content, 'utf8');
    }
    fs.renameSync(tmppath, filepath); // atomic on the same filesystem
  }

  exists(filename: string): boolean {
    return fs.existsSync(path.join(this.storageDir, filename));
  }
```

3c. Replace `_generateFilename` (line ~211):

```typescript
  private _generateFilename(content: string): { filename: string; uri: string } {
    // Content-addressed: identical content always maps to the same file, so
    // re-offloading in an agent loop is idempotent and the truncation marker
    // (URI + physical path) is byte-stable — provider prefix caches survive.
    // 16 hex chars (64 bits) because the hash alone is now the identity.
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    const filename = `vfs_${hash}.txt`;
    const uri = `${this.config.uriScheme}${filename}`;
    return { filename, uri };
  }
```

3d. In `offload()` (sync, line ~280), insert the dedup check between marker construction and `this.adapter.write(...)`:

```typescript
    const indexed = this._index.get(filename);
    if (indexed) {
      // Same content already offloaded by this instance — refresh LRU recency.
      indexed.accessedAt = Date.now();
      return { isOffloaded: true, content: truncated, uri };
    }

    if (this.adapter.exists) {
      const exists = this.adapter.exists(filename);
      // A Promise here means an async adapter on the sync path — fall through
      // to write(), which throws the established async-adapter error.
      if (exists === true) {
        this._registerEntry(filename, uri, content);
        return { isOffloaded: true, content: truncated, uri };
      }
    }
```

3e. Same in `offloadAsync()` with `await`:

```typescript
    const indexed = this._index.get(filename);
    if (indexed) {
      indexed.accessedAt = Date.now();
      return { isOffloaded: true, content: truncated, uri };
    }

    if (this.adapter.exists && (await this.adapter.exists(filename))) {
      this._registerEntry(filename, uri, content);
      return { isOffloaded: true, content: truncated, uri };
    }
```

3f. `ORPHAN_FILENAME_RE` (line 157) stays UNCHANGED — it exists to parse createdAt out of legacy files. Update its comment and the `_buildOrphanMeta` JSDoc (line ~407) to say: legacy `vfs_<ts>_<hash>.txt` names parse createdAt from the timestamp; content-addressed `vfs_<hash16>.txt` names (and malformed names) fall back to `Date.now()` at adoption — i.e. maxAge for adopted orphans counts from adoption, which is the conservative direction. Also fix the stale comment at line ~609 ("Parses createdAt from filename pattern vfs_<ts>_<hash>.txt").

3g. Update the old-format assertion at `index.test.ts:1052` to:

```typescript
    expect(stored[0]).toMatch(/^vfs_[a-f0-9]{16}\.txt$/);
```

Leave the legacy tests at ~889-913 (reconcile parses legacy timestamps) and ~962-975 (malformed → fallback) untouched — they cover the legacy path that must keep working.

- [ ] **Step 4: Run the full core suite**

Run: `pnpm --filter @context-chef/core test && pnpm --filter @context-chef/core typecheck`
Expected: PASS. If any other test asserted timestamped names, update it to the new pattern — but only filename-format assertions, nothing behavioral.

Also run the middleware suites (they construct Offloaders through truncators): `pnpm --filter @context-chef/ai-sdk-middleware test && pnpm --filter @context-chef/tanstack-ai test` (confirm exact package names from each `package.json` before running).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/offloader/index.ts packages/core/src/modules/offloader/index.test.ts
git commit -m "feat(core): content-addressed VFS filenames with idempotent writes"
```

**Phase A gate:** report results, STOP, wait for user approval.

---

## Phase B — #7 Logger hook

### Task 2: `ChefLogger` type + Offloader logger

**Files:**
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/core/src/modules/offloader/index.ts`
- Test: `packages/core/src/modules/offloader/index.test.ts`

- [ ] **Step 1: Write the failing test**

In the offloader test file (the cleanup/eviction describe block already constructs Offloaders with `onVFSEvicted` — mirror that setup):

```typescript
it('routes onVFSEvicted errors to the injected logger instead of console', () => {
  const logger = { warn: vi.fn() };
  const adapter = makeMemoryAdapter();
  const o = new Offloader({
    threshold: 10,
    adapter,
    storageDir: '',
    maxFiles: 0,
    logger,
    onVFSEvicted: () => {
      throw new Error('boom');
    },
  });
  o.offload('z'.repeat(200), { tailChars: 20 });
  o.cleanup();
  expect(logger.warn).toHaveBeenCalledWith('[Offloader] onVFSEvicted threw:', expect.any(Error));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @context-chef/core test -- offloader`
Expected: FAIL — `logger` is not a known config key / warn not routed.

- [ ] **Step 3: Implement**

3a. In `packages/core/src/types/index.ts` add (and export):

```typescript
/**
 * Minimal logging hook for degradation warnings (storage write failures,
 * misconfiguration, swallowed callback errors). Defaults to `console`.
 * Pass your host's logger service to land warnings in application logs.
 */
export interface ChefLogger {
  warn(message: string, ...args: unknown[]): void;
}
```

3b. In the offloader: add `logger?: ChefLogger;` to `VFSConfig`, store `private readonly logger: ChefLogger;` set in the constructor via `this.logger = config.logger ?? console;`, and replace the three `console.warn(...)` calls at lines ~545/550/596 with `this.logger.warn(...)` (message strings unchanged).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @context-chef/core test -- offloader && pnpm --filter @context-chef/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/index.ts packages/core/src/modules/offloader/index.ts packages/core/src/modules/offloader/index.test.ts
git commit -m "feat(core): ChefLogger hook, wire Offloader warnings through it"
```

### Task 3: Janitor logger + ChefConfig fan-out + export

**Files:**
- Modify: `packages/core/src/modules/janitor/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/modules/janitor/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('routes the missing-tokenizer warning to the injected logger', () => {
  const logger = { warn: vi.fn() };
  new Janitor({ contextWindow: 100, logger });
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0][0]).toContain('No tokenizer and no compressionModel');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @context-chef/core test -- janitor`
Expected: FAIL.

- [ ] **Step 3: Implement**

3a. Janitor: add to `JanitorConfigBase`:

```typescript
  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;
```

(import `ChefLogger` from `'../../types'` — match the file's existing relative import path for types). Replace the constructor `console.warn(` at line ~334 with `(config.logger ?? console).warn(`.

3b. `packages/core/src/index.ts`:
- Add `logger?: ChefLogger;` to `ChefConfig` (with JSDoc: "Fans out to all modules; a module-level `logger` in `vfs`/`janitor` config wins.").
- Constructor fan-out — offloader instantiation (line ~271) becomes:

```typescript
    this.offloader = new Offloader({ logger: config.logger, ...config.vfs });
```

  (check the current call: if it's `new Offloader(config.vfs)` with possibly-undefined `config.vfs`, the spread of `undefined` is fine in an object literal.)
- Janitor bridge (line ~281) becomes:

```typescript
    this.janitor = new Janitor({
      logger: config.logger,
      ...janitorConfig,
      onCompress: async (summary, truncatedCount) => {
        if (userOnCompress) await userOnCompress(summary, truncatedCount);
        await this.emitter.emit('compress', { summary, truncatedCount }, this._currentSignal);
      },
    });
```

- Export the type: extend the existing `export type { ClearTarget, CompactOptions } from './types';` line with `ChefLogger`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @context-chef/core test && pnpm --filter @context-chef/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/janitor/index.ts packages/core/src/index.ts packages/core/src/modules/janitor/index.test.ts
git commit -m "feat(core): logger option on Janitor and ChefConfig fan-out"
```

### Task 4: ai-sdk middleware logger

**Files:**
- Modify: `packages/ai-sdk-middleware/src/types.ts`
- Modify: `packages/ai-sdk-middleware/src/middleware.ts`
- Modify: `packages/ai-sdk-middleware/src/truncator.ts`
- Test: `packages/ai-sdk-middleware/src/truncator.test.ts` (or wherever the storage-failure test lives — find the existing "Falling back to simple truncation" coverage and extend it)

- [ ] **Step 1: Write the failing test**

In the truncator tests, copy the existing storage-write-failure test (adapter whose `write` throws) and assert the injected logger receives the warning instead of console:

```typescript
it('routes storage-failure warnings to the injected logger', async () => {
  const logger = { warn: vi.fn() };
  const storage = {
    write: () => {
      throw new Error('disk full');
    },
    read: () => null,
  };
  const prompt = makePromptWithBigToolResult(); // reuse the file's existing fixture helper
  await truncateToolResults(prompt, { threshold: 10, storage }, logger);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0][0]).toContain('Storage adapter write failed');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter <ai-sdk package name> test -- truncator`
Expected: FAIL — `truncateToolResults` takes 2 args.

- [ ] **Step 3: Implement**

3a. `types.ts`: add to `ContextChefOptions`:

```typescript
  /**
   * Sink for degradation warnings (storage write failures, missing usage
   * data, misconfiguration). Defaults to `console`. Forwarded to the
   * underlying Janitor and Offloader.
   */
  logger?: ChefLogger;
```

(import `type ChefLogger` from `'@context-chef/core'`.)

3b. `truncator.ts`: third parameter and pass-through:

```typescript
export async function truncateToolResults(
  prompt: LanguageModelV3Prompt,
  options: TruncateOptions,
  logger: ChefLogger = console,
): Promise<LanguageModelV3Prompt> {
```

- Offloader construction becomes `new Offloader({ threshold, adapter: storage, storageDir: '', logger })`.
- The `console.warn(` at line ~72 becomes `logger.warn(`.

3c. `middleware.ts`:
- At the top of `createMiddleware`: `const logger = options.logger ?? console;`
- `truncateToolResults(prompt, options.truncate)` → `truncateToolResults(prompt, options.truncate, logger)`.
- The three `console.warn(` calls (lines ~106/128/167) → `logger.warn(` — note line 167 is inside `createJanitor`, so pass `logger` into `createJanitor(options, contextWindow, logger)` and add `logger` to `sharedJanitorConfig` so the Janitor's own warning routes too.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter <ai-sdk package name> test && pnpm --filter <ai-sdk package name> typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-middleware/src
git commit -m "feat(ai-sdk-middleware): optional logger threaded to Janitor and Offloader"
```

### Task 5: tanstack-ai logger (mirror of Task 4)

**Files:**
- Modify: `packages/tanstack-ai/src/types.ts`
- Modify: `packages/tanstack-ai/src/middleware.ts`
- Modify: `packages/tanstack-ai/src/truncator.ts`
- Test: `packages/tanstack-ai/src/truncator.test.ts`

- [ ] **Step 1–5:** Apply Task 4 verbatim to the tanstack package: same `logger?: ChefLogger` option JSDoc, same `truncateToolResults(messages, options, logger = console)` third param, Offloader gets `logger` (tanstack's call is `new Offloader({ threshold, adapter: storage })` — becomes `new Offloader({ threshold, adapter: storage, logger })`), `console.warn` at middleware lines ~58/134 and truncator ~67 → `logger.warn`, `logger` added to `sharedJanitorConfig` (middleware.ts:44). Same failing-test-first flow, same assertions. Note: in tanstack `sharedJanitorConfig` is built before the options-level `const logger` would be — declare `const logger = options.logger ?? console;` as the first line of `contextChefMiddleware`.

Run: `pnpm --filter <tanstack package name> test && pnpm --filter <tanstack package name> typecheck`
Expected: PASS.

```bash
git add packages/tanstack-ai/src
git commit -m "feat(tanstack-ai): optional logger threaded to Janitor and Offloader"
```

**Phase B gate:** run root `pnpm lint`, report, STOP, wait for approval.

---

## Phase C — #2 `onCompress` boundary metadata

### Task 6: core `CompressionDetails`

**Files:**
- Modify: `packages/core/src/modules/janitor/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/modules/janitor/index.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the existing `Janitor — onCompress hook` describe (helpers `buildHistory`/`makeTokenizer` already exist there):

```typescript
it('passes the compressed slice as boundary details', async () => {
  const onCompress = vi.fn();
  const history = buildHistory(5);
  const janitor = new Janitor({
    contextWindow: 30,
    tokenizer: makeTokenizer(10),
    compressionModel: async () => '<history_summary>S</history_summary>',
    onCompress,
  });
  await janitor.compress(history);
  const [, count, details] = onCompress.mock.calls[0];
  expect(details.compressedMessages).toEqual(history.slice(0, count));
  expect(details.compressedMessages).toHaveLength(count);
});

it('passes boundary details in the no-compressionModel fallback too', async () => {
  const onCompress = vi.fn();
  const history = buildHistory(5);
  const janitor = new Janitor({ contextWindow: 30, tokenizer: makeTokenizer(10), onCompress });
  await janitor.compress(history);
  const [, count, details] = onCompress.mock.calls[0];
  expect(details.compressedMessages).toEqual(history.slice(0, count));
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @context-chef/core test -- janitor` (details is undefined).

- [ ] **Step 3: Implement**

3a. In `janitor/index.ts`, define and export:

```typescript
/** Boundary metadata for onCompress — maps the summary back to exact messages. */
export interface CompressionDetails {
  /**
   * The messages removed from history, now represented by the summary:
   * the prefix slice [0, truncatedCount) of the input history (after any
   * onBeforeCompress modification). Match these back to your own store by
   * identity (e.g. tool_call_id) or content — indices into this internal
   * array are deliberately not exposed, since consumers don't hold it.
   * In the no-compressionModel fallback these messages are dropped and the
   * summary message is NOT inserted into the returned history —
   * persistence layers should still record the boundary.
   */
  compressedMessages: Message[];
}
```

3b. Widen the callback signature in `JanitorConfigBase`:

```typescript
  onCompress?: (
    summaryMessage: Message,
    truncatedCount: number,
    details: CompressionDetails,
  ) => void | Promise<void>;
```

(Existing two-param implementations stay assignable — TS allows callbacks declaring fewer params.)

3c. In `executeCompression`, both call sites pass the third arg. Fallback branch:

```typescript
      await this.config.onCompress(
        { role: 'system', content: Prompts.getFallbackCompressionSummary(toCompress.length) },
        toCompress.length,
        { compressedMessages: toCompress },
      );
```

Model branch:

```typescript
    if (this.config.onCompress) {
      await this.config.onCompress(summaryMessage, toCompress.length, {
        compressedMessages: toCompress,
      });
    }
```

3d. In `packages/core/src/index.ts`:
- Event bridge: `onCompress: async (summary, truncatedCount, details) => { if (userOnCompress) await userOnCompress(summary, truncatedCount, details); await this.emitter.emit('compress', { summary, truncatedCount, details }, this._currentSignal); }`.
- `ChefEvents.compress` payload gains `details: CompressionDetails;`.
- Add `CompressionDetails` to the janitor type re-exports (`export { ... type JanitorConfig, ... } from './modules/janitor'` block).

- [ ] **Step 4: Run** — `pnpm --filter @context-chef/core test && pnpm --filter @context-chef/core typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/janitor/index.ts packages/core/src/index.ts packages/core/src/modules/janitor/index.test.ts
git commit -m "feat(core): onCompress receives CompressionDetails boundary metadata"
```

### Task 7: ai-sdk bridge for `CompressionDetails`

**Files:**
- Modify: `packages/ai-sdk-middleware/src/types.ts`
- Modify: `packages/ai-sdk-middleware/src/middleware.ts`
- Test: `packages/ai-sdk-middleware/src/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

The middleware tests already have a compression scenario with an `onCompress` spy — extend or clone it:

```typescript
it('onCompress receives the compressed slice in AI SDK format', async () => {
  // reuse the existing compression test setup (fake model + feedTokenUsage flow)
  // with onCompress: spy
  const [, , details] = spy.mock.calls[0];
  expect(Array.isArray(details.compressedMessages)).toBe(true);
  expect(details.compressedMessages.length).toBeGreaterThan(0);
  expect(details.compressedMessages[0]).toHaveProperty('role');
  expect(details.compressedMessages[0]).toHaveProperty('content');
});
```

- [ ] **Step 2: Run, verify FAIL** (third arg undefined).

- [ ] **Step 3: Implement**

3a. `types.ts` — replace the `onCompress` member:

```typescript
  /**
   * Hook called after compression occurs.
   *
   * `details.compressedMessages` is the exact prompt slice (AI SDK format)
   * that the summary replaced — the precise boundary for persisting the
   * summary as a marker in your own store. These are the post-transform
   * messages (after truncate/compact): match tool messages back to your
   * records by `toolCallId`; user/assistant text is not modified by those
   * steps.
   */
  onCompress?: (
    summary: string,
    truncatedCount: number,
    details: { compressedMessages: LanguageModelV3Prompt },
  ) => void;
```

(`LanguageModelV3Prompt` is already imported in this file for `transformContext`.)

3b. `middleware.ts` — bridge in `createJanitor` becomes:

```typescript
    onCompress: options.onCompress
      ? (summary: Message, count: number, details: CompressionDetails) =>
          options.onCompress?.(summary.content, count, {
            compressedMessages: toAISDK(details.compressedMessages),
          })
      : undefined,
```

Add `type CompressionDetails` to the `@context-chef/core` import on line 7. `toAISDK` is already imported.

- [ ] **Step 4: Run** — package test + typecheck. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-middleware/src
git commit -m "feat(ai-sdk-middleware): expose compression boundary via onCompress details"
```

### Task 8: tanstack bridge for `CompressionDetails` (mirror of Task 7)

**Files:**
- Modify: `packages/tanstack-ai/src/types.ts`
- Modify: `packages/tanstack-ai/src/middleware.ts`
- Test: `packages/tanstack-ai/src/middleware.test.ts`

- [ ] **Step 1–5:** Same flow. Types (tanstack `types.ts:169`):

```typescript
  onCompress?: (
    summary: string,
    truncatedCount: number,
    details: { compressedMessages: ModelMessage[] },
  ) => void;
```

(same JSDoc as Task 7 adapted to "TanStack format"; `ModelMessage` is already imported in that file — verify, else import from `@tanstack/ai`.) Bridge in `sharedJanitorConfig` (middleware.ts:50-52):

```typescript
    onCompress: options.onCompress
      ? (summary: Message, count: number, details: CompressionDetails) =>
          options.onCompress?.(summary.content, count, {
            compressedMessages: toTanStackAI(details.compressedMessages),
          })
      : undefined,
```

(`toTanStackAI` is already imported in middleware.ts; add `type CompressionDetails` to the core import.)

```bash
git add packages/tanstack-ai/src
git commit -m "feat(tanstack-ai): expose compression boundary via onCompress details"
```

**Phase C gate:** root `pnpm lint && pnpm typecheck`, report, STOP, wait for approval.

---

## Phase D — #3 Placeholder-style `clear` in middlewares

**Design decisions (locked):**
- Extract `Janitor.compact`'s body as a pure exported function `compactMessages(history, options)` — verified it touches no instance state.
- Middleware option is named `clear?: ClearTarget[]` (NOT overloading the existing `compact`, which keeps AI SDK pruneMessages deletion semantics).
- `clear` runs AFTER `janitor.compress` — core's own docs warn that clearing tool results before compression starves the summarizer (core `types/index.ts:114-116`). After-compress order means the summarizer sees full content and placeholders only affect the kept tail.
- When `clear` targets tool results, auto-inject `Prompts.TOOL_RESULT_CLEARED_INSTRUCTION` as a system message — fulfilling the promise its doc comment already makes ("Auto-injected by the middleware") that nothing currently implements.
- Placeholder survives both adapters' round-trips via the `_originalText !== content` rebuild branch (verified for ai-sdk `adapter.ts:183` and tanstack `adapter.ts:96`).

### Task 9: core — extract pure `compactMessages` + first-ever compact tests

**Files:**
- Modify: `packages/core/src/modules/janitor/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/modules/janitor/index.test.ts`

- [ ] **Step 1: Write the failing tests** (compact currently has NO coverage):

```typescript
import { compactMessages } from './index'; // alongside the existing Janitor import

describe('compactMessages (pure)', () => {
  const history: Message[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1', thinking: 'hmm' },
    { role: 'tool', content: 'result-1', tool_call_id: 't1' },
    { role: 'user', content: 'q2' },
    { role: 'tool', content: 'result-2', tool_call_id: 't2' },
  ];

  it('replaces tool result content with the placeholder, keeping the message', () => {
    const out = compactMessages(history, { clear: ['tool-result'] });
    expect(out).toHaveLength(5);
    expect(out[2].content).toBe('[Old tool result content cleared]');
    expect(out[4].content).toBe('[Old tool result content cleared]');
    expect(out[2].tool_call_id).toBe('t1');
  });

  it('keepRecent preserves the N most recent tool results', () => {
    const out = compactMessages(history, { clear: [{ target: 'tool-result', keepRecent: 1 }] });
    expect(out[2].content).toBe('[Old tool result content cleared]');
    expect(out[4].content).toBe('result-2');
  });

  it('clears thinking without touching content', () => {
    const out = compactMessages(history, { clear: ['thinking'] });
    expect(out[1].thinking).toBeUndefined();
    expect(out[1].content).toBe('a1');
    expect(out[2].content).toBe('result-1');
  });

  it('does not mutate the input array', () => {
    compactMessages(history, { clear: ['tool-result'] });
    expect(history[2].content).toBe('result-1');
  });
});
```

(Adjust the `thinking` field shape to whatever the IR `Message` type declares — check `types/index.ts` before writing; the Janitor code reads `msg.thinking || msg.redacted_thinking`.)

- [ ] **Step 2: Run, verify FAIL** — `compactMessages` is not exported.

- [ ] **Step 3: Implement**

Move the body of `Janitor.compact` (janitor/index.ts:453-507) verbatim into a module-level export in the same file:

```typescript
/**
 * Pure implementation behind {@link Janitor.compact}: replaces cleared
 * content with placeholders instead of deleting messages, preserving
 * structure and tool-call pairing. Usable without a Janitor instance.
 */
export function compactMessages(history: Message[], options: CompactOptions): Message[] {
  // ← exact body moved from Janitor.compact, unchanged
}
```

`Janitor.compact` keeps its public JSDoc and becomes:

```typescript
  public compact(history: Message[], options: CompactOptions): Message[] {
    return compactMessages(history, options);
  }
```

In `packages/core/src/index.ts`, add `compactMessages` to the janitor export block (next to `Janitor`, `groupIntoTurns`).

- [ ] **Step 4: Run** — core test + typecheck. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modules/janitor/index.ts packages/core/src/index.ts packages/core/src/modules/janitor/index.test.ts
git commit -m "feat(core): export pure compactMessages, add compact test coverage"
```

### Task 10: ai-sdk `clear` option

**Files:**
- Modify: `packages/ai-sdk-middleware/src/types.ts`
- Modify: `packages/ai-sdk-middleware/src/middleware.ts`
- Test: `packages/ai-sdk-middleware/src/middleware.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('clear: replaces old tool results with placeholders and injects the explainer', async () => {
  const middleware = createMiddleware({
    clear: [{ target: 'tool-result', keepRecent: 1 }],
  });
  // Build a prompt with two tool messages (reuse the file's prompt fixtures),
  // run transformParams, then inspect the result:
  const toolMsgs = result.prompt.filter((m) => m.role === 'tool');
  expect(toolMsgs).toHaveLength(2); // structure preserved — nothing deleted
  const firstOutput = toolMsgs[0].content[0];
  expect(firstOutput.output.value).toBe('[Old tool result content cleared]');
  const lastOutput = toolMsgs[1].content[0];
  expect(lastOutput.output.value).toBe('full recent result'); // keepRecent intact
  const sysTexts = result.prompt.filter((m) => m.role === 'system').map((m) => m.content);
  expect(sysTexts.some((t) => t.includes('automatically cleared'))).toBe(true);
});

it('clear without tool-result targets does not inject the explainer', async () => {
  const middleware = createMiddleware({ clear: ['thinking'] });
  // run transformParams on a plain prompt; assert no system message contains 'automatically cleared'
});
```

- [ ] **Step 2: Run, verify FAIL** — `clear` is not an option.

- [ ] **Step 3: Implement**

3a. `types.ts` — add to `ContextChefOptions` (import `type ClearTarget` from `@context-chef/core`):

```typescript
  /**
   * Placeholder-style clearing with @context-chef/core `Janitor.compact`
   * semantics: cleared tool results / thinking are replaced with
   * placeholders ('[Old tool result content cleared]') instead of being
   * deleted — message structure and tool-call pairing stay intact, unlike
   * `compact` (AI SDK pruneMessages), which removes content outright.
   *
   * Runs AFTER compression, so the summarizer still sees full tool output.
   * When tool results are targeted, a system message explaining the
   * placeholder is auto-injected so the model doesn't read it as an error.
   *
   * Note: with `{ target: 'tool-result', keepRecent: N }`, the clearing
   * boundary advances each turn, which invalidates the provider prefix
   * cache at the first newly-cleared message — inherent to the semantics.
   */
  clear?: ClearTarget[];
```

3b. `middleware.ts`:
- Extend the core import (line 7): `import { compactMessages, type CompressionDetails, Janitor, type Message, Prompts, XmlGenerator } from '@context-chef/core';` (keep whatever Task 7 already added).
- In `createMiddleware`, before the returned object:

```typescript
  const clearsToolResults = !!options.clear?.some(
    (t) => t === 'tool-result' || (typeof t === 'object' && t.target === 'tool-result'),
  );
```

- In `transformParams`, after the compress step (step 4) and before reassembly (step 5):

```typescript
      // 4.5 Placeholder-style clearing (core semantics) — after compress so
      // the summarizer saw full content; placeholders only hit the kept tail.
      if (options.clear?.length) {
        conversation = compactMessages(conversation, { clear: options.clear });
      }
```

- Reassembly (current line 79) becomes:

```typescript
      const clearNotice: Message[] = clearsToolResults
        ? [{ role: 'system', content: Prompts.TOOL_RESULT_CLEARED_INSTRUCTION }]
        : [];
      const irMessages = [...systemMessages, ...clearNotice, ...skillMessages, ...conversation];
```

3c. Also update the "any of them signals compression intent" gating comment if needed — `clear` does NOT require `contextWindow` (no budget involved); verify the constructor throw-guard doesn't catch it (it only checks compress/onCompress/onBeforeCompress/onBudgetExceeded — `clear` stays outside, correct as-is).

- [ ] **Step 4: Run** — package test + typecheck. Expected: PASS. The round-trip placeholder survival is implicitly covered (test asserts the final AI SDK prompt).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-middleware/src
git commit -m "feat(ai-sdk-middleware): placeholder-style clear option with auto-injected explainer"
```

### Task 11: tanstack `clear` option (mirror of Task 10)

**Files:**
- Modify: `packages/tanstack-ai/src/types.ts`
- Modify: `packages/tanstack-ai/src/middleware.ts`
- Test: `packages/tanstack-ai/src/middleware.test.ts`

- [ ] **Step 1–5:** Same flow with two structural differences:

1. tanstack has a local `compactMessages` (its own deletion-style pruning in `./compact`) — alias the core import:

```typescript
import {
  compactMessages as clearMessages,
  type CompressionDetails,
  Janitor,
  type Message,
  Prompts,
} from '@context-chef/core';
```

2. tanstack system prompts live in `systemPrompts: string[]`, not in messages. In `onConfig`, after step 4 (compress) and before step 5 (convert back):

```typescript
      // 4.5 Placeholder-style clearing (core semantics)
      if (options.clear?.length) {
        irMessages = clearMessages(irMessages, { clear: options.clear });
      }
```

And before step 6 (skill injection):

```typescript
      if (clearsToolResults) {
        systemPrompts = [...systemPrompts, Prompts.TOOL_RESULT_CLEARED_INSTRUCTION];
      }
```

with the same `clearsToolResults` computation at the top of `contextChefMiddleware`. Types JSDoc identical to Task 10.

Test mirrors Task 10 assertions against TanStack message shapes (tool message content survives as placeholder text; `systemPrompts` gains the explainer).

```bash
git add packages/tanstack-ai/src
git commit -m "feat(tanstack-ai): placeholder-style clear option with auto-injected explainer"
```

**Phase D gate:** report, STOP, wait for approval.

---

## Final verification & release prep

### Task 12: full-repo verification + changeset (gated)

- [ ] **Step 1:** Run at repo root:

```bash
pnpm typecheck && pnpm test && pnpm lint
```

Expected: all PASS. Fix anything that fails before proceeding (biome may want formatting — `pnpm lint:fix`).

- [ ] **Step 2:** Per the project's release policy (batch until told to ship): DO NOT create a changeset yet. Report completion and show the draft below; create `.changeset/vfs-logger-boundary-clear.md` only when the user says ship:

```markdown
---
'@context-chef/core': minor
'@context-chef/ai-sdk-middleware': minor
'@context-chef/tanstack-ai': minor
---

Content-addressed VFS filenames (byte-stable truncation markers, idempotent writes, optional `exists()` on storage adapters); optional `logger` hook threaded through all packages; `onCompress` now receives `CompressionDetails` (`compressedMessages` — the exact slice the summary replaced) for precise persistence boundaries; new placeholder-style `clear` option in both middlewares (core `Janitor.compact` semantics) with auto-injected `TOOL_RESULT_CLEARED_INSTRUCTION`.
```

(Verify the three package names from each `package.json` before writing the changeset.)

- [ ] **Step 3:** Do not push or open a PR unless the user asks.

---

## Out of scope (explicitly)

- **#4 dynamicState null sentinel** — deferred with the dynamicState feature itself. When picked up later, note: the fix must be an explicit skip in `injectDynamicState` (middleware), not just a type change — `objectToXml(null)` already returns `''` but the injection block is appended unconditionally.
- Migration/cleanup of already-written legacy `vfs_<ts>_<hash>.txt` files — they keep resolving and reconciling; eviction retires them naturally where configured.
- Any `pruneMessages`-path changes — the existing `compact` option's deletion semantics are intentionally untouched.
