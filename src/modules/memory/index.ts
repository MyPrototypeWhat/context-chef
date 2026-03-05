import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

export interface MemoryEntry {
  key: string;
  value: string;
  tier: 'core' | 'archival';
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  importance?: number;
}

export interface MemorySetOptions {
  tier?: 'core' | 'archival';
  importance?: number;
}

export interface MemoryConfig {
  store: MemoryStore;
  allowedKeys?: string[];
  onMemoryUpdate?: (
    key: string,
    value: string | null,
    oldValue: string | null,
  ) => boolean | Promise<boolean>;
}

const UPDATE_RE = /<update_core_memory\s+key="([^"]+)">([\s\S]*?)<\/update_core_memory>/g;
const DELETE_RE = /<delete_core_memory\s+key="([^"]+)"\s*\/>/g;

export class Memory {
  private store: MemoryStore;
  readonly allowedKeys?: string[];
  private onMemoryUpdate?: MemoryConfig['onMemoryUpdate'];

  constructor(config: MemoryConfig) {
    this.store = config.store;
    this.allowedKeys = config.allowedKeys;
    this.onMemoryUpdate = config.onMemoryUpdate;
  }

  async get(key: string): Promise<string | null> {
    const entry = await this.store.get(key);
    return entry?.value ?? null;
  }

  async getEntry(key: string): Promise<MemoryEntry | null> {
    const entry = await this.store.get(key);
    if (!entry) return null;
    return { key, ...entry };
  }

  async set(key: string, value: string, options?: MemorySetOptions): Promise<void> {
    const now = Date.now();
    const existing = await this.store.get(key);

    const entry: MemoryStoreEntry = existing
      ? {
          ...existing,
          value,
          tier: options?.tier ?? existing.tier,
          updatedAt: now,
          updateCount: existing.updateCount + 1,
          importance: options?.importance ?? existing.importance,
        }
      : {
          value,
          tier: options?.tier ?? 'core',
          createdAt: now,
          updatedAt: now,
          updateCount: 1,
          importance: options?.importance,
        };

    await this.store.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return await this.store.delete(key);
  }

  async getAll(): Promise<MemoryEntry[]> {
    const allKeys = await this.store.keys();
    const entries: MemoryEntry[] = [];
    for (const key of allKeys) {
      const storeEntry = await this.store.get(key);
      if (storeEntry !== null) {
        entries.push({ key, ...storeEntry });
      }
    }
    return entries;
  }

  async toXml(): Promise<string> {
    const entries = (await this.getAll()).filter((e) => e.tier === 'core');
    if (entries.length === 0) return '';
    const inner = entries.map((e) => `  <${e.key}>${e.value}</${e.key}>`).join('\n');
    return `<core_memory>\n${inner}\n</core_memory>`;
  }

  async extractAndApply(content: string): Promise<MemoryEntry[]> {
    const applied: MemoryEntry[] = [];

    for (const match of content.matchAll(UPDATE_RE)) {
      const key = match[1];
      const value = match[2].trim();

      if (this.allowedKeys && !this.allowedKeys.includes(key)) continue;

      const oldEntry = await this.store.get(key);
      const oldValue = oldEntry?.value ?? null;
      if (this.onMemoryUpdate) {
        const allowed = await this.onMemoryUpdate(key, value, oldValue);
        if (!allowed) continue;
      }

      await this.set(key, value, { tier: 'core' });
      const entry = await this.store.get(key);
      if (entry) {
        applied.push({ key, ...entry });
      }
    }

    for (const match of content.matchAll(DELETE_RE)) {
      const key = match[1];

      if (this.allowedKeys && !this.allowedKeys.includes(key)) continue;

      const oldEntry = await this.store.get(key);
      const oldValue = oldEntry?.value ?? null;
      if (this.onMemoryUpdate) {
        const allowed = await this.onMemoryUpdate(key, null, oldValue);
        if (!allowed) continue;
      }

      await this.store.delete(key);
    }

    return applied;
  }

  snapshot(): Record<string, MemoryStoreEntry> | null {
    return this.store.snapshot ? this.store.snapshot() : null;
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    if (this.store.restore) {
      this.store.restore(data);
    }
  }
}
