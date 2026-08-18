import type { ToolDefinition } from '../../types';
import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

/** TTL value: bare number = turns, or explicit { ms } / { turns }. */
export type TTLValue = number | { ms: number } | { turns: number };

/**
 * Where the memory data block lands in the compiled payload.
 *
 * - `'after_system'` (default): the memory usage instruction and the volatile
 *   `<memory>` data block are emitted together as a single `role: 'system'`
 *   message immediately after the user's system prompt. Simple and matches
 *   pre-3.5 behavior. Trade-off: provider adapters that extract every
 *   `role: 'system'` message into a top-level system parameter (Anthropic,
 *   Gemini) will fold the volatile memory text into that block. Cache
 *   breakpoints positioned downstream then hash memory and invalidate when
 *   entries change.
 *
 * - `'before_history_tail'`: the stable instruction stays as the top system
 *   message (cacheable), while the volatile `<memory>` data block is appended
 *   to the **most recent `role: 'user'` message** in the assembled sandwich
 *   (alongside any dynamic state / implicit context). The data text never
 *   enters the top-level system parameter, so cache breakpoints earlier in
 *   the message stream survive memory mutations on every provider.
 *
 *   Caveat: when `compile()` is invoked mid-agent-loop (history tail is a
 *   `tool` turn awaiting interpretation), "most recent user" walks back past
 *   the tool result(s) to the user turn that kicked off the current tool
 *   sequence — the injection lands mid-conversation rather than at the
 *   absolute tail. Cache breakpoints placed AFTER that user turn (typical:
 *   end-of-history assistant) will see the modified user content and miss.
 *   To preserve cache in tool-ending tails, place breakpoints BEFORE the
 *   user turn that started the active tool sequence, or restrict
 *   `'before_history_tail'` to user-ending compiles. This is the same
 *   placement convention as `setDynamicState({ placement: 'last_user' })`.
 */
export type MemoryPlacement = 'after_system' | 'before_history_tail';

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

/** Recursively freeze a tool definition so the shared instances stay immutable. */
function deepFreeze<T>(obj: T): T {
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * `modify_memory` tool definition — a single module-level frozen constant.
 *
 * `key` is deliberately a plain string, NOT an enum of live keys: the current
 * keys are already surfaced to the model in the injected memory block
 * ("Existing memory keys: ..."), and dispatch-time validation is enforced by
 * {@link Memory.updateMemory} / {@link Memory.deleteMemory}, which return
 * null / false for unknown keys.
 */
const MODIFY_MEMORY_TOOL: ToolDefinition = deepFreeze({
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
        description:
          'The key of the existing memory entry to modify — see the memory block for current keys.',
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
   * Contract: must not throw. Errors propagate out of compile() — there is no
   * fallback path. Return the original array on failure if you need to swallow
   * the error yourself.
   *
   * @example
   * // Only inject the 10 most recently updated entries
   * selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10)
   */
  selector?: (entries: MemoryEntry[]) => MemoryEntry[];
  /**
   * Veto hook — return false to block the write. Called before createMemory/updateMemory/deleteMemory.
   *
   * Contract: must not throw or reject. Errors propagate out of the calling
   * write method. Return false to block the write, true to allow.
   */
  onMemoryUpdate?: (
    key: string,
    value: string | null,
    oldValue: string | null,
  ) => boolean | Promise<boolean>;
  /**
   * Pure notification — called after any memory change (set, delete, expire).
   *
   * Contract: must not throw or reject. Notification-only — return value is
   * ignored. Errors propagate out of the calling write method (or out of compile()
   * for type: 'expire').
   */
  onMemoryChanged?: (event: MemoryChangeEvent) => void | Promise<void>;
  /**
   * Called when an entry expires during compile().
   *
   * Contract: must not throw or reject. Errors propagate out of compile().
   */
  onMemoryExpired?: (entry: MemoryEntry) => void | Promise<void>;
  /**
   * Where the volatile `<memory>` data block lands in the compiled payload.
   * Defaults to `'after_system'` (current behavior). Set to
   * `'before_history_tail'` to keep memory text out of the top-level system
   * parameter so provider-level cache breakpoints on history survive memory
   * mutations.
   *
   * See {@link MemoryPlacement} for the full rationale.
   */
  memoryPlacement?: MemoryPlacement;
}

export class Memory {
  private store: MemoryStore;
  readonly allowedKeys?: string[];
  readonly placement: MemoryPlacement;
  private selector?: MemoryConfig['selector'];
  private onMemoryUpdate?: MemoryConfig['onMemoryUpdate'];
  private onMemoryChanged?: MemoryConfig['onMemoryChanged'];
  private onMemoryExpired?: MemoryConfig['onMemoryExpired'];
  private defaultTTL?: TTLValue;
  private _turnCount = 0;
  /**
   * Static tool definitions, built once at construction. `create_memory` is
   * per-instance (its `key` enum comes from `allowedKeys`, static constructor
   * config), `modify_memory` is the shared module-level constant. The same
   * frozen objects are returned on every call so `payload.tools` is deep-equal
   * AND reference-stable across compiles.
   */
  private readonly _toolDefinitions: ToolDefinition[];

  constructor(config: MemoryConfig) {
    this.store = config.store;
    this.allowedKeys = config.allowedKeys;
    this.placement = config.memoryPlacement ?? 'after_system';
    this.selector = config.selector;
    this.onMemoryUpdate = config.onMemoryUpdate;
    this.onMemoryChanged = config.onMemoryChanged;
    this.onMemoryExpired = config.onMemoryExpired;
    this.defaultTTL = config.defaultTTL;
    this._toolDefinitions = this._buildStaticToolDefinitions();
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
    // Fetch entries concurrently — sequential awaits would serialize 1+N
    // round-trips per compile() on async stores (Redis etc.).
    const storeEntries = await Promise.all(allKeys.map((key) => this.store.get(key)));
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < allKeys.length; i++) {
      const storeEntry = storeEntries[i];
      if (storeEntry !== null) {
        entries.push({ key: allKeys[i], ...storeEntry });
      }
    }
    return entries;
  }

  /**
   * Sweep expired entries: delete them from the store and notify via onMemoryExpired.
   * Returns the keys that were expired.
   *
   * Standalone API — ContextChef.compile() uses {@link compileArtifacts}, which
   * folds the sweep into its single store read.
   */
  async sweepExpired(): Promise<string[]> {
    const allEntries = await this.getAll();
    const expiredKeys: string[] = [];

    for (const entry of allEntries) {
      if (this._isExpired(entry)) {
        await this._expireEntry(entry);
        expiredKeys.push(entry.key);
      }
    }

    return expiredKeys;
  }

  /**
   * Single-pass compile-time artifact builder: ONE full store read per compile.
   * Sweeps expired entries, applies the selector exactly once, and derives the
   * injection XML from that same read. Tool definitions are the static
   * per-instance constants (see {@link getToolDefinitions}) — they no longer
   * vary with live keys.
   *
   * Motivation: the previous compile() flow performed four full store scans
   * (sweepExpired → getSelectedEntries → toXml → getToolDefinitions), which on
   * async stores (Redis etc.) meant 4×(1 + N) network round-trips per compile,
   * and a non-deterministic selector could desync `injectedMemoryKeys` from the
   * actually-injected XML.
   */
  async compileArtifacts(): Promise<{
    /** Keys swept this call (onMemoryExpired / onMemoryChanged already fired). */
    expiredKeys: string[];
    /** Post-sweep entries with the selector applied exactly once. */
    selected: MemoryEntry[];
    /** `<memory>` XML for the selected entries, or '' when none. */
    dataXml: string;
    /** Static tool definitions (schema never varies with live keys — see {@link getToolDefinitions}). */
    toolDefinitions: ToolDefinition[];
  }> {
    const all = await this.getAll();
    const live: MemoryEntry[] = [];
    const expiredKeys: string[] = [];

    for (const entry of all) {
      if (this._isExpired(entry)) {
        await this._expireEntry(entry);
        expiredKeys.push(entry.key);
      } else {
        live.push(entry);
      }
    }

    const selected = this.selector ? this.selector(live) : live;
    return {
      expiredKeys,
      selected,
      dataXml: this._renderXml(selected),
      toolDefinitions: this._toolDefinitions,
    };
  }

  /** Delete an expired entry and fire the expiry hooks. */
  private async _expireEntry(entry: MemoryEntry): Promise<void> {
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

  /**
   * Render the `<memory>` XML block. When `entries` is provided they are
   * rendered directly (no store read); otherwise the selected entries are
   * fetched first.
   */
  async toXml(entries?: MemoryEntry[]): Promise<string> {
    const resolved = entries ?? (await this.getSelectedEntries());
    return this._renderXml(resolved);
  }

  private _renderXml(entries: MemoryEntry[]): string {
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
   * - `modify_memory`: Update or delete an existing memory entry. Always emitted —
   *   calling it against an empty store (or an unknown key) is safe because
   *   {@link updateMemory} / {@link deleteMemory} validate at dispatch time and
   *   return null / false.
   *
   * The definitions are static: tool schemas sit at the TOP of every provider's
   * prompt prefix, so any dynamic content in them (e.g. an enum of live memory
   * keys) would rewrite the schema on every memory mutation and invalidate the
   * ENTIRE prompt cache downstream. The current key list is instead conveyed
   * through the injected memory block ("Existing memory keys: ..."), which
   * lives further down the prompt where a change is far cheaper. The same
   * frozen objects are returned on every call.
   *
   * @param existingKeys @deprecated Ignored — the schema is static since 4.1.
   *   Still accepted for backward compatibility.
   */
  async getToolDefinitions(existingKeys?: string[]): Promise<ToolDefinition[]> {
    void existingKeys;
    return this._toolDefinitions;
  }

  /** Build the per-instance frozen tool definitions. Called once from the constructor. */
  private _buildStaticToolDefinitions(): ToolDefinition[] {
    const createKeyParam: Record<string, unknown> = {
      type: 'string',
      description:
        'A clear, descriptive key name for the memory (e.g. "project_language", "user_preference_style").',
    };
    if (this.allowedKeys && this.allowedKeys.length > 0) {
      // allowedKeys is static constructor config — enum here is cache-stable.
      // Copied so deepFreeze doesn't freeze the caller's array.
      createKeyParam.enum = [...this.allowedKeys];
    }

    const createTool: ToolDefinition = deepFreeze({
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

    return Object.freeze([createTool, MODIFY_MEMORY_TOOL]) as ToolDefinition[];
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
