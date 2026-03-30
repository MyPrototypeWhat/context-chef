import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

export class VFSMemoryStore implements MemoryStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: Set<string>;

  constructor(storageDir = '.context_memory') {
    this.dir = storageDir;
    this.indexPath = path.join(storageDir, '_index.json');
    this.index = new Set(this._loadIndex());
  }

  get(key: string): MemoryStoreEntry | null {
    const file = this._keyToFile(key);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as MemoryStoreEntry;
    } catch {
      return null;
    }
  }

  set(key: string, entry: MemoryStoreEntry): void {
    this._ensureDir();
    fs.writeFileSync(this._keyToFile(key), JSON.stringify(entry), 'utf-8');
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

  snapshot(): Record<string, MemoryStoreEntry> {
    const result: Record<string, MemoryStoreEntry> = {};
    for (const key of this.index) {
      const entry = this.get(key);
      if (entry) result[key] = entry;
    }
    return result;
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    // Remove existing entries not in snapshot
    for (const key of this.index) {
      const file = this._keyToFile(key);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    this.index.clear();

    // Write snapshot entries
    for (const [key, entry] of Object.entries(data)) {
      this.set(key, entry);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private _keyToFile(key: string): string {
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
