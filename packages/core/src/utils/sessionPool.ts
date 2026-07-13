import type { ChefLogger } from '../types';

/** Pool key shared by every call that carries no usable session identity. */
export const DEFAULT_SESSION_KEY = '__default__';

/**
 * Normalizes a caller-supplied session identifier to a pool key.
 *
 * Absent values (`undefined` / `null`) map to {@link DEFAULT_SESSION_KEY}
 * silently — sharing one default session is the documented behavior for
 * callers that never opt into isolation. A value that is PRESENT but
 * unusable (empty string, non-string) also maps to the default key, but
 * fires `onInvalid` first: a misconfigured session id silently merging
 * unrelated conversations is exactly the failure mode this guards against.
 */
export function normalizeSessionKey(raw: unknown, onInvalid?: (raw: unknown) => void): string {
  if (typeof raw === 'string' && raw) return raw;
  if (raw !== undefined && raw !== null) onInvalid?.(raw);
  return DEFAULT_SESSION_KEY;
}

/**
 * Wraps a pool factory so logger warnings emitted DURING construction are
 * deduped by message across instances, while warnings after construction
 * pass through untouched. Pooled factories construct many identically
 * configured instances — a configuration nag repeated per session is log
 * noise, but runtime warnings (e.g. a compression failure) must stay
 * per-occurrence.
 */
export function dedupeConstructionWarnings<T>(
  logger: ChefLogger,
  build: (constructionLogger: ChefLogger) => T,
): () => T {
  const seen = new Set<string>();
  return () => {
    let constructing = true;
    const constructionLogger: ChefLogger = {
      warn(message, ...args) {
        if (constructing) {
          if (seen.has(message)) return;
          seen.add(message);
        }
        logger.warn(message, ...args);
      },
    };
    const instance = build(constructionLogger);
    constructing = false;
    return instance;
  };
}

/**
 * Keyed instance pool with LRU eviction.
 *
 * Built for the middleware packages: a middleware instance is typically
 * created once at module scope but serves many concurrent conversations, so
 * per-conversation state (a stateful Janitor) must be keyed by session — not
 * shared — or token-usage feeds, compression suppression, and circuit-breaker
 * counts leak across callers.
 *
 * `get()` refreshes the entry's LRU position. When the pool exceeds
 * `maxSize`, the least-recently-used entries are dropped; a dropped session
 * is transparently recreated on next access (losing only its fed token
 * usage — the next over-budget call re-triggers compression).
 */
export class SessionPool<T> {
  private readonly entries = new Map<string, T>();
  private readonly create: (key: string) => T;
  private readonly maxSize: number;

  constructor(create: (key: string) => T, options?: { maxSize?: number }) {
    const maxSize = options?.maxSize ?? 256;
    // A non-positive cap would evict every entry the moment it is inserted,
    // silently disabling pooling (and with it, fed-usage compression).
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(
        `[context-chef] SessionPool maxSize must be a positive integer, got ${maxSize}`,
      );
    }
    this.create = create;
    this.maxSize = maxSize;
  }

  /** Returns the instance for `key`, creating it on first access. */
  get(key: string): T {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // Re-insert to refresh LRU order (Map preserves insertion order).
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const created = this.create(key);
    this.entries.set(key, created);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return created;
  }

  get size(): number {
    return this.entries.size;
  }
}
