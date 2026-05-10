import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterRegistry } from '../src/adapters/adapterRegistry';
import type { ITargetAdapter } from '../src/adapters/targetAdapter';
import { ContextChef } from '../src/index';
import type { Message, TargetPayload } from '../src/types';

function makeStubAdapter(label: string): ITargetAdapter & { compile: ReturnType<typeof vi.fn> } {
  const compile = vi.fn(
    (messages: Message[]): TargetPayload => ({
      messages: messages.map((m) => ({ role: m.role, content: `${label}:${m.content}` })),
    }),
  );
  return { compile };
}

describe('compile() — target resolution', () => {
  // Tests in this file plant entries in the global adapterRegistry singleton.
  // Cleanup runs in afterEach (immediately after each polluting test) rather
  // than beforeEach, so the registry is left clean even if Vitest's file
  // isolation is ever turned off.
  const planted: string[] = [];
  afterEach(() => {
    for (const name of planted) adapterRegistry.unregister(name);
    planted.length = 0;
  });

  it('resolves built-in literal "openai" via the registry by default', async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'hi' }]);
    const payload = await chef.compile();
    // OpenAI adapter shape: messages array with the user message
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('routes a registered third-party name through adapterRegistry.get()', async () => {
    const cohere = makeStubAdapter('cohere');
    adapterRegistry.register('cohere', cohere);
    planted.push('cohere');

    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    const payload = await chef.compile({ target: 'cohere' });

    expect(cohere.compile).toHaveBeenCalledOnce();
    expect(payload.messages[payload.messages.length - 1].content).toBe('cohere:hello');
  });

  it('accepts an ITargetAdapter instance directly, bypassing the registry', async () => {
    const oneOff = makeStubAdapter('oneoff');
    // Deliberately NOT registered.
    expect(adapterRegistry.has('oneoff')).toBe(false);

    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    const payload = await chef.compile({ target: oneOff });

    expect(oneOff.compile).toHaveBeenCalledOnce();
    expect(payload.messages[payload.messages.length - 1].content).toBe('oneoff:hello');
  });

  it('uses ChefConfig.defaultTarget when compile() is called without options', async () => {
    const customDefault = makeStubAdapter('custom-default');
    const chef = new ContextChef({ defaultTarget: customDefault });
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    const payload = await chef.compile();

    expect(customDefault.compile).toHaveBeenCalledOnce();
    expect(payload.messages[payload.messages.length - 1].content).toBe('custom-default:hello');
  });

  it('per-call target overrides defaultTarget (resolution priority)', async () => {
    const wide = makeStubAdapter('wide-default');
    const narrow = makeStubAdapter('per-call');
    const chef = new ContextChef({ defaultTarget: wide });
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    await chef.compile({ target: narrow });

    expect(narrow.compile).toHaveBeenCalledOnce();
    expect(wide.compile).not.toHaveBeenCalled();
  });

  it('defaultTarget accepts a string name resolved via the registry', async () => {
    const cohere = makeStubAdapter('cohere');
    adapterRegistry.register('cohere', cohere);
    planted.push('cohere');

    const chef = new ContextChef({ defaultTarget: 'cohere' });
    chef.setHistory([{ role: 'user', content: 'hi' }]);
    await chef.compile();

    expect(cohere.compile).toHaveBeenCalledOnce();
  });

  it('throws a clear error when target name is not registered', async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'hi' }]);
    await expect(chef.compile({ target: 'nonexistent' })).rejects.toThrow(
      /Unknown adapter target: "nonexistent"/,
    );
  });

  it("throws when the implicit 'openai' fallback is reached but 'openai' has been unregistered", async () => {
    // Edge case: someone calls unregister('openai') and then compile() without
    // setting defaultTarget — the final fallback can't resolve. Verify the
    // error path produces the same helpful message rather than something cryptic.
    const original = adapterRegistry.get('openai');
    adapterRegistry.unregister('openai');
    try {
      const chef = new ContextChef();
      chef.setHistory([{ role: 'user', content: 'hi' }]);
      await expect(chef.compile()).rejects.toThrow(/Unknown adapter target: "openai"/);
    } finally {
      // Always restore the built-in so this test does not break sibling tests.
      adapterRegistry.register('openai', original, 'builtin');
    }
  });
});
