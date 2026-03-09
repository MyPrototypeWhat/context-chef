import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

/** TTL value: bare number = turns, or explicit { ms } / { turns }. */
export type TTLValue = number | { ms: number } | { turns: number };

export interface MemoryEntry {
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  importance?: number;
  expiresAt?: number;
  expiresAtTurn?: number;
}

export interface MemorySetOptions {
  /** Override the default TTL for this entry. null = never expire. */
  ttl?: TTLValue | null;
  importance?: number;
}

export interface MemoryChangeEvent {
  type: 'set' | 'delete' | 'expire';
  key: string;
  value: string | null;
  oldValue: string | null;
}

export interface MemoryConfig {
  store: MemoryStore;
  /** Default TTL for all writes. Bare number = turns. undefined = never expire. */
  defaultTTL?: TTLValue;
  allowedKeys?: string[];
  /**
   * Filter/sort/truncate entries before injection into the system prompt.
   * Called during `compile()` after expired entries are swept.
   * Default: return all entries (no filtering).
   *
   * @example
   * // Only inject the 10 most recently updated entries
   * selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)
   */
  selector?: (entries: MemoryEntry[]) => MemoryEntry[];
  /** Veto hook — return false to block the write. Called before set/delete via extractAndApply(). */
  onMemoryUpdate?: (
    key: string,
    value: string | null,
    oldValue: string | null,
  ) => boolean | Promise<boolean>;
  /** Pure notification — called after any memory change (set, delete, expire). */
  onMemoryChanged?: (event: MemoryChangeEvent) => void | Promise<void>;
  /** Called when an entry expires during compile(). */
  onMemoryExpired?: (entry: MemoryEntry) => void | Promise<void>;
}

const UPDATE_RE = /<update_core_memory\s+key="([^"]+)">([\s\S]*?)<\/update_core_memory>/g;
const DELETE_RE = /<delete_core_memory\s+key="([^"]+)"\s*\/>/g;

export class Memory {
  private store: MemoryStore;
  readonly allowedKeys?: string[];
  private selector?: MemoryConfig['selector'];
  private onMemoryUpdate?: MemoryConfig['onMemoryUpdate'];
  private onMemoryChanged?: MemoryConfig['onMemoryChanged'];
  private onMemoryExpired?: MemoryConfig['onMemoryExpired'];
  private defaultTTL?: TTLValue;
  private _turnCount = 0;

  constructor(config: MemoryConfig) {
    this.store = config.store;
    this.allowedKeys = config.allowedKeys;
    this.selector = config.selector;
    this.onMemoryUpdate = config.onMemoryUpdate;
    this.onMemoryChanged = config.onMemoryChanged;
    this.onMemoryExpired = config.onMemoryExpired;
    this.defaultTTL = config.defaultTTL;
  }

  /** Current compile turn count. */
  get turnCount(): number {
    return this._turnCount;
  }

  /** Advance the turn counter. Called by ContextChef.compile(). */
  advanceTurn(): void {
    this._turnCount++;
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
    const oldValue = existing?.value ?? null;

    const ttlFields = this._resolveTTL(options?.ttl !== undefined ? options.ttl : this.defaultTTL);

    const entry: MemoryStoreEntry = existing
      ? {
          ...existing,
          value,
          updatedAt: now,
          updateCount: existing.updateCount + 1,
          importance: options?.importance ?? existing.importance,
          ...ttlFields,
        }
      : {
          value,
          createdAt: now,
          updatedAt: now,
          updateCount: 1,
          importance: options?.importance,
          ...ttlFields,
        };

    await this.store.set(key, entry);

    if (this.onMemoryChanged) {
      await this.onMemoryChanged({ type: 'set', key, value, oldValue });
    }
  }

  async delete(key: string): Promise<boolean> {
    const existing = await this.store.get(key);
    const oldValue = existing?.value ?? null;
    const deleted = await this.store.delete(key);

    if (deleted && this.onMemoryChanged) {
      await this.onMemoryChanged({ type: 'delete', key, value: null, oldValue });
    }

    return deleted;
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

  /**
   * Sweep expired entries: delete them from the store and notify via onMemoryExpired.
   * Called by ContextChef.compile() before injection.
   * Returns the keys that were expired.
   */
  async sweepExpired(): Promise<string[]> {
    const allEntries = await this.getAll();
    const expiredKeys: string[] = [];

    for (const entry of allEntries) {
      if (this._isExpired(entry)) {
        if (this.onMemoryExpired) {
          await this.onMemoryExpired(entry);
        }
        await this.store.delete(entry.key);
        if (this.onMemoryChanged) {
          await this.onMemoryChanged({
            type: 'expire',
            key: entry.key,
            value: null,
            oldValue: entry.value,
          });
        }
        expiredKeys.push(entry.key);
      }
    }

    return expiredKeys;
  }

  /**
   * Returns entries after applying the selector (if configured).
   * These are the entries that will be injected into the system prompt.
   */
  async getSelectedEntries(): Promise<MemoryEntry[]> {
    let entries = await this.getAll();
    if (this.selector) {
      entries = this.selector(entries);
    }
    return entries;
  }

  async toXml(): Promise<string> {
    const entries = await this.getSelectedEntries();
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

      await this.set(key, value);
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

      await this.delete(key);
    }

    return applied;
  }

  snapshot(): MemorySnapshot | null {
    const storeData = this.store.snapshot ? this.store.snapshot() : null;
    if (!storeData) return null;
    return { entries: storeData, turnCount: this._turnCount };
  }

  restore(data: MemorySnapshot): void {
    if (this.store.restore) {
      this.store.restore(data.entries);
    }
    this._turnCount = data.turnCount;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private _isExpired(entry: MemoryEntry): boolean {
    if (entry.expiresAt != null && Date.now() >= entry.expiresAt) return true;
    if (entry.expiresAtTurn != null && this._turnCount >= entry.expiresAtTurn) return true;
    return false;
  }

  private _resolveTTL(ttl: TTLValue | null | undefined): {
    expiresAt?: number;
    expiresAtTurn?: number;
  } {
    if (ttl == null) return {};
    if (typeof ttl === 'number') {
      return { expiresAtTurn: this._turnCount + ttl };
    }
    if ('ms' in ttl) {
      return { expiresAt: Date.now() + ttl.ms };
    }
    return { expiresAtTurn: this._turnCount + ttl.turns };
  }
}

/** Snapshot of Memory state for save/restore. */
export interface MemorySnapshot {
  entries: Record<string, MemoryStoreEntry>;
  turnCount: number;
}

/**
 * Strip `<update_core_memory>` and `<delete_core_memory>` tags from LLM response content.
 * Pure utility function — no side effects.
 * Call this after `extractAndApply()` to clean the assistant response before displaying to the user.
 */
export function stripMemoryTags(content: string): string {
  return content.replace(UPDATE_RE, '').replace(DELETE_RE, '').trim();
}
