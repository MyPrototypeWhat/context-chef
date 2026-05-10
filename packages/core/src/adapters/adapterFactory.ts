import type { TargetProvider } from '../types';
import { adapterRegistry } from './adapterRegistry';
// Side-effect import: registers openai/anthropic/gemini into adapterRegistry.
import './registerBuiltins';
import type { ITargetAdapter } from './targetAdapter';

export type { ITargetAdapter };
export { AdapterRegistry, adapterRegistry } from './adapterRegistry';

/**
 * Look up an adapter by target name. Thin wrapper over `adapterRegistry.get()`
 * for backward compatibility — new code should prefer `adapterRegistry` directly,
 * which exposes register/unregister/list capabilities.
 *
 * Built-ins (`'openai' | 'anthropic' | 'gemini'`) are registered on import
 * via `registerBuiltins`.
 */
export function getAdapter(target: TargetProvider): ITargetAdapter {
  return adapterRegistry.get(target);
}

/** @deprecated Use `getAdapter()` or `adapterRegistry` directly. */
export const AdapterFactory = { getAdapter };
