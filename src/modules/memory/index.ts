import type { ToolDefinition } from '../../types';
import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

/** TTL value: bare number = turns, or explicit { ms } / { turns }. */
export type TTLValue = number | { ms: number } | { turns: number };

export interface MemoryEntry {
  key: string;
  value: string;
  description?: string;
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
  /** Human-readable description of this memory entry's purpose. */
  description?: string;
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
  /** Veto hook — return false to block the write. Called before createMemory/updateMemory/deleteMemory. */
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
          description: options?.description ?? existing.description,
          updatedAt: now,
          updateCount: existing.updateCount + 1,
          importance: options?.importance ?? existing.importance,
          ...ttlFields,
        }
      : {
          value,
          description: options?.description,
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
    const inner = entries
      .map((e) => {
        const parts: string[] = [`<entry key="${e.key}">`];
        if (e.description) {
          parts.push(`<description>\n${e.description}\n</description>`);
        }
        const updated = new Date(e.updatedAt).toISOString();
        parts.push(
          `<metadata>\n- updated_at=${updated}\n- update_count=${e.updateCount}\n</metadata>`,
        );
        parts.push(`<value>\n${e.value}\n</value>`);
        parts.push('</entry>');
        return parts.join('\n');
      })
      .join('\n\n');
    return `<memory>\n${inner}\n</memory>`;
  }

  // ─── Validated methods (for LLM-driven operations) ──────────────────────

  /**
   * Create a new memory entry. Validates allowedKeys and invokes onMemoryUpdate veto hook.
   * Returns the created entry, or null if vetoed/blocked.
   */
  async createMemory(
    key: string,
    value: string,
    description?: string,
  ): Promise<MemoryEntry | null> {
    if (this.allowedKeys && !this.allowedKeys.includes(key)) return null;

    const oldEntry = await this.store.get(key);
    const oldValue = oldEntry?.value ?? null;
    if (this.onMemoryUpdate) {
      const allowed = await this.onMemoryUpdate(key, value, oldValue);
      if (!allowed) return null;
    }

    await this.set(key, value, { description });
    const entry = await this.store.get(key);
    return entry ? { key, ...entry } : null;
  }

  /**
   * Update an existing memory entry. Validates allowedKeys and invokes onMemoryUpdate veto hook.
   * Returns the updated entry, or null if the key doesn't exist or was vetoed/blocked.
   */
  async updateMemory(
    key: string,
    value: string,
    description?: string,
  ): Promise<MemoryEntry | null> {
    if (this.allowedKeys && !this.allowedKeys.includes(key)) return null;

    const existing = await this.store.get(key);
    if (!existing) return null;

    const oldValue = existing.value;
    if (this.onMemoryUpdate) {
      const allowed = await this.onMemoryUpdate(key, value, oldValue);
      if (!allowed) return null;
    }

    await this.set(key, value, { description });
    const entry = await this.store.get(key);
    return entry ? { key, ...entry } : null;
  }

  /**
   * Delete an existing memory entry. Validates allowedKeys and invokes onMemoryUpdate veto hook.
   * Returns true if deleted, false if the key doesn't exist or was vetoed/blocked.
   */
  async deleteMemory(key: string): Promise<boolean> {
    if (this.allowedKeys && !this.allowedKeys.includes(key)) return false;

    const existing = await this.store.get(key);
    if (!existing) return false;

    const oldValue = existing.value;
    if (this.onMemoryUpdate) {
      const allowed = await this.onMemoryUpdate(key, null, oldValue);
      if (!allowed) return false;
    }

    return this.delete(key);
  }

  // ─── Tool definitions for LLM ──────────────────────────────────────────

  /**
   * Returns tool definitions for memory operations, to be merged into the LLM tools array.
   * - `create_memory`: Create a new memory entry (key is free-form or constrained by allowedKeys).
   * - `modify_memory`: Update or delete an existing memory entry (key is enum of existing keys).
   *   Only generated when there are existing keys.
   */
  async getToolDefinitions(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    const existingKeys = (await this.getAll()).map((e) => e.key);

    // create_memory
    const createKeyParam: Record<string, unknown> = {
      type: 'string',
      description:
        'A clear, descriptive key name for the memory (e.g. "project_language", "user_preference_style").',
    };
    if (this.allowedKeys && this.allowedKeys.length > 0) {
      createKeyParam.enum = this.allowedKeys;
    }

    tools.push({
      name: 'create_memory',
      description:
        'Remember a new fact across conversations. Use this to store important information like user preferences, project conventions, and key decisions.',
      parameters: {
        type: 'object',
        properties: {
          key: createKeyParam,
          value: {
            type: 'string',
            description: 'The value to remember. Keep it concise but informative.',
          },
          description: {
            type: 'string',
            description:
              'A brief description of what this memory entry is for and when it should be referenced.',
          },
        },
        required: ['key', 'value'],
      },
    });

    // modify_memory (only when there are existing keys)
    if (existingKeys.length > 0) {
      tools.push({
        name: 'modify_memory',
        description:
          'Update or delete an existing memory entry. Use "update" to change a remembered value, or "delete" to forget it.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['update', 'delete'],
              description: 'The operation to perform on the memory entry.',
            },
            key: {
              type: 'string',
              enum: existingKeys,
              description: 'The key of the existing memory entry to modify.',
            },
            value: {
              type: 'string',
              description:
                'The new value for the memory entry. Required for "update", ignored for "delete".',
            },
            description: {
              type: 'string',
              description: 'Update the description of this memory entry. Optional.',
            },
          },
          required: ['action', 'key'],
        },
      });
    }

    return tools;
  }

  // ─── Snapshot / Restore ─────────────────────────────────────────────────

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
