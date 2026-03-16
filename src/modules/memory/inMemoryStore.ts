import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

export class InMemoryStore implements MemoryStore {
  private store = new Map<string, MemoryStoreEntry>();

  get(key: string): MemoryStoreEntry | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, entry: MemoryStoreEntry): void {
    this.store.set(key, entry);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  snapshot(): Record<string, MemoryStoreEntry> {
    return structuredClone(Object.fromEntries(this.store));
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    this.store.clear();
    for (const [k, v] of Object.entries(structuredClone(data))) {
      this.store.set(k, v);
    }
  }
}
