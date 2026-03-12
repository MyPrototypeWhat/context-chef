export interface MemoryStoreEntry {
  value: string;
  /** Human-readable description of this memory entry's purpose. */
  description?: string;
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  importance?: number;
  /** Wall-clock expiration timestamp (ms). Set by ms-based TTL. */
  expiresAt?: number;
  /** Turn-based expiration point. Set by turn-based TTL. */
  expiresAtTurn?: number;
}

export interface MemoryStore {
  get(key: string): MemoryStoreEntry | null | Promise<MemoryStoreEntry | null>;
  set(key: string, entry: MemoryStoreEntry): void | Promise<void>;
  delete(key: string): boolean | Promise<boolean>;
  keys(): string[] | Promise<string[]>;
  snapshot?(): Record<string, MemoryStoreEntry>;
  restore?(data: Record<string, MemoryStoreEntry>): void;
}
