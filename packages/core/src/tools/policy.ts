import { MEMORY_NAMESPACE } from '../store/types';

/**
 * The model's own scratch namespace: working notes it writes for itself and
 * reads back on demand. Unlike `memory/` nothing here is injected into the
 * window automatically — that is the whole point of it.
 */
export const NOTES_NAMESPACE = 'notes';

/**
 * Which namespaces the `context` tool may write to. Reading is never
 * restricted: everything in the store is this conversation's own overflow, and
 * a model that can be handed a `context://` URI can be handed what is behind it.
 *
 * Enforced in the dispatcher, not in the store — the store moves bytes, the
 * tool decides who may ask it to.
 */
export interface ContextToolPolicy {
  /** Namespaces `create` / `str_replace` / `insert` / `delete` / `rename` may target. */
  writable: string[];
}

/** `ChefConfig.contextTool` — the caller's overrides for {@link ContextToolPolicy}. */
export interface ContextToolPolicyConfig {
  /**
   * Namespaces the model may write to. Defaults to
   * {@link DEFAULT_WRITABLE_NAMESPACES}. Add `'vfs'` to let the model edit
   * offloaded tool output, or narrow it to `['notes']` to make memory
   * read-only.
   */
  writable?: string[];
}

/** `memory/` and `notes/` — the two namespaces the model owns by default. */
export const DEFAULT_WRITABLE_NAMESPACES: readonly string[] = Object.freeze([
  MEMORY_NAMESPACE,
  NOTES_NAMESPACE,
]);

/** Builds the effective policy from an optional config block. */
export function resolveContextToolPolicy(config?: ContextToolPolicyConfig): ContextToolPolicy {
  return { writable: [...(config?.writable ?? DEFAULT_WRITABLE_NAMESPACES)] };
}

export function canWrite(policy: ContextToolPolicy, ns: string): boolean {
  return policy.writable.includes(ns);
}
