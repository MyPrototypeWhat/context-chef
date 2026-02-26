import type { MemoryStore } from './MemoryStore';

/**
 * In-process key-value store backed by a plain Map.
 *
 * All operations are synchronous. Data lives only for the lifetime of the
 * process — suitable for testing, short-lived agents, or Serverless functions
 * where cross-invocation persistence is not required.
 */
export class InMemoryStore implements MemoryStore {
  private store = new Map<string, string>();

  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}
