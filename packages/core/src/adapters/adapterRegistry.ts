import type { ITargetAdapter } from './targetAdapter';

interface RegistryEntry {
  adapter: ITargetAdapter;
  sourceId?: string;
}

/**
 * Open registry for `ITargetAdapter` instances. Replaces the legacy
 * switch-case in `getAdapter()` so third-party / proprietary providers
 * (Cohere, Mistral, in-house protocols) can be plugged into `chef.compile()`
 * without forking the library, and tests can inject fake adapters cleanly.
 *
 * Use the `adapterRegistry` singleton — do not instantiate directly.
 *
 * `sourceId` lets a plugin or test suite tag a batch of registrations and
 * unregister them as a group via `unregisterBySource()`.
 */
export class AdapterRegistry {
  private adapters = new Map<string, RegistryEntry>();

  /**
   * Register an adapter under `name`. Overwrites any existing entry
   * with the same name (so plugins can replace built-ins if they choose).
   */
  register(name: string, adapter: ITargetAdapter, sourceId?: string): void {
    this.adapters.set(name, { adapter, sourceId });
  }

  /** Remove a single registration. No-op if `name` is not registered. */
  unregister(name: string): void {
    this.adapters.delete(name);
  }

  /**
   * Remove every adapter tagged with `sourceId`. Useful for plugins to
   * tear down all of their registrations at once, or for tests to clean
   * up after themselves without naming each entry individually.
   */
  unregisterBySource(sourceId: string): void {
    for (const [name, entry] of this.adapters) {
      if (entry.sourceId === sourceId) this.adapters.delete(name);
    }
  }

  /**
   * Look up an adapter by name. Throws when `name` is not registered —
   * silently falling back to a built-in would mask configuration bugs.
   */
  get(name: string): ITargetAdapter {
    const entry = this.adapters.get(name);
    if (!entry) {
      throw new Error(
        `Unknown adapter target: "${name}". Registered: [${this.list().join(', ')}]. ` +
          `Use adapterRegistry.register("${name}", ...) before chef.compile().`,
      );
    }
    return entry.adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  /** List all registered adapter names. Order is registration order. */
  list(): string[] {
    return [...this.adapters.keys()];
  }
}

/** Process-wide adapter registry. Built-ins are registered on import. */
export const adapterRegistry = new AdapterRegistry();
