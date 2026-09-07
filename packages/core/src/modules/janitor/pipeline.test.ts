import { describe, expect, it, vi } from 'vitest';
import {
  background,
  ContextChef,
  chain,
  type OverflowStrategy,
  reset,
  summarize,
} from '../../index';
import type { Message } from '../../types';
import { getRecallToolDefinition } from '../offloader/recallTool';
import { compactMessages, Janitor } from '.';

/** Tokenizer charging a flat cost per message. */
const makeTokenizer = (perMessage: number) => (messages: Message[]) => messages.length * perMessage;

const buildHistory = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg-${i + 1}`,
  }));

/** History whose compressed span is guaranteed past the shrink-guard floor. */
const buildLongHistory = (n: number, charsPerMessage = 1500): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg-${i + 1}: ${'x'.repeat(charsPerMessage)}`,
  }));

// ═══════════════════════════════════════════════════════
// Constraint pinning
// ═══════════════════════════════════════════════════════

describe('Janitor — constraint pinning', () => {
  it('re-inserts a pinned message verbatim after the summary (compress)', async () => {
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: mockModel,
    });

    const history = buildHistory(5);
    history[1] = { ...history[1], pinned: true, content: 'NEVER delete prod data' };

    const result = await janitor.compress(history);

    // summary, pinned message, then the kept tail
    expect(result[0].content).toContain('S');
    expect(result[1]).toEqual({
      role: 'assistant',
      content: 'NEVER delete prod data',
      pinned: true,
    });
    expect(result[result.length - 1].content).toBe('msg-5');
  });

  it('pins the whole atomic turn when any member is pinned (compress)', async () => {
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 10,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.1,
      compressionModel: mockModel,
    });

    const history: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        pinned: true,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result-1', tool_call_id: 'c1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ];

    const result = await janitor.compress(history);

    // The pinned assistant AND its tool result both survive, adjacent and in order.
    const assistantIdx = result.findIndex((m) => m.tool_calls?.[0]?.id === 'c1');
    expect(assistantIdx).toBeGreaterThan(0);
    expect(result[assistantIdx + 1]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('preserves pinned messages in the no-compressionModel fallback', async () => {
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
    });

    const history = buildHistory(5);
    history[0] = { ...history[0], pinned: true };

    const result = await janitor.compress(history);

    expect(result[0]).toMatchObject({ content: 'msg-1', pinned: true });
    expect(result[result.length - 1].content).toBe('msg-5');
  });

  it('compact never clears pinned tool results, thinking, or reasoning tags', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', content: 'old result', tool_call_id: 'c1', pinned: true },
      {
        role: 'assistant',
        content: '<think>secret</think>visible',
        pinned: true,
        thinking: { thinking: 'deep', signature: 'sig' },
      },
      {
        role: 'assistant',
        content: '<think>strippable</think>shown',
        thinking: { thinking: 'gone' },
      },
    ];

    const result = compactMessages(history, {
      clear: ['tool-result', 'thinking', 'reasoning-tags'],
    });

    // Pinned turn (indices 0-1: pinning the tool result pins the turn) untouched
    expect(result[1].content).toBe('old result');
    // Pinned assistant untouched
    expect(result[2].content).toBe('<think>secret</think>visible');
    expect(result[2].thinking).toEqual({ thinking: 'deep', signature: 'sig' });
    // Unpinned assistant cleared
    expect(result[3].content).toBe('shown');
    expect(result[3].thinking).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// compact() extensions — toolFilter / exemptTools / reasoning-tags
// ═══════════════════════════════════════════════════════

describe('compactMessages — toolFilter / exemptTools / reasoning-tags', () => {
  const toolHistory = (): Message[] => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'web_search', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'file contents', tool_call_id: 'c1' },
    { role: 'tool', content: 'search results', tool_call_id: 'c2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c3', type: 'function', function: { name: 'fs_read', arguments: '{}' } }],
    },
    { role: 'tool', content: 'more file contents', tool_call_id: 'c3' },
  ];

  it('toolFilter clears only results of the named tools', () => {
    const result = compactMessages(toolHistory(), {
      clear: [{ target: 'tool-result', toolFilter: ['fs_read'] }],
    });

    expect(result[1].content).toBe('[Old tool result content cleared]');
    expect(result[2].content).toBe('search results'); // web_search untouched
    expect(result[4].content).toBe('[Old tool result content cleared]');
  });

  it('exemptTools wins over toolFilter and plain clearing', () => {
    const result = compactMessages(toolHistory(), {
      clear: [{ target: 'tool-result', exemptTools: ['web_search'] }],
    });

    expect(result[1].content).toBe('[Old tool result content cleared]');
    expect(result[2].content).toBe('search results');
    expect(result[4].content).toBe('[Old tool result content cleared]');
  });

  it('keepRecent counts within the clearable set only', () => {
    const result = compactMessages(toolHistory(), {
      clear: [{ target: 'tool-result', toolFilter: ['fs_read'], keepRecent: 1 }],
    });

    // Clearable set = the two fs_read results; last one is preserved.
    expect(result[1].content).toBe('[Old tool result content cleared]');
    expect(result[2].content).toBe('search results');
    expect(result[4].content).toBe('more file contents');
  });

  it('a tool result with an unresolvable name is untouched when a filter is present', () => {
    const history: Message[] = [{ role: 'tool', content: 'orphan', tool_call_id: 'missing' }];
    const result = compactMessages(history, {
      clear: [{ target: 'tool-result', toolFilter: ['fs_read'] }],
    });
    expect(result[0].content).toBe('orphan');
  });

  it("'reasoning-tags' strips <think> blocks from assistant content only", () => {
    const history: Message[] = [
      { role: 'assistant', content: '<think>step 1\nstep 2</think>The answer is 42.' },
      { role: 'user', content: '<think>not stripped for users</think>hi' },
      { role: 'assistant', content: 'no tags here' },
    ];

    const result = compactMessages(history, { clear: ['reasoning-tags'] });

    expect(result[0].content).toBe('The answer is 42.');
    expect(result[1].content).toBe('<think>not stripped for users</think>hi');
    expect(result[2].content).toBe('no tags here');
  });
});

// ═══════════════════════════════════════════════════════
// Shrink guard
// ═══════════════════════════════════════════════════════

describe('Janitor — shrink guard', () => {
  it('treats a non-shrinking summary as a failure: history unchanged, breaker counts', async () => {
    // Echo model: returns the span text back (no shrink). Excludes the trailing
    // instruction message — echoing it would leak its <summary> example tags
    // into formatCompactSummary's extraction and yield a tiny fake summary.
    const echoModel = vi.fn(async (msgs: Message[]) =>
      msgs
        .slice(0, -1)
        .map((m) => m.content)
        .join('\n'),
    );
    const logger = { warn: vi.fn() };
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: echoModel,
      logger,
    });

    const history = buildLongHistory(5);
    const result = await janitor.compress(history);

    expect(result).toEqual(history);
    expect(janitor['_consecutiveFailures']).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shrink guard'));

    // Three non-shrinking rounds trip the breaker — no more model calls after.
    await janitor.compress(history);
    await janitor.compress(history);
    expect(janitor['_consecutiveFailures']).toBe(3);
    await janitor.compress(history);
    expect(echoModel).toHaveBeenCalledTimes(3);
  });

  it('minShrinkRatio: 0 disables the guard', async () => {
    const echoModel = vi.fn(async (msgs: Message[]) =>
      msgs
        .slice(0, -1)
        .map((m) => m.content)
        .join('\n'),
    );
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      minShrinkRatio: 0,
      compressionModel: echoModel,
    });

    const history = buildLongHistory(5);
    const result = await janitor.compress(history);

    expect(result[0].role).toBe('user'); // summary applied
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('does not apply to tiny spans (below the span-chars floor)', async () => {
    const echoModel = vi.fn(async (msgs: Message[]) =>
      msgs
        .slice(0, -1)
        .map((m) => m.content)
        .join('\n'),
    );
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: echoModel,
    });

    const result = await janitor.compress(buildHistory(5)); // tiny messages

    expect(result[0].role).toBe('user'); // compression applied despite echo
    expect(janitor['_consecutiveFailures']).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// validateCompression
// ═══════════════════════════════════════════════════════

describe('Janitor — validateCompression', () => {
  const makeJanitor = (
    validate: (summary: string, info: { compressed: Message[]; kept: Message[] }) => boolean,
    logger = { warn: vi.fn() },
  ) =>
    new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: vi.fn().mockResolvedValue('<summary>S</summary>'),
      validateCompression: validate,
      logger,
    });

  it('rejection leaves history unchanged and counts toward the breaker', async () => {
    const logger = { warn: vi.fn() };
    const janitor = makeJanitor(() => false, logger);
    const history = buildHistory(5);

    const result = await janitor.compress(history);

    expect(result).toEqual(history);
    expect(janitor['_consecutiveFailures']).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('validateCompression'));
  });

  it('a throwing validator is treated as rejection', async () => {
    const logger = { warn: vi.fn() };
    const janitor = makeJanitor(() => {
      throw new Error('validator crash');
    }, logger);
    const history = buildHistory(5);

    const result = await janitor.compress(history);

    expect(result).toEqual(history);
    expect(janitor['_consecutiveFailures']).toBe(1);
  });

  it('acceptance proceeds with the compression and receives both spans', async () => {
    const seen: { compressed: number; kept: number }[] = [];
    const janitor = makeJanitor((_summary, info) => {
      seen.push({ compressed: info.compressed.length, kept: info.kept.length });
      return true;
    });

    const result = await janitor.compress(buildHistory(5));

    expect(result[0].content).toContain('S');
    expect(seen).toHaveLength(1);
    expect(seen[0].compressed + seen[0].kept).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════
// Reversible archive + recall
// ═══════════════════════════════════════════════════════

describe('Janitor — reversible archive', () => {
  it('archives the compressed span and cites the URI in the summary', async () => {
    const stored: string[] = [];
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: vi.fn().mockResolvedValue('<summary>S</summary>'),
      archive: {
        store: (serialized) => {
          stored.push(serialized);
          return 'context://vfs/abc123.txt';
        },
      },
    });

    const result = await janitor.compress(buildHistory(5));

    expect(stored).toHaveLength(1);
    const parsed = JSON.parse(stored[0]);
    expect(parsed.version).toBe(1);
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.messages[0].content).toBe('msg-1');
    expect(result[0].content).toContain('context://vfs/abc123.txt');
    expect(result[0].content).toContain('archived in full');
  });

  it('archive store failure logs a warning and compression proceeds without a citation', async () => {
    const logger = { warn: vi.fn() };
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: vi.fn().mockResolvedValue('<summary>S</summary>'),
      archive: {
        store: () => {
          throw new Error('disk full');
        },
      },
      logger,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(result[0].content).toContain('S');
    expect(result[0].content).not.toContain('archived in full');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('archive store failed'),
      expect.any(Error),
    );
  });

  it("chef-level archive: 'vfs' round-trips through resolveRecall", async () => {
    // In-memory async VFS adapter — no filesystem involved.
    const files = new Map<string, string>();
    const adapter = {
      write: async (filename: string, content: string) => {
        files.set(filename, content);
      },
      read: async (filename: string) => files.get(filename) ?? null,
      exists: async (filename: string) => files.has(filename),
    };

    const chef = new ContextChef({
      vfs: { threshold: 999999, adapter },
      janitor: {
        contextWindow: 30,
        triggerRatio: 1,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        compressionModel: async () => '<summary>S</summary>',
        archive: 'vfs',
      },
    });

    chef.setHistory(buildHistory(5));
    const payload = await chef.compile({ target: 'openai' });

    const text = JSON.stringify(payload.messages);
    const uriMatch = text.match(/context:\/\/vfs\/[a-z0-9_.-]+/i);
    expect(uriMatch).not.toBeNull();

    const recalled = await chef.resolveRecall(uriMatch?.[0] ?? '');
    expect(recalled).not.toBeNull();
    const parsed = JSON.parse(recalled ?? '');
    expect(parsed.messages[0].content).toBe('msg-1');
  });

  it('getRecallToolDefinition returns a well-formed tool', () => {
    const tool = getRecallToolDefinition();
    expect(tool.name).toBe('recall_context');
    expect(JSON.stringify(tool.parameters)).toContain('uri');
  });
});

// ═══════════════════════════════════════════════════════
// compressionGuidelines
// ═══════════════════════════════════════════════════════

describe('Janitor — compressionGuidelines', () => {
  it('injects numbered guidelines into the compression instruction', async () => {
    const captured: Message[][] = [];
    const model = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<summary>S</summary>';
    });
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionGuidelines: ['Keep all file paths verbatim.', 'Record failed approaches.'],
      customCompressionInstructions: 'Also mind ticket IDs.',
    });

    await janitor.compress(buildHistory(5));

    const instruction = captured[0][captured[0].length - 1].content;
    expect(instruction).toContain('Domain Guidelines:\n1. Keep all file paths verbatim.');
    expect(instruction).toContain('2. Record failed approaches.');
    // Guidelines come before Additional Instructions
    expect(instruction.indexOf('Domain Guidelines')).toBeLessThan(
      instruction.indexOf('Additional Instructions'),
    );
  });

  it('empty guidelines add no section', async () => {
    const captured: Message[][] = [];
    const model = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<summary>S</summary>';
    });
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionGuidelines: ['  '],
    });

    await janitor.compress(buildHistory(5));

    expect(captured[0][captured[0].length - 1].content).not.toContain('Domain Guidelines');
  });
});

// ═══════════════════════════════════════════════════════
// Incremental anchored mode
// ═══════════════════════════════════════════════════════

describe('Janitor — incremental-anchored mode', () => {
  it('feeds the stored anchor into the next compression and updates it', async () => {
    const captured: Message[][] = [];
    let call = 0;
    const model = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      call++;
      return `<summary>ANCHOR-v${call}</summary>`;
    });
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionMode: 'incremental-anchored',
    });

    // First compression: no anchor yet
    const r1 = await janitor.compress(buildHistory(5));
    expect(captured[0][captured[0].length - 1].content).toContain('No anchor document exists yet');
    expect(janitor.getAnchorDoc()).toBe('ANCHOR-v1');
    expect(r1[0].content).toContain('ANCHOR-v1');

    // E10 suppression consumes the call right after a successful compression.
    await janitor.compress(buildHistory(7));

    // Second compression: instruction embeds the current anchor
    const r2 = await janitor.compress(buildHistory(7));
    const instruction2 = captured[1][captured[1].length - 1].content;
    expect(instruction2).toContain('<anchor>\nANCHOR-v1\n</anchor>');
    expect(janitor.getAnchorDoc()).toBe('ANCHOR-v2');
    expect(r2[0].content).toContain('ANCHOR-v2');
  });

  it('anchor survives snapshot/restore and clears on reset', async () => {
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: async () => '<summary>A1</summary>',
      compressionMode: 'incremental-anchored',
    });

    await janitor.compress(buildHistory(5));
    expect(janitor.getAnchorDoc()).toBe('A1');

    const snap = janitor.snapshotState();
    expect(snap.anchorDoc).toBe('A1');

    janitor.reset();
    expect(janitor.getAnchorDoc()).toBeNull();

    janitor.restoreState(snap);
    expect(janitor.getAnchorDoc()).toBe('A1');
  });
});

// ═══════════════════════════════════════════════════════
// Background scheduling
// ═══════════════════════════════════════════════════════

describe('Janitor — background compression scheduling', () => {
  const settled = (janitor: Janitor) =>
    vi.waitFor(() => {
      if (!janitor['_pendingBackground']?.settled) throw new Error('not settled');
    });

  it('first over-budget call returns unchanged and a later call swaps the result in', async () => {
    const model = vi.fn().mockResolvedValue('<summary>BG</summary>');
    const onCompress = vi.fn();
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
      onCompress,
    });

    const history = buildHistory(5);
    const r1 = await janitor.compress(history);
    expect(r1).toEqual(history); // unchanged this turn
    expect(model).toHaveBeenCalledTimes(1); // job started
    expect(onCompress).not.toHaveBeenCalled(); // finalize deferred to application

    await settled(janitor);

    const r2 = await janitor.compress(history);
    expect(r2[0].content).toContain('BG');
    expect(r2[r2.length - 1].content).toBe('msg-5');
    expect(onCompress).toHaveBeenCalledTimes(1); // fired at application time
  });

  it('discards a stale result when the compressed span is no longer a prefix', async () => {
    const model = vi.fn().mockResolvedValue('<summary>BG</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    await janitor.compress(buildHistory(5));
    await settled(janitor);

    // A genuinely DIFFERENT history: the boundary message's CONTENT changed,
    // so the content-equivalence staleness check must reject the swap.
    const other = buildHistory(6);
    other[0] = { ...other[0], content: 'edited-msg-1' };
    const r2 = await janitor.compress(other);

    expect(r2).toEqual(other); // stale result discarded, new job started instead
    expect(model).toHaveBeenCalledTimes(2);
    expect(janitor['_pendingBackground']).toBeDefined();
  });

  it('while a job is pending, further calls return history unchanged without new jobs', async () => {
    let release: (v: string) => void = () => {};
    const model = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    const history = buildHistory(5);
    await janitor.compress(history);
    const r2 = await janitor.compress(history);

    expect(r2).toEqual(history);
    expect(model).toHaveBeenCalledTimes(1);

    release('<summary>DONE</summary>');
    await settled(janitor);
    const r3 = await janitor.compress(history);
    expect(r3[0].content).toContain('DONE');
  });

  it('a failed background job never swaps in and counts toward the breaker', async () => {
    const model = vi.fn().mockRejectedValue(new Error('bg fail'));
    const logger = { warn: vi.fn() };
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
      logger,
    });

    const history = buildHistory(5);
    await janitor.compress(history);
    await settled(janitor);

    const r2 = await janitor.compress(history);
    expect(r2).toEqual(history); // failed job discarded; new job for fresh eval
    expect(janitor['_consecutiveFailures']).toBeGreaterThanOrEqual(1);
  });

  it('swaps a finished job in even after the history drops back under the trigger', async () => {
    let perMessage = 10;
    const model = vi.fn().mockResolvedValue('<summary>BG</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: (messages: Message[]) => messages.length * perMessage,
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    const history = buildHistory(5);
    expect(await janitor.compress(history)).toEqual(history); // job started
    await settled(janitor);

    // The caller trimmed, or the provider reported less: 5 tokens against a
    // 30-token trigger. The summary is already paid for and must still land —
    // otherwise the model keeps carrying the span it replaces.
    perMessage = 1;
    const swapped = await janitor.compress(history);

    expect(swapped[0].content).toContain('BG');
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('does not start a background job for a window that fits', async () => {
    let perMessage = 10;
    const model = vi.fn().mockResolvedValue('<summary>BG</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: (messages: Message[]) => messages.length * perMessage,
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    await janitor.compress(buildHistory(5));
    await settled(janitor);

    // A history the finished job no longer applies to, and no reason to
    // compress it either: the stale result is dropped without a replacement.
    perMessage = 1;
    const other = buildHistory(5);
    other[0] = { ...other[0], content: 'edited-msg-1' };
    expect(await janitor.compress(other)).toEqual(other);

    expect(model).toHaveBeenCalledTimes(1);
    expect(janitor['_pendingBackground']).toBeUndefined();
  });

  it('restoreState drops a pending background job', async () => {
    const model = vi.fn(() => new Promise<string>(() => {})); // never resolves
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    await janitor.compress(buildHistory(5));
    expect(janitor['_pendingBackground']).toBeDefined();

    janitor.restoreState(janitor.snapshotState());
    expect(janitor['_pendingBackground']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// Review-driven fixes (PR #47 review)
// ═══════════════════════════════════════════════════════

describe('Janitor — review fixes', () => {
  const settled = (janitor: Janitor) =>
    vi.waitFor(() => {
      if (!janitor['_pendingBackground']?.settled) throw new Error('not settled');
    });

  it('background swap-in ACCEPTS a recreated-but-equivalent boundary message', async () => {
    const model = vi.fn().mockResolvedValue('<summary>BG</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionScheduling: 'background',
    });

    await janitor.compress(buildHistory(5));
    await settled(janitor);

    // Same shape and content, entirely fresh objects (what transformToolResult
    // or a store round-trip produces) — the swap must still apply.
    const recreated = buildHistory(5);
    const r2 = await janitor.compress(recreated);

    expect(r2[0].content).toContain('BG');
    expect(model).toHaveBeenCalledTimes(1); // no wasteful re-spawn
  });

  it('a stale-discarded background job does NOT pollute the anchor document', async () => {
    let call = 0;
    const model = vi.fn(async () => {
      call++;
      return `<summary>ANCHOR-v${call}</summary>`;
    });
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: model,
      compressionMode: 'incremental-anchored',
      compressionScheduling: 'background',
    });

    await janitor.compress(buildHistory(5));
    await settled(janitor);
    expect(janitor.getAnchorDoc()).toBeNull(); // not applied yet — computation only

    // History changed at the boundary → job discarded as stale.
    const other = buildHistory(5);
    other[0] = { ...other[0], content: 'edited-msg-1' };
    await janitor.compress(other);

    expect(janitor.getAnchorDoc()).toBeNull(); // discarded job never wrote the anchor
  });

  it('blocking anchored compression applies the anchor at finalize', async () => {
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: async () => '<summary>A1</summary>',
      compressionMode: 'incremental-anchored',
    });

    await janitor.compress(buildHistory(5));
    expect(janitor.getAnchorDoc()).toBe('A1');
  });

  it('shrink guard counts tool-call arguments in the span size', async () => {
    // Span dominated by tool arguments: content is tiny, arguments are 10k chars.
    const history: Message[] = [
      { role: 'user', content: 'write the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ body: 'x'.repeat(10_000) }),
            },
          },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'and next' },
    ];

    // A faithful ~2.5k-char summary of that span must PASS the guard.
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: async () => `<summary>${'s'.repeat(2500)}</summary>`,
    });

    const result = await janitor.compress(history);

    expect(result[0].content).toContain('sss'); // compression applied
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('anchored mode guards on anchor GROWTH, not absolute anchor size', async () => {
    const bigAnchor = 'A'.repeat(9_000);
    let call = 0;
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      compressionModel: async () => {
        call++;
        // Second compression returns the big anchor + a modest addition —
        // absolute size >> span, but GROWTH is small.
        return call === 1
          ? `<summary>${bigAnchor}</summary>`
          : `<summary>${bigAnchor}addition</summary>`;
      },
      compressionMode: 'incremental-anchored',
      minShrinkRatio: 0.5,
    });

    // First compression establishes the big anchor. The span must be large
    // enough that a 9k-char initial anchor passes the growth guard
    // (allowance = 0.5 × spanChars).
    await janitor.compress(buildLongHistory(5, 5000));
    expect(janitor.getAnchorDoc()).toBe(bigAnchor);

    // E10 suppression consumes the call right after a successful compression.
    await janitor.compress(buildLongHistory(6, 5000));

    // Next compression over a long span: absolute anchor size (9k) far
    // exceeds naive shrink limits, but GROWTH (8 chars) passes easily.
    const r2 = await janitor.compress(buildLongHistory(6, 5000));
    expect(janitor.getAnchorDoc()).toBe(`${bigAnchor}addition`);
    expect(r2[0].content).toContain('addition');
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('compact() is idempotent on already-cleared tool results (stable identity)', () => {
    const janitor = new Janitor({ contextWindow: Infinity });
    const history: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
      },
      { role: 'tool', content: 'big output', tool_call_id: 'c1' },
    ];

    const once = janitor.compact(history, { clear: ['tool-result'] });
    const twice = janitor.compact(once, { clear: ['tool-result'] });

    expect(twice[1]).toBe(once[1]); // same object — no reference churn
    expect(twice[1].content).toBe('[Old tool result content cleared]');
  });
});

// ═══════════════════════════════════════════════════════
// Circuit breaker vs. the overflow as a whole
// ═══════════════════════════════════════════════════════

describe('Janitor — the breaker counts the overflow, not the step', () => {
  /** Seeds a failure count without going through three real failures. */
  const seedFailures = (janitor: Janitor, count: number): void => {
    janitor.restoreState({ ...janitor.snapshotState(), consecutiveFailures: count });
  };

  it('chain(summarize, reset) keeps rescuing the window past three model failures', async () => {
    const throwingModel = vi.fn().mockRejectedValue(new Error('API down'));
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      logger: { warn: vi.fn() },
      strategy: chain(summarize({ compressionModel: throwingModel }), reset()),
    });

    for (let round = 0; round < 4; round++) {
      // E10 suppression consumes the call right after a successful overflow.
      if (round > 0) await janitor.overflow(buildLongHistory(5));

      const result = await janitor.overflow(buildLongHistory(5));

      expect(result.meta.changed).toBe(true);
      expect(result.history).toHaveLength(1);
      expect(result.history[0].content).toContain('Context window reset');
      expect(janitor.snapshotState().consecutiveFailures).toBe(0);
    }

    expect(throwingModel).toHaveBeenCalledTimes(4);
  });

  it('a summarize() success clears a failure count the strategy never reports', async () => {
    let shouldFail = true;
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3,
      logger: { warn: vi.fn() },
      compressionModel: async () => {
        if (shouldFail) throw new Error('API down');
        return '<summary>S</summary>';
      },
    });

    await janitor.overflow(buildLongHistory(5));
    await janitor.overflow(buildLongHistory(5));
    expect(janitor['_consecutiveFailures']).toBe(2);

    shouldFail = false;
    const result = await janitor.overflow(buildLongHistory(5));

    expect(result.meta.changed).toBe(true);
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('a strategy that never calls succeed() still clears the count when its result lands', async () => {
    const stub: OverflowStrategy = {
      name: 'stub',
      async apply(input) {
        return {
          history: input.history.slice(-1),
          evicted: input.history.slice(0, -1),
          span: input.history.slice(0, -1),
          meta: { strategy: 'stub', windowId: input.window.current, changed: true },
        };
      },
    };
    const janitor = new Janitor({
      contextWindow: 30,
      triggerRatio: 1,
      tokenizer: makeTokenizer(10),
      strategy: stub,
    });
    seedFailures(janitor, 2);

    const result = await janitor.overflow(buildLongHistory(5));

    expect(result.meta.changed).toBe(true);
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  describe('background()', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('clears the count on the swap-in, not on the "started" result', async () => {
      const janitor = new Janitor({
        contextWindow: 30,
        triggerRatio: 1,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        strategy: background(summarize({ compressionModel: async () => '<summary>S</summary>' })),
      });
      seedFailures(janitor, 2);
      const history = buildLongHistory(5);

      const started = await janitor.overflow(history);
      expect(started.meta.changed).toBe(false);
      expect(janitor['_consecutiveFailures']).toBe(2);

      await settle();
      const swapped = await janitor.overflow(history);

      expect(swapped.meta.changed).toBe(true);
      expect(janitor['_consecutiveFailures']).toBe(0);
    });

    it('credits a job whose summary succeeded but whose history moved under it', async () => {
      const janitor = new Janitor({
        contextWindow: 30,
        triggerRatio: 1,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        strategy: background(summarize({ compressionModel: async () => '<summary>S</summary>' })),
      });
      seedFailures(janitor, 2);

      await janitor.overflow(buildLongHistory(5));
      await settle();
      // A different conversation entirely — the finished job no longer applies.
      const discarded = await janitor.overflow(buildLongHistory(5, 1600));

      expect(discarded.meta.changed).toBe(false);
      expect(janitor['_consecutiveFailures']).toBe(0);
    });

    it('a job that fails off-turn still counts toward the breaker', async () => {
      const janitor = new Janitor({
        contextWindow: 30,
        triggerRatio: 1,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        logger: { warn: vi.fn() },
        strategy: background(
          summarize({ compressionModel: async () => Promise.reject(new Error('API down')) }),
        ),
      });
      seedFailures(janitor, 2);

      await janitor.overflow(buildLongHistory(5));
      await settle();

      expect(janitor['_consecutiveFailures']).toBe(3);
      const blocked = await janitor.overflow(buildLongHistory(5));
      expect(blocked.meta.reason).toContain('circuit breaker open');
    });
  });
});
