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

  it('should offload large content and preserve last 20 lines by default', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1} of the long log file that goes on and on.`,
    );
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText);

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toMatch(/^context:\/\/vfs\/vfs_.*\.txt$/);

    // Default tailLines=20, so last lines are included
    expect(result.content).toContain('Line 50');
    expect(result.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(result.content).toContain('has been truncated and offloaded to VFS');
  });

  it('should offload with tailLines: 0 (no tail preserved)', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1} of the long log file that goes on and on.`,
    );
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText, { tailLines: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(result.content).toContain('has been truncated and offloaded to VFS');
    expect(result.content).not.toContain('Line 50');
  });

  it('should respect custom tailLines value', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const largeText = lines.join('\n');

    const result = offloader.offload(largeText, { tailLines: 3 });

    expect(result.isOffloaded).toBe(true);
    expect(result.content).toContain('Line 48');
    expect(result.content).toContain('Line 49');
    expect(result.content).toContain('Line 50');
    expect(result.content).not.toContain('Line 47');
  });

  it('should resolve a valid URI back to full content', () => {
    const largeText = 'A'.repeat(100);
    const result = offloader.offload(largeText, { tailLines: 0 });

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toBeDefined();

    const resolved = result.uri ? offloader.resolve(result.uri) : null;
    expect(resolved).toBe(largeText);
  });

  it('should return null for invalid or missing URIs', () => {
    expect(offloader.resolve('context://vfs/does_not_exist.txt')).toBeNull();
    expect(offloader.resolve('http://example.com')).toBeNull();
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
        asyncOffloader.offload(largeText);
      }).toThrow(
        'Offloader.offload() was called synchronously, but the VFSStorageAdapter is asynchronous. Use offloadAsync() instead.',
      );
    });

    it('should offloadAsync and resolveAsync via the custom adapter', async () => {
      const largeText = 'B'.repeat(100);
      const result = await asyncOffloader.offloadAsync(largeText, { tailLines: 0 });

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
      const resolved = await asyncOffloader.resolveAsync(result.uri);
      expect(resolved).toBe(largeText);
    });
  });
});
