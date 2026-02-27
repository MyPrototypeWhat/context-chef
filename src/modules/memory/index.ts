import type { MemoryStore } from './memoryStore';

export interface MemoryEntry {
  key: string;
  value: string;
}

export interface MemoryConfig {
  store: MemoryStore;
  /** When set, only these keys are accepted for update/delete. Unknown keys are silently skipped. */
  allowedKeys?: string[];
  /**
   * Lifecycle hook fired before each memory write (update or delete).
   * Return `true` to allow, `false` to reject.
   * For deletes, `value` is `null`.
   */
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
    return await this.store.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return await this.store.delete(key);
  }

  async getAll(): Promise<MemoryEntry[]> {
    const allKeys = await this.store.keys();
    const entries: MemoryEntry[] = [];
    for (const key of allKeys) {
      const value = await this.store.get(key);
      if (value !== null) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  /**
   * Generates XML representation of all stored memories for compile() injection.
   * Returns empty string if no memories exist.
   */
  async toXml(): Promise<string> {
    const entries = await this.getAll();
    if (entries.length === 0) return '';
    const inner = entries.map((e) => `  <${e.key}>${e.value}</${e.key}>`).join('\n');
    return `<core_memory>\n${inner}\n</core_memory>`;
  }

  /**
   * Parses assistant output for <update_core_memory> and <delete_core_memory> tags,
   * applies them to the store (respecting allowedKeys and onMemoryUpdate), and returns the updated entries.
   */
  async extractAndApply(content: string): Promise<MemoryEntry[]> {
    const applied: MemoryEntry[] = [];

    for (const match of content.matchAll(UPDATE_RE)) {
      const key = match[1];
      const value = match[2].trim();

      if (this.allowedKeys && !this.allowedKeys.includes(key)) continue;

      const oldValue = await this.store.get(key);
      if (this.onMemoryUpdate) {
        const allowed = await this.onMemoryUpdate(key, value, oldValue);
        if (!allowed) continue;
      }

      await this.store.set(key, value);
      applied.push({ key, value });
    }

    for (const match of content.matchAll(DELETE_RE)) {
      const key = match[1];

      if (this.allowedKeys && !this.allowedKeys.includes(key)) continue;

      const oldValue = await this.store.get(key);
      if (this.onMemoryUpdate) {
        const allowed = await this.onMemoryUpdate(key, null, oldValue);
        if (!allowed) continue;
      }

      await this.store.delete(key);
    }

    return applied;
  }

  /**
   * Captures store state if the underlying store supports snapshots.
   * Returns null if the store does not implement snapshot().
   */
  snapshot(): Record<string, string> | null {
    return this.store.snapshot ? this.store.snapshot() : null;
  }

  /**
   * Restores store state if the underlying store supports restore().
   */
  restore(data: Record<string, string>): void {
    if (this.store.restore) {
      this.store.restore(data);
    }
  }
}
