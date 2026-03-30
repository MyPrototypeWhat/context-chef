import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Offloader, type VFSStorageAdapter } from '.';

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
});
