export interface MemoryStoreEntry {
  value: string;
  tier: 'core' | 'archival';
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  importance?: number;
}

export interface MemoryStore {
  get(key: string): MemoryStoreEntry | null | Promise<MemoryStoreEntry | null>;
  set(key: string, entry: MemoryStoreEntry): void | Promise<void>;
  delete(key: string): boolean | Promise<boolean>;
  keys(): string[] | Promise<string[]>;
  snapshot?(): Record<string, MemoryStoreEntry>;
  restore?(data: Record<string, MemoryStoreEntry>): void;
}
