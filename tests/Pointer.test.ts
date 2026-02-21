import { Pointer } from '../src/modules/Pointer';
import * as fs from 'fs';
import * as path from 'path';

describe('Pointer (VFS)', () => {
  const TEST_DIR = path.join(process.cwd(), '.test_vfs');
  let pointer: Pointer;

  beforeEach(() => {
    pointer = new Pointer({
      storageDir: TEST_DIR,
      threshold: 50 // Very small threshold for testing
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
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} of the long log file that goes on and on.`);
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

  it('should resolve a valid URI back to full content', () => {
    const largeText = 'A'.repeat(100);
    const result = pointer.process(largeText, 'doc');

    expect(result.isOffloaded).toBe(true);
    expect(result.uri).toBeDefined();

    const resolved = pointer.resolve(result.uri!);
    expect(resolved).toBe(largeText);
  });

  it('should return null for invalid or missing URIs', () => {
    expect(pointer.resolve('context://vfs/does_not_exist.txt')).toBeNull();
    expect(pointer.resolve('http://example.com')).toBeNull();
  });
});
