import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore } from './memoryStore';

/**
 * Persistent key-value store that writes each entry as a file under a
 * configurable directory (default: `.context_memory/`).
 *
 * Key → filename mapping: keys are base64url-encoded to produce safe filenames,
 * avoiding path traversal and special-character issues.
 * An index file (`_index.json`) tracks all active keys for O(1) `keys()` calls.
 *
 * All operations are synchronous. Suitable for CLI tools, long-running daemons,
 * and any scenario where memory must survive process restarts.
 */
export class VFSMemoryStore implements MemoryStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: Set<string>;

  constructor(storageDir = '.context_memory') {
    this.dir = storageDir;
    this.indexPath = path.join(storageDir, '_index.json');
    this.index = new Set(this._loadIndex());
  }

  get(key: string): string | null {
    const file = this._keyToFile(key);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  }

  set(key: string, value: string): void {
    this._ensureDir();
    fs.writeFileSync(this._keyToFile(key), value, 'utf-8');
    this.index.add(key);
    this._saveIndex();
  }

  delete(key: string): boolean {
    const file = this._keyToFile(key);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.index.delete(key);
    this._saveIndex();
    return true;
  }

  keys(): string[] {
    return Array.from(this.index);
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private _keyToFile(key: string): string {
    // base64url encode to produce a safe, reversible filename
    const safe = Buffer.from(key).toString('base64url');
    return path.join(this.dir, `${safe}.mem`);
  }

  private _ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private _loadIndex(): string[] {
    if (!fs.existsSync(this.indexPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as string[];
    } catch {
      return [];
    }
  }

  private _saveIndex(): void {
    this._ensureDir();
    fs.writeFileSync(this.indexPath, JSON.stringify(Array.from(this.index)), 'utf-8');
  }
}
