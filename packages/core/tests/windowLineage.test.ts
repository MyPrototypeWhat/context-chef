/**
 * Window lineage: the runner opens a new window exactly when an overflow
 * result lands, the chain records the one it replaced, and both survive
 * snapshot/restore — which is what lets strategy state (an `anchored()`
 * anchor) and `CompileMeta.windowId` agree on which window they mean.
 */

import { describe, expect, it } from 'vitest';
import {
  anchored,
  background,
  type ChefConfig,
  ContextChef,
  type JanitorSnapshot,
  reset,
  summarize,
} from '../src/index';
import type { ChefLogger, Message } from '../src/types';

const silent: ChefLogger = { warn: () => {} };

const tokenizer = (messages: Message[]): number => messages.length * 10;

/** Long enough that a summary shrinks the span (the shrink guard's floor). */
const longHistory = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(200)}`,
  }));

const compressionModel = async (): Promise<string> => '<summary>COMPRESSED</summary>';

const chefWith = (config: ChefConfig = {}): ContextChef =>
  new ContextChef({
    logger: silent,
    janitor: { contextWindow: 60, triggerRatio: 1, tokenizer, compressionModel },
    ...config,
  })
    .setSystemPrompt([{ role: 'system', content: 'You are a careful assistant.' }])
    .setHistory(longHistory(9));

const lineage = (chef: ContextChef): JanitorSnapshot['window'] =>
  chef.snapshot().modules.janitor.window;

/** One macrotask flushes a settled background job's promise chain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('window lineage', () => {
  it('opens a new window per landed overflow and chains the previous one', async () => {
    const chef = chefWith();
    const start = lineage(chef);

    const first = await chef.compile({ target: 'openai' });
    // The compile right after a compression is suppressed by design (E10), so
    // it stays in the window the first one opened.
    const quiet = await chef.compile({ target: 'openai' });
    const second = await chef.compile({ target: 'openai' });

    expect(first.meta?.windowId).not.toBe(start?.current);
    expect(quiet.meta?.windowId).toBe(first.meta?.windowId);
    expect(second.meta?.windowId).not.toBe(first.meta?.windowId);

    const now = lineage(chef);
    expect(now?.current).toBe(second.meta?.windowId);
    expect(now?.previous).toBe(first.meta?.windowId);
    expect(now?.first).toBe(start?.first);
  });

  it('stays in the same window when nothing overflows', async () => {
    const chef = chefWith({ janitor: { contextWindow: 1_000_000, tokenizer } });

    const first = await chef.compile({ target: 'openai' });
    const second = await chef.compile({ target: 'openai' });

    expect(first.meta?.windowId).toBe(second.meta?.windowId);
    expect(lineage(chef)?.previous).toBeUndefined();
  });

  it('does not advance the window for a background result that goes stale', async () => {
    const chef = chefWith({
      overflow: { strategy: background(summarize({ compressionModel, split: 'recent-turns' })) },
    });

    // First compile only starts the job — nothing entered the window yet.
    const started = await chef.compile({ target: 'openai' });
    expect(started.meta?.windowId).toBe(lineage(chef)?.first);
    await flush();

    // The span the job summarized is no longer the head of history, so the
    // result is discarded: no summary, and no window to show for it.
    // Still over budget (so the strategy runs), but no longer the span the job
    // was computed against.
    chef.setHistory(longHistory(9).map((m) => ({ ...m, content: `edited ${m.content}` })));
    const stale = await chef.compile({ target: 'openai' });
    expect(stale.meta?.windowId).toBe(started.meta?.windowId);
    expect(lineage(chef)?.previous).toBeUndefined();
    await flush();

    // The re-started job still applies this time — and that one advances.
    const swapped = await chef.compile({ target: 'openai' });
    expect(swapped.meta?.windowId).not.toBe(started.meta?.windowId);
  });

  it('round-trips through snapshot/restore', async () => {
    const chef = chefWith();
    await chef.compile({ target: 'openai' });
    const snap = chef.snapshot();
    const captured = lineage(chef);

    await chef.compile({ target: 'openai' });
    await chef.compile({ target: 'openai' });
    expect(lineage(chef)?.current).not.toBe(captured?.current);

    const restored = chefWith().restore(snap);
    expect(lineage(restored)).toEqual(captured);
    // The restored snapshot also carries the post-compression suppression, so
    // this compile reports the restored window rather than opening a new one.
    const payload = await restored.compile({ target: 'openai' });
    expect(payload.meta?.windowId).toBe(captured?.current);
  });

  it('starts a fresh lineage on clearHistory()', async () => {
    const chef = chefWith();
    await chef.compile({ target: 'openai' });
    const before = lineage(chef);

    chef.clearHistory();
    const after = lineage(chef);

    expect(after?.first).not.toBe(before?.first);
    expect(after?.current).toBe(after?.first);
    expect(after?.previous).toBeUndefined();
  });

  it('restores a pre-4.2 snapshot onto a fresh lineage', async () => {
    const chef = chefWith();
    await chef.compile({ target: 'openai' });

    const snap = chef.snapshot();
    // 4.1 wrote no lineage at all.
    delete (snap.modules.janitor as { window?: unknown }).window;

    expect(() => chef.restore(snap)).not.toThrow();
    const after = lineage(chef);
    expect(after?.current).toBe(after?.first);
    expect(after?.previous).toBeUndefined();
  });

  it('keeps an anchored() anchor with the window it belongs to', async () => {
    const instructions: string[] = [];
    const capturing = async (messages: Message[]): Promise<string> => {
      instructions.push(messages[messages.length - 1].content);
      return `<summary>ANCHOR-${instructions.length}</summary>`;
    };
    const config: ChefConfig = {
      overflow: { strategy: anchored({ compressionModel: capturing, split: 'recent-turns' }) },
    };

    const chef = chefWith(config);
    await chef.compile({ target: 'openai' });
    const snap = chef.snapshot();

    const restored = chefWith(config).restore(snap);
    await restored.compile({ target: 'openai' }); // suppressed after the restore
    await restored.compile({ target: 'openai' });

    expect(instructions[0]).toContain('No anchor document exists yet');
    // The second compression read back the anchor the first one filed under
    // the window the snapshot restored.
    expect(instructions[1]).toContain('ANCHOR-1');
  });

  it('names the closed window in the reset() stub', async () => {
    const chef = chefWith({ overflow: { strategy: reset() } });

    const first = await chef.compile({ target: 'openai' });
    const summary = first.messages
      .map((m) => String(m.content ?? ''))
      .find((content) => content.includes('Context window reset'));
    expect(summary).toBeDefined();

    // The stub names the window it closed; the payload reports the one it opened.
    expect(summary).toContain('Context window reset (window ');
    expect(summary).not.toContain(String(first.meta?.windowId));
    expect(summary).toContain(String(lineage(chef)?.previous));
  });
});
