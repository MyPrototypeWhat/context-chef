import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pointer, VFSStorageAdapter } from '../src/modules/Pointer';

describe('Pointer (VFS)', () => {
  const TEST_DIR = path.join(process.cwd(), '.test_vfs');
  let pointer: Pointer;

  beforeEach(() => {
    pointer = new Pointer({
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
    const result = pointer.process(smallText, 'log');

    expect(result.isOffloaded).toBe(false);
    expect(result.content).toBe(smallText);
    expect(result.uri).toBeUndefined();
  });

  it('should offload large content and return a truncated pointer', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1} of the long log file that goes on and on.`,
    );
    const largeText = lines.join('\n');

    const result = pointer.process(largeText, 'log');

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toMatch(/^context:\/\/vfs\/log_.*\.txt$/);

    // Check that it kept the last few lines
    expect(result.content).toContain('Line 50');
    // Check for the EPHEMERAL_MESSAGE VFS offload notice
    expect(result.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(result.content).toContain('has been truncated and offloaded to VFS');
  });

  it('should offload large doc content without appending truncated lines', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1} of the long log file that goes on and on.`,
    );
    const largeText = lines.join('\n');

    const result = pointer.process(largeText, 'doc');

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toMatch(/^context:\/\/vfs\/doc_.*\.txt$/);

    // Check for the EPHEMERAL_MESSAGE VFS offload notice
    expect(result.content).toContain('<EPHEMERAL_MESSAGE>');
    expect(result.content).toContain('has been truncated and offloaded to VFS');
    // For 'doc' type, last lines and '...[truncated]...' should NOT be included
    expect(result.content).not.toContain('Line 50');
  });

  it('should resolve a valid URI back to full content', () => {
    const largeText = 'A'.repeat(100);
    const result = pointer.process(largeText, 'doc');

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toBeDefined();

    const resolved = result.uri ? pointer.resolve(result.uri) : null;
    expect(resolved).toBe(largeText);
  });

  it('should return null for invalid or missing URIs', () => {
    expect(pointer.resolve('context://vfs/does_not_exist.txt')).toBeNull();
    expect(pointer.resolve('http://example.com')).toBeNull();
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

    let asyncPointer: Pointer;

    beforeEach(() => {
      asyncPointer = new Pointer({
        threshold: 50,
        adapter: new MockDbAdapter(),
      });
    });

    it('should throw an error if calling sync process() with an async adapter', () => {
      const largeText = 'A'.repeat(100);
      expect(() => {
        asyncPointer.process(largeText, 'log');
      }).toThrow(
        'Pointer.process() was called synchronously, but the VFSStorageAdapter is asynchronous. Use processAsync() instead.',
      );
    });

    it('should process async and resolve async via the custom adapter', async () => {
      const largeText = 'B'.repeat(100);
      const result = await asyncPointer.processAsync(largeText, 'doc');

      expect(result.isOffloaded).toBe(true);
      expect(result.uri).toBeDefined();

      if (!result.uri) throw new Error('URI not defined');

      // Test sync resolve throws
      expect(() => {
        asyncPointer.resolve(result.uri!);
      }).toThrow(
        'Pointer.resolve() was called synchronously, but the VFSStorageAdapter is asynchronous. Use resolveAsync() instead.',
      );

      // Test async resolve
      const resolved = await asyncPointer.resolveAsync(result.uri);
      expect(resolved).toBe(largeText);
    });
  });
});
