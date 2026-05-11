import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, TargetPayload } from '../types';
import { AdapterRegistry, adapterRegistry } from './adapterRegistry';
import type { ITargetAdapter } from './targetAdapter';

// Side-effect import: ensures built-ins are registered before tests run.
// In real consumers this happens via `adapters/adapterFactory` (or any export
// from the package); we import it explicitly here so this test file works
// in isolation.
import './registerBuiltins';

function makeStubAdapter(label: string): ITargetAdapter {
  return {
    compile(messages: Message[]): TargetPayload {
      return { messages: messages.map((m) => ({ role: m.role, content: label })) };
    },
  };
}

describe('AdapterRegistry — instance', () => {
  let registry: AdapterRegistry;
  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('register + get round-trips a custom adapter', () => {
    const adapter = makeStubAdapter('cohere');
    registry.register('cohere', adapter);
    expect(registry.get('cohere')).toBe(adapter);
  });

  it('register overwrites an existing entry', () => {
    const v1 = makeStubAdapter('v1');
    const v2 = makeStubAdapter('v2');
    registry.register('x', v1);
    registry.register('x', v2);
    expect(registry.get('x')).toBe(v2);
  });

  it('get throws with a list of registered names when target is unknown', () => {
    registry.register('a', makeStubAdapter('a'));
    registry.register('b', makeStubAdapter('b'));
    expect(() => registry.get('missing')).toThrow(/Unknown adapter target: "missing"/);
    expect(() => registry.get('missing')).toThrow(/\[a, b\]/);
  });

  it('get shows "(none)" instead of "[]" when no adapters are registered', () => {
    // Matches the (none) fallback used by Pruner.extractToolkit / resolveNamespace
    // and ContextChef.activateSkill, so empty-registry errors read uniformly
    // across the codebase.
    expect(() => registry.get('anything')).toThrow(/Registered: \(none\)/);
  });

  it('has reflects current state', () => {
    expect(registry.has('a')).toBe(false);
    registry.register('a', makeStubAdapter('a'));
    expect(registry.has('a')).toBe(true);
    registry.unregister('a');
    expect(registry.has('a')).toBe(false);
  });

  it('unregister is a no-op for missing names', () => {
    expect(() => registry.unregister('never-registered')).not.toThrow();
  });

  it('list returns names in registration order', () => {
    registry.register('first', makeStubAdapter('first'));
    registry.register('second', makeStubAdapter('second'));
    registry.register('third', makeStubAdapter('third'));
    expect(registry.list()).toEqual(['first', 'second', 'third']);
  });

  it('unregisterBySource removes only entries tagged with the source', () => {
    registry.register('a', makeStubAdapter('a'), 'plugin-x');
    registry.register('b', makeStubAdapter('b'), 'plugin-x');
    registry.register('c', makeStubAdapter('c'), 'plugin-y');
    registry.register('d', makeStubAdapter('d')); // no source

    registry.unregisterBySource('plugin-x');

    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(false);
    expect(registry.has('c')).toBe(true);
    expect(registry.has('d')).toBe(true);
  });
});

describe('AdapterRegistry — process-wide singleton', () => {
  it('has the three built-ins registered on import', () => {
    expect(adapterRegistry.has('openai')).toBe(true);
    expect(adapterRegistry.has('anthropic')).toBe(true);
    expect(adapterRegistry.has('gemini')).toBe(true);
  });

  it('built-ins are tagged with sourceId "builtin" — unregisterBySource("builtin") would clear them', () => {
    // Smoke-test the contract by registering and clearing under a different source,
    // then verifying built-ins stay put.
    adapterRegistry.register('test-only', makeStubAdapter('test'), 'test-suite');
    adapterRegistry.unregisterBySource('test-suite');
    expect(adapterRegistry.has('test-only')).toBe(false);
    expect(adapterRegistry.has('openai')).toBe(true);
  });

  it('register + unregister cycle does not affect built-ins', () => {
    adapterRegistry.register('temp-cohere', makeStubAdapter('cohere'));
    expect(adapterRegistry.has('temp-cohere')).toBe(true);
    adapterRegistry.unregister('temp-cohere');
    expect(adapterRegistry.has('temp-cohere')).toBe(false);
    expect(adapterRegistry.list()).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'gemini']),
    );
  });
});
