import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileSystemAdapter,
  Offloader,
  VFSCleanupNotSupportedError,
  type VFSEntryMeta,
  type VFSEvictionReason,
  type VFSStorageAdapter,
} from '.';

describe('Offloader', () => {
  const TEST_DIR = path.join(process.cwd(), '.test_vfs');
  let offloader: Offloader;

  beforeEach(() => {
    offloader = new Offloader({
      storageDir: TEST_DIR,
      threshold: 50, // Very small threshold for testing
    });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should not offload small content', () => {
    const smallText = 'Hello world!';
    const result = offloader.offload(smallText);

    expect(result.isOffloaded).toBe(false);
    expect(result.content).toBe(smallText);
    expect(result.uri).toBeUndefined();
  });

  it('should offload large content and preserve tail by default', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1} of the long log file that goes on and on.`,
    );
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText);

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toMatch(/^context:\/\/vfs\/vfs_.*\.txt$/);

    // Default tailChars=2000, so last lines are included
    expect(result.content).toContain('Line 50');
    expect(result.content).toContain('output truncated');
    expect(result.content).toContain('Full output:');
  });

  it('should offload with tailChars: 0 and headChars: 0 (no content preserved)', () => {
    const largeText = 'A'.repeat(100);

    const result = offloader.offload(largeText, { tailChars: 0, headChars: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('output truncated');
    expect(result.content).toContain('100 chars');
    expect(result.content).not.toContain('AAAA');
  });

  it('should preserve head content when headChars is set', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText, { headChars: 30, tailChars: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('Line 1');
    expect(result.content).toContain('output truncated');
    expect(result.content).not.toContain('Line 50');
  });

  it('should preserve both head and tail content', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText, { headChars: 30, tailChars: 30 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('Line 1');
    expect(result.content).toContain('Line 50');
    expect(result.content).toContain('output truncated');
  });

  it('should not offload when headChars + tailChars cover entire content', () => {
    const text = 'A'.repeat(80); // over threshold (50) but headChars + tailChars covers it

    const result = offloader.offload(text, { headChars: 40, tailChars: 40 });

    expect(result.isOffloaded).toBe(false);
    expect(result.content).toBe(text);
  });

  it('should snap to line boundaries', () => {
    // Each line is "Line XX" = 7 chars + newline = 8 chars
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${String(i + 1).padStart(2, '0')}`);
    const largeText = lines.join('\n');

    // Request headChars=10 — should snap to nearest line boundary
    const result = offloader.offload(largeText, { headChars: 10, tailChars: 10 });

    expect(result.isOffloaded).toBe(true);
    // Head should contain complete lines only
    const headPart = result.content.split('--- output truncated')[0];
    // Should not have a partial line
    expect(headPart.trim()).toMatch(/Line \d+$/m);
  });

  it('should include totalLines and totalChars in truncation notice', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText, { tailChars: 10, headChars: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('10 lines');
    expect(result.content).toContain(`${largeText.length} chars`);
  });

  it('should resolve a valid URI back to full content', () => {
    const largeText = 'A'.repeat(100);
    const result = offloader.offload(largeText, { tailChars: 0, headChars: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toBeDefined();

    const resolved = result.uri ? offloader.resolve(result.uri) : null;
    expect(resolved).toBe(largeText);
  });

  it('should return null for invalid or missing URIs', () => {
    expect(offloader.resolve('context://vfs/does_not_exist.txt')).toBeNull();
    expect(offloader.resolve('http://example.com')).toBeNull();
  });

  it('should respect custom threshold per-call', () => {
    const text = 'A'.repeat(80);

    // Instance threshold is 50, but per-call threshold is 100 → should not offload
    const result = offloader.offload(text, { threshold: 100 });
    expect(result.isOffloaded).toBe(false);

    // Per-call threshold 60 → should offload
    const result2 = offloader.offload(text, { threshold: 60, tailChars: 0, headChars: 0 });
    expect(result2.isOffloaded).toBe(true);
  });

  describe('Custom Async Storage Adapter', () => {
    class MockDbAdapter implements VFSStorageAdapter {
      private db = new Map<string, string>();

      async write(filename: string, content: string): Promise<void> {
        return new Promise((resolve) => {
          setTimeout(() => {
            this.db.set(filename, content);
            resolve();
          }, 10);
        });
      }

      async read(filename: string): Promise<string | null> {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(this.db.get(filename) || null);
          }, 10);
        });
      }
    }

    let asyncOffloader: Offloader;

    beforeEach(() => {
      asyncOffloader = new Offloader({
        threshold: 50,
        adapter: new MockDbAdapter(),
      });
    });

    it('should throw an error if calling sync offload() with an async adapter', () => {
      const largeText = 'A'.repeat(100);
      expect(() => {
        asyncOffloader.offload(largeText, { tailChars: 0, headChars: 0 });
      }).toThrow(
        'Offloader.offload() was called synchronously, but the VFSStorageAdapter is asynchronous. Use offloadAsync() instead.',
      );
    });

    it('should offloadAsync and resolveAsync via the custom adapter', async () => {
      const largeText = 'B'.repeat(100);
      const result = await asyncOffloader.offloadAsync(largeText, { tailChars: 0, headChars: 0 });

      expect(result.isOffloaded).toBe(true);
      expect(result.uri).toBeDefined();

      const uri = result.uri;
      if (!uri) throw new Error('URI not defined');

      // Test sync resolve throws
      expect(() => {
        asyncOffloader.resolve(uri);
      }).toThrow(
        'Offloader.resolve() was called synchronously, but the VFSStorageAdapter is asynchronous. Use resolveAsync() instead.',
      );

      // Test async resolve
      const resolved = await asyncOffloader.resolveAsync(uri);
      expect(resolved).toBe(largeText);
    });

    it('should not offload via offloadAsync when under threshold', async () => {
      const smallText = 'small';
      const result = await asyncOffloader.offloadAsync(smallText);

      expect(result.isOffloaded).toBe(false);
      expect(result.content).toBe(smallText);
    });

    it('should not offload via offloadAsync when head+tail covers content', async () => {
      const text = 'A'.repeat(80);
      const result = await asyncOffloader.offloadAsync(text, { headChars: 40, tailChars: 40 });

      expect(result.isOffloaded).toBe(false);
      expect(result.content).toBe(text);
    });
  });

  describe('Cleanup', () => {
    const CLEANUP_DIR = path.join(process.cwd(), '.test_vfs_cleanup');

    // Reusable in-memory adapters for cleanup tests.
    class InMemorySyncAdapter implements VFSStorageAdapter {
      readonly db = new Map<string, string>();
      write(filename: string, content: string): void {
        this.db.set(filename, content);
      }
      read(filename: string): string | null {
        return this.db.get(filename) ?? null;
      }
      list(): string[] {
        return Array.from(this.db.keys());
      }
      delete(filename: string): void {
        this.db.delete(filename);
      }
    }

    class InMemoryAsyncAdapter implements VFSStorageAdapter {
      readonly db = new Map<string, string>();
      async write(filename: string, content: string): Promise<void> {
        this.db.set(filename, content);
      }
      async read(filename: string): Promise<string | null> {
        return this.db.get(filename) ?? null;
      }
      async list(): Promise<string[]> {
        return Array.from(this.db.keys());
      }
      async delete(filename: string): Promise<void> {
        this.db.delete(filename);
      }
    }

    beforeEach(() => {
      if (fs.existsSync(CLEANUP_DIR)) {
        fs.rmSync(CLEANUP_DIR, { recursive: true, force: true });
      }
    });

    afterEach(() => {
      if (fs.existsSync(CLEANUP_DIR)) {
        fs.rmSync(CLEANUP_DIR, { recursive: true, force: true });
      }
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    describe('Capability checks', () => {
      it('cleanup() throws VFSCleanupNotSupportedError with missing=[list, delete] when adapter has neither', () => {
        class NoCapAdapter implements VFSStorageAdapter {
          write(_f: string, _c: string): void {}
          read(_f: string): string | null {
            return null;
          }
        }
        const o = new Offloader({ adapter: new NoCapAdapter(), threshold: 10 });
        let caught: unknown;
        try {
          o.cleanup();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(VFSCleanupNotSupportedError);
        if (!(caught instanceof VFSCleanupNotSupportedError)) {
          throw new Error('expected VFSCleanupNotSupportedError');
        }
        expect(caught.missing).toEqual(['list', 'delete']);
      });

      it('cleanup() throws with missing=[delete] when adapter has only list', () => {
        class OnlyListAdapter implements VFSStorageAdapter {
          write(_f: string, _c: string): void {}
          read(_f: string): string | null {
            return null;
          }
          list(): string[] {
            return [];
          }
        }
        const o = new Offloader({ adapter: new OnlyListAdapter(), threshold: 10 });
        let caught: unknown;
        try {
          o.cleanup();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(VFSCleanupNotSupportedError);
        if (!(caught instanceof VFSCleanupNotSupportedError)) {
          throw new Error('expected VFSCleanupNotSupportedError');
        }
        expect(caught.missing).toEqual(['delete']);
      });

      it('cleanup() throws with missing=[list] when adapter has only delete', () => {
        class OnlyDeleteAdapter implements VFSStorageAdapter {
          write(_f: string, _c: string): void {}
          read(_f: string): string | null {
            return null;
          }
          delete(_f: string): void {}
        }
        const o = new Offloader({ adapter: new OnlyDeleteAdapter(), threshold: 10 });
        let caught: unknown;
        try {
          o.cleanup();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(VFSCleanupNotSupportedError);
        if (!(caught instanceof VFSCleanupNotSupportedError)) {
          throw new Error('expected VFSCleanupNotSupportedError');
        }
        expect(caught.missing).toEqual(['list']);
      });

      it('sync cleanup() on a fully-async adapter throws BEFORE any deletes', () => {
        const deleteSpy = vi.fn(async (_f: string) => {});
        const adapter: VFSStorageAdapter = {
          write: async () => {},
          read: async () => null,
          list: async () => ['vfs_1_aaaaaaaa.txt', 'vfs_2_bbbbbbbb.txt'],
          delete: deleteSpy,
        };
        const o = new Offloader({ adapter, threshold: 10 });
        expect(() => o.cleanup()).toThrow(/Use cleanupAsync\(\) instead/);
        expect(deleteSpy).not.toHaveBeenCalled();
      });

      it('cleanupAsync() works on async adapter; sync cleanup() works on FileSystemAdapter', async () => {
        const asyncAdapter = new InMemoryAsyncAdapter();
        const asyncOffloader = new Offloader({ adapter: asyncAdapter, threshold: 10 });
        await asyncOffloader.offloadAsync('A'.repeat(20), { tailChars: 0 });
        const asyncResult = await asyncOffloader.cleanupAsync({ maxFiles: 0 });
        expect(asyncResult.evicted.length).toBe(1);
        expect(asyncAdapter.db.size).toBe(0);

        const syncOffloader = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        syncOffloader.offload('B'.repeat(20), { tailChars: 0 });
        const syncResult = syncOffloader.cleanup({ maxFiles: 0 });
        expect(syncResult.evicted.length).toBe(1);
      });
    });

    describe('Phase A — maxAge sweep', () => {
      it('evicts only entries older than maxAge', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10, maxAge: 1000 });
        // Pick timestamps so exactly the t=0 entry is past maxAge at t=2000.
        // (2000-0=2000 > 1000 → evict; 2000-1500=500, 2000-1800=200 → keep.)
        o.offload('A'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(1500);
        o.offload('B'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(1800);
        o.offload('C'.repeat(20), { tailChars: 0 });

        vi.setSystemTime(2000);
        const result = o.cleanup();
        expect(result.evictedByAge).toBe(1);
        expect(result.evicted.length).toBe(1);
        expect(result.evicted[0]?.createdAt).toBe(0);
        expect(o.getEntries().length).toBe(2);
      });

      it('with maxAge=undefined, no entries are evicted by age even when arbitrarily old', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        o.offload('A'.repeat(20), { tailChars: 0 });
        o.offload('B'.repeat(20), { tailChars: 0 });

        vi.setSystemTime(10_000_000_000);
        const result = o.cleanup();
        expect(result.evictedByAge).toBe(0);
        expect(result.evicted.length).toBe(0);
        expect(o.getEntries().length).toBe(2);
      });

      it('with maxAge=0, every entry strictly older than now is evicted', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10, maxAge: 0 });
        o.offload('A'.repeat(20), { tailChars: 0 });
        o.offload('B'.repeat(20), { tailChars: 0 });
        o.offload('C'.repeat(20), { tailChars: 0 });

        // Advance even 1ms so now-createdAt > 0 for all.
        vi.advanceTimersByTime(1);
        const result = o.cleanup();
        expect(result.evictedByAge).toBe(3);
        expect(o.getEntries().length).toBe(0);
      });
    });

    describe('Phase B — single-pass LRU', () => {
      it('maxFiles eviction is driven by accessedAt, not createdAt', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10, maxFiles: 3 });
        const uris: string[] = [];
        for (let i = 0; i < 5; i++) {
          vi.setSystemTime(1000 + i * 100);
          // Vary content so hashes/filenames differ even at identical timestamps.
          const r = o.offload(`X${i}`.padEnd(20, String.fromCharCode(65 + i)), { tailChars: 0 });
          uris.push(r.uri ?? '');
        }
        // Entries 0,1 have lowest accessedAt initially. Touch them so 2 and 3 become LRU candidates.
        vi.setSystemTime(2000);
        o.resolve(uris[0] ?? '');
        vi.setSystemTime(2100);
        o.resolve(uris[1] ?? '');

        const result = o.cleanup();
        expect(result.evictedByCount).toBe(2);
        expect(result.evicted.length).toBe(2);
        const evictedFilenames = result.evicted.map((e) => e.filename).sort();
        const expectedFilenames = [
          uris[2]?.replace('context://vfs/', '') ?? '',
          uris[3]?.replace('context://vfs/', '') ?? '',
        ].sort();
        expect(evictedFilenames).toEqual(expectedFilenames);
        expect(o.getEntries().length).toBe(3);
      });

      it('maxBytes uses Buffer.byteLength (UTF-8) not string.length', () => {
        // 12 emoji × 2 chars = 24 chars/entry. 12 emoji × 4 bytes (UTF-8) = 48 bytes/entry.
        // 3 entries: 72 chars total < 100, but 144 bytes total > 100 → cleanup must fire.
        const adapter = new InMemorySyncAdapter();
        const o = new Offloader({ adapter, threshold: 10, maxBytes: 100 });
        const content = '😀'.repeat(12);
        expect(content.length).toBe(24);
        expect(Buffer.byteLength(content, 'utf8')).toBe(48);

        for (let i = 0; i < 3; i++) {
          // Vary content slightly so hashes differ.
          o.offload(content + String.fromCharCode(65 + i), { tailChars: 0 });
        }
        expect(o.getEntries().length).toBe(3);

        const result = o.cleanup();
        expect(result.evictedByBytes).toBeGreaterThan(0);
        // After eviction, total bytes must be ≤ 100.
        const totalBytes = o.getEntries().reduce((sum, e) => sum + e.bytes, 0);
        expect(totalBytes).toBeLessThanOrEqual(100);
      });

      it('maxFiles AND maxBytes both binding: loop terminates and reasons attribute correctly', () => {
        // 5 × 100-byte entries. maxFiles=3, maxBytes=200. Trace:
        // After plan, we expect 2 evicted by maxFiles (count priority), then 1 by maxBytes.
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const o = new Offloader({
          storageDir: CLEANUP_DIR,
          threshold: 10,
          maxFiles: 3,
          maxBytes: 200,
        });
        for (let i = 0; i < 5; i++) {
          vi.setSystemTime(1000 + i * 100);
          o.offload(`A${i}`.padEnd(100, 'x'), { tailChars: 0 });
        }
        const result = o.cleanup();
        expect(result.evictedByCount).toBe(2);
        expect(result.evictedByBytes).toBe(1);
        expect(result.evicted.length).toBe(3);
        // Final state must satisfy both caps.
        const remaining = o.getEntries();
        expect(remaining.length).toBeLessThanOrEqual(3);
        expect(remaining.reduce((s, e) => s + e.bytes, 0)).toBeLessThanOrEqual(200);
      });

      it('maxFiles=0 evicts all entries; maxBytes=0 evicts all entries', () => {
        const adapter1 = new InMemorySyncAdapter();
        const o1 = new Offloader({ adapter: adapter1, threshold: 10 });
        for (let i = 0; i < 3; i++) o1.offload(`A${i}`.padEnd(20, 'x'), { tailChars: 0 });
        const r1 = o1.cleanup({ maxFiles: 0 });
        expect(r1.evicted.length).toBe(3);
        expect(r1.evictedByCount).toBe(3);
        expect(o1.getEntries().length).toBe(0);
        expect(adapter1.db.size).toBe(0);

        const adapter2 = new InMemorySyncAdapter();
        const o2 = new Offloader({ adapter: adapter2, threshold: 10 });
        for (let i = 0; i < 3; i++) o2.offload(`B${i}`.padEnd(20, 'x'), { tailChars: 0 });
        const r2 = o2.cleanup({ maxBytes: 0 });
        expect(r2.evicted.length).toBe(3);
        expect(r2.evictedByBytes).toBe(3);
        expect(o2.getEntries().length).toBe(0);
      });

      it('constructor rejects negative maxFiles/maxAge/maxBytes', () => {
        expect(() => new Offloader({ maxFiles: -1 })).toThrow(/must be non-negative/);
        expect(() => new Offloader({ maxAge: -1 })).toThrow(/must be non-negative/);
        expect(() => new Offloader({ maxBytes: -1 })).toThrow(/must be non-negative/);
      });
    });

    describe('Reason attribution', () => {
      it('mixed run: 2 by age + 1 by count, reasons match per entry in onVFSEvicted', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const calls: { filename: string; reason: VFSEvictionReason }[] = [];
        const o = new Offloader({
          storageDir: CLEANUP_DIR,
          threshold: 10,
          maxAge: 1000,
          maxFiles: 2,
          onVFSEvicted: (entry, reason) => {
            calls.push({ filename: entry.filename, reason });
          },
        });
        // 2 old (past maxAge at t=2500), 3 fresh (within maxAge but maxFiles=2 → 1 LRU evicted).
        vi.setSystemTime(0);
        o.offload('A'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(500);
        o.offload('B'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2000);
        o.offload('C'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2100);
        o.offload('D'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2200);
        o.offload('E'.repeat(20), { tailChars: 0 });

        vi.setSystemTime(2500);
        const result = o.cleanup();
        expect(result.evictedByAge).toBe(2);
        expect(result.evictedByCount).toBe(1);
        expect(result.evictedByBytes).toBe(0);
        expect(result.evicted.length).toBe(3);

        // Hook reasons must mirror counts.
        expect(calls.filter((c) => c.reason === 'maxAge').length).toBe(2);
        expect(calls.filter((c) => c.reason === 'maxFiles').length).toBe(1);
      });
    });

    describe('Hook behavior', () => {
      it('onVFSEvicted is invoked once per evicted entry, in eviction order', () => {
        const adapter = new InMemorySyncAdapter();
        const hook = vi.fn();
        const o = new Offloader({ adapter, threshold: 10, maxFiles: 0, onVFSEvicted: hook });
        const uris: string[] = [];
        for (let i = 0; i < 3; i++) {
          const r = o.offload(`X${i}`.padEnd(20, 'y'), { tailChars: 0 });
          uris.push(r.uri ?? '');
        }
        const result = o.cleanup();
        expect(hook).toHaveBeenCalledTimes(3);
        expect(result.evicted.length).toBe(3);
        // Each call should pass the entry corresponding to result.evicted[i].
        for (let i = 0; i < 3; i++) {
          const callArgs = hook.mock.calls[i];
          expect(callArgs?.[0].filename).toBe(result.evicted[i]?.filename);
          expect(callArgs?.[1]).toBe('maxFiles');
        }
      });

      it('async onVFSEvicted is awaited by cleanupAsync() before next eviction', async () => {
        const order: string[] = [];
        const db = new Map<string, string>();
        const adapter: VFSStorageAdapter = {
          write: async (f, c) => {
            db.set(f, c);
          },
          read: async (f) => db.get(f) ?? null,
          list: async () => Array.from(db.keys()),
          delete: async (f) => {
            order.push(`delete:${f}`);
            db.delete(f);
          },
        };

        const hook = async (entry: VFSEntryMeta) => {
          order.push(`hook-start:${entry.filename}`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`hook-end:${entry.filename}`);
        };
        const o = new Offloader({ adapter, threshold: 10, maxFiles: 0, onVFSEvicted: hook });
        await o.offloadAsync('A'.repeat(20), { tailChars: 0 });
        await o.offloadAsync('B'.repeat(20), { tailChars: 0 });

        await o.cleanupAsync();
        expect(order.length).toBe(6);
        expect(order[0]).toMatch(/^delete:/);
        expect(order[1]).toMatch(/^hook-start:/);
        expect(order[2]).toMatch(/^hook-end:/);
        expect(order[3]).toMatch(/^delete:/);
        expect(order[4]).toMatch(/^hook-start:/);
        expect(order[5]).toMatch(/^hook-end:/);
        // Verify hook A actually completed before delete B started (proving await).
        const firstFile = order[0]?.replace('delete:', '') ?? '';
        const secondFile = order[3]?.replace('delete:', '') ?? '';
        expect(firstFile).not.toBe(secondFile);
        expect(order[2]).toBe(`hook-end:${firstFile}`);
        expect(order[3]).toBe(`delete:${secondFile}`);
      });

      it('throwing onVFSEvicted logs warning, eviction continues, entry IS removed', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const adapter = new InMemorySyncAdapter();
        const hook = vi.fn(() => {
          throw new Error('hook boom');
        });
        const o = new Offloader({ adapter, threshold: 10, maxFiles: 0, onVFSEvicted: hook });
        const r1 = o.offload('A'.repeat(20), { tailChars: 0 });
        const r2 = o.offload('B'.repeat(20), { tailChars: 0 });

        const result = o.cleanup();
        expect(result.evicted.length).toBe(2);
        expect(hook).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('onVFSEvicted threw');
        // Index empty AND adapter empty.
        expect(o.getEntries().length).toBe(0);
        expect(o.resolve(r1.uri ?? '')).toBeNull();
        expect(o.resolve(r2.uri ?? '')).toBeNull();
        expect(adapter.db.size).toBe(0);
      });
    });

    describe('Index lifecycle', () => {
      it('offload() registers a single entry with accurate UTF-8 bytes and timestamps near now', () => {
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 50 });
        const content = '你好'.repeat(50); // 100 chars, 300 UTF-8 bytes
        const before = Date.now();
        const result = o.offload(content, { tailChars: 0 });
        const after = Date.now();
        expect(result.isOffloaded).toBe(true);

        const snapshot = o.getEntries();
        expect(snapshot.length).toBe(1);
        expect(snapshot[0]?.bytes).toBe(Buffer.byteLength(content, 'utf8'));
        expect(snapshot[0]?.bytes).toBe(300);
        expect(snapshot[0]?.createdAt).toBeGreaterThanOrEqual(before);
        expect(snapshot[0]?.createdAt).toBeLessThanOrEqual(after);
        expect(snapshot[0]?.accessedAt).toBe(snapshot[0]?.createdAt);
      });

      it('resolve() updates accessedAt on hit; missing URI does not touch any entry', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        const r = o.offload('A'.repeat(20), { tailChars: 0 });
        const snap1 = o.getEntries()[0];
        expect(snap1?.accessedAt).toBe(1000);

        vi.advanceTimersByTime(100);
        o.resolve(r.uri ?? '');
        const snap2 = o.getEntries()[0];
        expect(snap2?.accessedAt).toBe(1100);

        vi.advanceTimersByTime(100);
        // Resolve a URI that doesn't exist: must NOT touch the existing entry's accessedAt.
        const missing = o.resolve('context://vfs/vfs_999_zzzzzzzz.txt');
        expect(missing).toBeNull();
        const snap3 = o.getEntries()[0];
        expect(snap3?.accessedAt).toBe(1100);
      });

      it('resolveAsync() updates accessedAt symmetrically with the async path', async () => {
        const adapter = new InMemoryAsyncAdapter();
        const o = new Offloader({ adapter, threshold: 10 });
        const r = await o.offloadAsync('A'.repeat(20), { tailChars: 0 });
        const snap1 = o.getEntries()[0];

        // Wait a real interval to guarantee accessedAt advances.
        await new Promise((res) => setTimeout(res, 50));
        await o.resolveAsync(r.uri ?? '');
        const snap2 = o.getEntries()[0];
        expect(snap2?.accessedAt).toBeGreaterThan(snap1?.accessedAt ?? 0);
        expect((snap2?.accessedAt ?? 0) - (snap1?.accessedAt ?? 0)).toBeGreaterThanOrEqual(40);
      });

      it('resolve() of a URI not in the index but on the adapter auto-adopts it', () => {
        const adapter = new FileSystemAdapter(CLEANUP_DIR);
        const o = new Offloader({ adapter, threshold: 10 });
        // Write directly via adapter, bypassing offload().
        const filename = 'vfs_5000_aabbccdd.txt';
        const content = 'orphan content';
        adapter.write(filename, content);
        expect(o.getEntries().length).toBe(0);

        const resolved = o.resolve(`context://vfs/${filename}`);
        expect(resolved).toBe(content);

        const snap = o.getEntries();
        expect(snap.length).toBe(1);
        expect(snap[0]?.filename).toBe(filename);
        expect(snap[0]?.createdAt).toBe(5000); // parsed from filename
        expect(snap[0]?.bytes).toBe(Buffer.byteLength(content, 'utf8'));
      });
    });

    describe('Cleanup overrides', () => {
      it('cleanup({ maxAge }) override beats configured maxAge', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const o = new Offloader({
          storageDir: CLEANUP_DIR,
          threshold: 10,
          maxAge: 60_000, // configured: 1 minute
        });
        o.offload('A'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(800);
        o.offload('B'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2000);

        // With configured maxAge=60_000, nothing should evict yet.
        const noOverride = o.cleanup();
        expect(noOverride.evictedByAge).toBe(0);

        // Override to maxAge=500 → both entries are now past cap (2000-0>500, 2000-800>500).
        const overridden = o.cleanup({ maxAge: 500 });
        expect(overridden.evictedByAge).toBe(2);
      });

      it('per-field override defaults to configured value for omitted fields', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const o = new Offloader({
          storageDir: CLEANUP_DIR,
          threshold: 10,
          maxAge: 1000,
          maxFiles: 10, // very loose
        });
        o.offload('A'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(500);
        o.offload('B'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2500); // both past maxAge=1000

        // Override maxFiles only; configured maxAge=1000 must still apply.
        const result = o.cleanup({ maxFiles: 2 });
        expect(result.evictedByAge).toBe(2);
        expect(o.getEntries().length).toBe(0);
      });
    });

    describe('Failure handling', () => {
      it('delete() throws on one entry midway; other entries still evicted; failure recorded', () => {
        const db = new Map<string, string>();
        let failFilename = '';
        const adapter: VFSStorageAdapter = {
          write: (f, c) => {
            db.set(f, c);
          },
          read: (f) => db.get(f) ?? null,
          list: () => Array.from(db.keys()),
          delete: (f) => {
            if (f === failFilename) throw new Error('delete refused');
            db.delete(f);
          },
        };
        const o = new Offloader({ adapter, threshold: 10, maxFiles: 0 });
        const r1 = o.offload('A'.repeat(20), { tailChars: 0 });
        const r2 = o.offload('B'.repeat(20), { tailChars: 0 });
        const r3 = o.offload('C'.repeat(20), { tailChars: 0 });
        // Force failure on the middle entry.
        failFilename = r2.uri?.replace('context://vfs/', '') ?? '';

        const result = o.cleanup();
        expect(result.evicted.length).toBe(2);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0]?.entry.filename).toBe(failFilename);
        expect(result.failed[0]?.error.message).toContain('delete refused');

        // Failed entry remains in index AND in adapter.
        const snapshot = o.getEntries();
        expect(snapshot.length).toBe(1);
        expect(snapshot[0]?.filename).toBe(failFilename);
        expect(db.has(failFilename)).toBe(true);
        // Successful evictions actually went away.
        expect(db.has(r1.uri?.replace('context://vfs/', '') ?? '')).toBe(false);
        expect(db.has(r3.uri?.replace('context://vfs/', '') ?? '')).toBe(false);
      });

      it('list() throws → cleanup propagates; index unchanged', () => {
        const adapter = new FileSystemAdapter(CLEANUP_DIR);
        const o = new Offloader({ adapter, threshold: 10 });
        o.offload('A'.repeat(20), { tailChars: 0 });
        const before = o.getEntries();

        // Replace list with a thrower.
        adapter.list = () => {
          throw new Error('list failed');
        };
        expect(() => o.cleanup()).toThrow('list failed');
        expect(o.getEntries()).toEqual(before);
      });
    });

    describe('reconcile() and reconcileAsync()', () => {
      it('after restart equivalent: reconcile() adopts all on-disk files with createdAt parsed from filename', () => {
        // Phase 1: write 3 files with Offloader A.
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const a = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        a.offload('A'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(2000);
        a.offload('B'.repeat(20), { tailChars: 0 });
        vi.setSystemTime(3000);
        a.offload('C'.repeat(20), { tailChars: 0 });
        const filesOnDisk = fs.readdirSync(CLEANUP_DIR).sort();
        expect(filesOnDisk.length).toBe(3);

        // Phase 2: discard A, build B with same dir + fresh empty index, then reconcile.
        vi.setSystemTime(99_999); // reconcile time differs from createdAts
        const b = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        expect(b.getEntries().length).toBe(0);
        const adopted = b.reconcile();
        expect(adopted).toBe(3);
        const snapshot = b.getEntries();
        expect(snapshot.length).toBe(3);
        // createdAts must equal the embedded timestamps (1000/2000/3000), NOT 99_999.
        const createdAts = snapshot.map((e) => e.createdAt).sort((x, y) => x - y);
        expect(createdAts).toEqual([1000, 2000, 3000]);
      });

      it('reconcile({ measureBytes: true }) populates accurate UTF-8 bytes', () => {
        const a = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        const content = '你'.repeat(40); // 40 chars, 120 UTF-8 bytes
        a.offload(content, { tailChars: 0 });

        const b = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        const adopted = b.reconcile({ measureBytes: true });
        expect(adopted).toBe(1);
        const snap = b.getEntries();
        expect(snap[0]?.bytes).toBe(Buffer.byteLength(content, 'utf8'));
        expect(snap[0]?.bytes).toBe(120);
      });

      it('reconcile() is idempotent on repeated calls', () => {
        const a = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        a.offload('A'.repeat(20), { tailChars: 0 });
        a.offload('B'.repeat(20), { tailChars: 0 });

        const b = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        expect(b.reconcile()).toBe(2);
        expect(b.reconcile()).toBe(0);
        expect(b.reconcile()).toBe(0);
        expect(b.getEntries().length).toBe(2);
      });

      it('end-to-end: write, restart, reconcile, then cleanup({ maxAge: 0 }) wipes disk', () => {
        const a = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        a.offload('A'.repeat(20), { tailChars: 0 });
        a.offload('B'.repeat(20), { tailChars: 0 });
        a.offload('C'.repeat(20), { tailChars: 0 });
        expect(fs.readdirSync(CLEANUP_DIR).length).toBe(3);

        const b = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        b.reconcile();
        // Sleep 1ms so all createdAts are < now, then cleanup with maxAge=0 evicts everything.
        const start = Date.now();
        while (Date.now() === start) {
          // tight wait - typically completes within a tick
        }
        const result = b.cleanup({ maxAge: 0 });
        expect(result.evicted.length).toBe(3);
        expect(b.getEntries().length).toBe(0);
        // Disk must be empty (only files starting with vfs_ were on disk; cleanup deleted them).
        const remaining = fs.readdirSync(CLEANUP_DIR).filter((f) => f.startsWith('vfs_'));
        expect(remaining.length).toBe(0);
      });

      it('malformed filename matching prefix but failing the regex falls back to Date.now() for createdAt', () => {
        fs.mkdirSync(CLEANUP_DIR, { recursive: true });
        // FileSystemAdapter.list filters by `vfs_` prefix; this matches but fails the orphan regex.
        fs.writeFileSync(path.join(CLEANUP_DIR, 'vfs_NOTANUMBER_abc.txt'), 'content');

        vi.useFakeTimers();
        vi.setSystemTime(99_999);
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10 });
        const adopted = o.reconcile();
        expect(adopted).toBe(1);
        const snap = o.getEntries();
        expect(snap[0]?.filename).toBe('vfs_NOTANUMBER_abc.txt');
        expect(snap[0]?.createdAt).toBe(99_999); // fallback Date.now()
      });
    });

    describe('Concurrency', () => {
      it('overlapping cleanupAsync() calls are coalesced into a single in-flight promise', async () => {
        const db = new Map<string, string>();
        const deleteCalls: string[] = [];
        const adapter: VFSStorageAdapter = {
          write: async (f, c) => {
            db.set(f, c);
          },
          read: async (f) => db.get(f) ?? null,
          list: async () => Array.from(db.keys()),
          delete: async (f) => {
            deleteCalls.push(f);
            await new Promise((r) => setTimeout(r, 30));
            db.delete(f);
          },
        };
        const o = new Offloader({ adapter, threshold: 10, maxFiles: 0 });
        await o.offloadAsync('A'.repeat(20), { tailChars: 0 });
        await o.offloadAsync('B'.repeat(20), { tailChars: 0 });

        const p1 = o.cleanupAsync();
        const p2 = o.cleanupAsync();
        expect(p1).toBe(p2); // same Promise reference
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe(r2);
        expect(r1.evicted.length).toBe(2);
        // delete called exactly twice (once per entry), not 4 times.
        expect(deleteCalls.length).toBe(2);
      });

      it('offloadAsync during cleanupAsync does not crash; new entry survives', async () => {
        const db = new Map<string, string>();
        const adapter: VFSStorageAdapter = {
          write: async (f, c) => {
            db.set(f, c);
          },
          read: async (f) => db.get(f) ?? null,
          list: async () => Array.from(db.keys()),
          delete: async (f) => {
            await new Promise((r) => setTimeout(r, 30));
            db.delete(f);
          },
        };
        const o = new Offloader({ adapter, threshold: 10 });
        await o.offloadAsync('A'.repeat(20), { tailChars: 0 });
        await o.offloadAsync('B'.repeat(20), { tailChars: 0 });
        expect(o.getEntries().length).toBe(2);

        const cleanupPromise = o.cleanupAsync({ maxFiles: 0 });
        // Add a new entry mid-cleanup. Since the plan was snapshotted before,
        // this entry should NOT be in the eviction plan.
        const r3 = await o.offloadAsync('C'.repeat(20), { tailChars: 0 });

        const result = await cleanupPromise;
        expect(result.evicted.length).toBe(2);

        const snapshot = o.getEntries();
        expect(snapshot.length).toBe(1);
        const newFilename = r3.uri?.replace('context://vfs/', '') ?? '';
        expect(snapshot[0]?.filename).toBe(newFilename);
        expect(db.has(newFilename)).toBe(true);
      });
    });

    describe('Misc', () => {
      it('cleanup works with a custom uriScheme; adapter sees only filenames; evicted URIs use custom scheme', () => {
        const adapter = new InMemorySyncAdapter();
        const o = new Offloader({
          adapter,
          threshold: 10,
          uriScheme: 'mystore://',
          maxFiles: 0,
        });
        const r = o.offload('A'.repeat(20), { tailChars: 0 });
        expect(r.uri).toMatch(/^mystore:\/\/vfs_/);

        // Filenames stored on the adapter must NOT include the scheme.
        const stored = Array.from(adapter.db.keys());
        expect(stored.length).toBe(1);
        expect(stored[0]).toMatch(/^vfs_\d+_[a-f0-9]+\.txt$/);
        expect(stored[0]).not.toContain('mystore');

        const result = o.cleanup();
        expect(result.evicted.length).toBe(1);
        expect(result.evicted[0]?.uri).toMatch(/^mystore:\/\//);
        expect(adapter.db.size).toBe(0);
      });

      it('after cleanup evicts an entry, resolve() returns null', () => {
        const o = new Offloader({ storageDir: CLEANUP_DIR, threshold: 10, maxFiles: 0 });
        const r = o.offload('A'.repeat(20), { tailChars: 0 });
        expect(o.resolve(r.uri ?? '')).not.toBeNull();
        o.cleanup();
        expect(o.resolve(r.uri ?? '')).toBeNull();
        expect(o.getEntries().length).toBe(0);
      });

      it('FileSystemAdapter.list() returns only files starting with vfs_', () => {
        fs.mkdirSync(CLEANUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(CLEANUP_DIR, 'vfs_1_abcdef00.txt'), 'good');
        fs.writeFileSync(path.join(CLEANUP_DIR, '.DS_Store'), 'system');
        fs.writeFileSync(path.join(CLEANUP_DIR, 'notes.txt'), 'user');
        const adapter = new FileSystemAdapter(CLEANUP_DIR);
        const list = adapter.list();
        expect(list).toContain('vfs_1_abcdef00.txt');
        expect(list).not.toContain('.DS_Store');
        expect(list).not.toContain('notes.txt');
        expect(list.length).toBe(1);
      });

      it('FileSystemAdapter.delete() is idempotent (no throw on already-removed file)', () => {
        const adapter = new FileSystemAdapter(CLEANUP_DIR);
        adapter.write('vfs_1_abcdef00.txt', 'content');
        expect(() => adapter.delete('vfs_1_abcdef00.txt')).not.toThrow();
        expect(() => adapter.delete('vfs_1_abcdef00.txt')).not.toThrow();
        expect(() => adapter.delete('never_existed.txt')).not.toThrow();
      });
    });
  });
});
