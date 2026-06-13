import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../../index';
import { Prompts } from '../../prompts';
import type { Message } from '../../types';
import { compactMessages, groupIntoTurns, Janitor } from '.';

// ─── Helpers ───

const buildHistory = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `msg-${i + 1}`,
  }));

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

// ═══════════════════════════════════════════════════════
// Tokenizer path — precise per-message calculation
// ═══════════════════════════════════════════════════════

describe('Janitor — tokenizer path', () => {
  it('does NOT compress when tokens are within budget', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 1000,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50, well under 1000
      preserveRatio: 0.5,
      compressionModel: mockModel,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(result).toHaveLength(5);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('compresses when tokens exceed contextWindow', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>COMPRESSED</history_summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50 > 30
      preserveRatio: 0.3, // keep 9 tokens → 0 messages fit → keeps last 1
      compressionModel: mockModel,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('COMPRESSED');
    expect(result.length).toBeLessThan(buildHistory(5).length + 1);
  });

  it('preserveRatio defaults to DEFAULT_PRESERVE_RATIO', async () => {
    // 5 × 10 = 50 > 40, preserve = floor(40 * 0.8) = 32 → keeps 3 messages (30 ≤ 32)
    const mockModel = vi.fn().mockResolvedValue('<history_summary>DEFAULT</history_summary>');
    const janitor = new Janitor({
      contextWindow: 40,
      tokenizer: makeTokenizer(10),
      compressionModel: mockModel,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(result[0].role).toBe('user');
    // summary + 3 kept messages = 4
    expect(result).toHaveLength(4);
  });

  it('calls tokenizer with Message[] directly', async () => {
    const spy = vi.fn<(messages: Message[]) => number>().mockReturnValue(999999);
    const mockModel = vi.fn().mockResolvedValue('<history_summary>X</history_summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: spy,
      preserveRatio: 0.1,
      compressionModel: mockModel,
    });

    await janitor.compress(buildHistory(3));

    expect(spy).toHaveBeenCalled();
    const firstCallArg = spy.mock.calls[0][0];
    expect(Array.isArray(firstCallArg)).toBe(true);
    expect(firstCallArg[0]).toHaveProperty('role');
  });

  it('discards old messages without summary when no compressionModel', async () => {
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.3, // keep 9 tokens → 0 messages fit → keeps last 1
    });

    const result = await janitor.compress(buildHistory(5));

    // No summary message — just the preserved messages
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('msg-5');
  });

  it('also considers feedTokenUsage in tokenizer path (takes higher value)', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50, under 100
      preserveRatio: 0.3,
      compressionModel: mockModel,
    });

    // Local says 50, but external says 150 → triggers compression
    janitor.feedTokenUsage(150);
    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(result[0].role).toBe('user');
  });

  it('integrates with ContextChef.compile()', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>VIA_CHEF</history_summary>');
    const chef = new ContextChef({
      janitor: {
        contextWindow: 30,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        compressionModel: mockModel,
      },
    });

    chef.setHistory(buildHistory(5));
    const payload = await chef.compile();

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content).toContain('VIA_CHEF');
  });
});

// ═══════════════════════════════════════════════════════
// FeedTokenUsage path — full compression, keep last N
// ═══════════════════════════════════════════════════════

describe('Janitor — feedTokenUsage path (no tokenizer)', () => {
  it('does NOT compress when fed value is within contextWindow', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 200000,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(100000); // under 200k
    const result = await janitor.compress(buildHistory(10));

    expect(result).toHaveLength(10);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('compresses ALL except last 1 message by default', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>FULL</history_summary>');
    const janitor = new Janitor({
      contextWindow: 200000,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000); // over 200k
    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
    // summary + 1 preserved = 2
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('FULL');
    expect(result[1].content).toBe('msg-5'); // last message preserved
  });

  it('respects preserveRecentMessages config', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 200000,
      preserveRecentMessages: 3,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    const result = await janitor.compress(buildHistory(5));

    // summary + 3 preserved = 4
    expect(result).toHaveLength(4);
    expect(result[1].content).toBe('msg-3');
    expect(result[2].content).toBe('msg-4');
    expect(result[3].content).toBe('msg-5');
  });

  it('falls back to heuristic when no feedTokenUsage is provided', async () => {
    const janitor = new Janitor({
      contextWindow: 5, // Very low — heuristic should trigger compression
    });

    // No feedTokenUsage, no tokenizer → uses heuristic estimateObject
    const history = buildHistory(10); // 10 messages, heuristic will exceed 5 tokens
    const result = await janitor.compress(history);

    // No compressionModel → just keeps last 1 message (default preserveRecentMessages)
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('msg-10');
  });

  it('consumes feedTokenUsage after use', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 200000,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    await janitor.compress(buildHistory(5));
    expect(mockModel).toHaveBeenCalledTimes(1);

    // E10 suppresses next call
    await janitor.compress(buildHistory(5));
    expect(mockModel).toHaveBeenCalledTimes(1);

    // Third call: no fed value, heuristic is low → no compression
    await janitor.compress(buildHistory(5));
    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it('integrates with ContextChef.reportTokenUsage()', async () => {
    const mockModel = vi.fn().mockResolvedValue('<history_summary>CHEF</history_summary>');
    const chef = new ContextChef({
      janitor: {
        contextWindow: 200000,
        compressionModel: mockModel,
      },
    });

    chef.setHistory(buildHistory(5));
    chef.reportTokenUsage(250000);
    const payload = await chef.compile();

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(payload.messages[0].content).toContain('CHEF');
  });
});

// ═══════════════════════════════════════════════════════
// usagePreference — trigger source selection (tokenizer path)
// ═══════════════════════════════════════════════════════

describe('Janitor — usagePreference', () => {
  it("default 'max' uses Math.max(tokenizer, fed) — backward compatible", async () => {
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50, under 100
      preserveRatio: 0.3,
      compressionModel: mockModel,
      // usagePreference omitted → 'max'
    });

    janitor.feedTokenUsage(150); // fed pushes effective over the limit
    await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it("'feedFirst' ignores tokenizer over-estimate when fed is in budget", async () => {
    // Mixed-source scenario: the tokenizer over-estimates, but the API's
    // reported usage is the source of truth.
    // - tokenizer says 200 (5 × 40)
    // - fed says 60
    // - contextWindow = 100
    // 'max' would trigger (200 > 100), 'feedFirst' should NOT (60 ≤ 100).
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(40),
      compressionModel: mockModel,
      usagePreference: 'feedFirst',
    });

    janitor.feedTokenUsage(60);
    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);
  });

  it("'feedFirst' falls back to tokenizer when no fed value is present", async () => {
    // No fed value → must use tokenizer to evaluate budget.
    // - tokenizer says 200 (5 × 40), contextWindow = 100 → triggers compression.
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(40),
      preserveRatio: 0.3,
      compressionModel: mockModel,
      usagePreference: 'feedFirst',
    });

    // No feedTokenUsage call
    await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it("'feedFirst' DOES trigger when fed itself exceeds budget", async () => {
    // Reverse direction: tokenizer is calm but fed reports over-budget.
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50, under
      preserveRatio: 0.3,
      compressionModel: mockModel,
      usagePreference: 'feedFirst',
    });

    janitor.feedTokenUsage(150);
    await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it("'tokenizerFirst' ignores fed entirely", async () => {
    // - tokenizer says 50 (under), fed says 999 (way over).
    // - 'max' would trigger, 'tokenizerFirst' should NOT.
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: makeTokenizer(10),
      compressionModel: mockModel,
      usagePreference: 'tokenizerFirst',
    });

    janitor.feedTokenUsage(999);
    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);
  });

  it("'tokenizerFirst' triggers based on tokenizer alone when over budget", async () => {
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10), // 5 × 10 = 50 > 30
      preserveRatio: 0.3,
      compressionModel: mockModel,
      usagePreference: 'tokenizerFirst',
    });

    janitor.feedTokenUsage(0); // fed is fine, but should be ignored
    await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it('split index calculation always uses precise per-turn tokenization regardless of preference', async () => {
    // Feed a divergent value so the three preferences actually take DIFFERENT
    // trigger numbers — without this, all three would compute effectiveTokens
    // from the tokenizer alone and the test would not exercise its claim.
    //
    // Setup:
    //   tokenizer says 50 (5 × 10), fed says 99999, contextWindow 30, preserveRatio 0.3
    //   - 'max'           → effective = max(50, 99999) = 99999  → triggers
    //   - 'feedFirst'     → effective = 99999 ?? 50      = 99999  → triggers
    //   - 'tokenizerFirst'→ effective = 50                       → triggers (50 > 30)
    //
    //   In all three cases the per-turn split iteration uses the tokenizer
    //   (not the fed value), so the resulting split is identical:
    //   preserveTarget = floor(30 * 0.3) = 9 → 0 turns fit → keep last 1.
    const buildJanitor = (pref: 'max' | 'feedFirst' | 'tokenizerFirst') =>
      new Janitor({
        contextWindow: 30,
        tokenizer: makeTokenizer(10),
        preserveRatio: 0.3,
        compressionModel: vi.fn().mockResolvedValue('<summary>S</summary>'),
        usagePreference: pref,
      });

    const expectedLength = 2; // summary + 1 preserved

    for (const pref of ['max', 'feedFirst', 'tokenizerFirst'] as const) {
      const janitor = buildJanitor(pref);
      janitor.feedTokenUsage(99999);
      const result = await janitor.compress(buildHistory(5));
      expect(result, `preference=${pref}`).toHaveLength(expectedLength);
      expect(result[result.length - 1].content, `preference=${pref}`).toBe('msg-5');
    }
  });

  it("'feedFirst' on no-tokenizer path is a no-op (same as default)", async () => {
    // No tokenizer → only fed/heuristic available. usagePreference is purely
    // declarative here; both 'max' and 'feedFirst' produce identical runtime behavior.
    const mockModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 200000,
      compressionModel: mockModel,
      usagePreference: 'feedFirst',
    });

    janitor.feedTokenUsage(250000); // over budget
    const result = await janitor.compress(buildHistory(5));

    expect(mockModel).toHaveBeenCalledTimes(1);
    // summary + 1 preserved (default preserveRecentMessages)
    expect(result).toHaveLength(2);
  });

  it('integrates with ContextChef via reportTokenUsage()', async () => {
    const mockModel = vi.fn().mockResolvedValue('<summary>VIA_CHEF</summary>');
    const chef = new ContextChef({
      janitor: {
        contextWindow: 100,
        tokenizer: makeTokenizer(40), // over-estimating tokenizer
        compressionModel: mockModel,
        usagePreference: 'feedFirst',
      },
    });

    chef.setHistory(buildHistory(5));
    chef.reportTokenUsage(60); // truth from API: under budget
    await chef.compile();

    expect(mockModel).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// onBudgetExceeded hook
// ═══════════════════════════════════════════════════════

describe('Janitor — onBudgetExceeded hook', () => {
  it('fires with token info before compression', async () => {
    const onBudgetExceeded = vi.fn().mockReturnValue(null);
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      onBudgetExceeded,
    });

    await janitor.compress(buildHistory(5));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    const [, tokenInfo] = onBudgetExceeded.mock.calls[0];
    expect(tokenInfo.currentTokens).toBe(50);
    expect(tokenInfo.limit).toBe(30);
  });

  it('skips compression when hook brings history under budget', async () => {
    const onBudgetExceeded = vi.fn().mockImplementation((history: Message[]) => {
      return history.slice(-2); // 2 × 10 = 20 ≤ 30
    });
    const compressionModel = vi.fn().mockResolvedValue('summary');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
      onBudgetExceeded,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(compressionModel).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('does NOT fire when under budget', async () => {
    const onBudgetExceeded = vi.fn();
    const janitor = new Janitor({
      contextWindow: 1000,
      tokenizer: makeTokenizer(10),
      onBudgetExceeded,
    });

    await janitor.compress(buildHistory(5));

    expect(onBudgetExceeded).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// E10: Compression suppression
// ═══════════════════════════════════════════════════════

describe('Janitor — E10 compression suppression', () => {
  it('suppresses check immediately after compression, resumes after', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(1);

    // Suppressed (E10)
    const result2 = await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(result2).toHaveLength(5);

    // Resumes
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════
// Snapshot, restore, reset
// ═══════════════════════════════════════════════════════

describe('Janitor — snapshot & restore', () => {
  it('captures and restores all internal state', () => {
    const janitor = new Janitor({ contextWindow: 100, tokenizer: makeTokenizer(10) });

    janitor.feedTokenUsage(999);
    janitor['_suppressNextCompression'] = true;
    const snap = janitor.snapshotState();

    janitor.reset();
    expect(janitor['_externalTokenUsage']).toBeNull();
    expect(janitor['_suppressNextCompression']).toBe(false);

    janitor.restoreState(snap);
    expect(janitor['_externalTokenUsage']).toBe(999);
    expect(janitor['_suppressNextCompression']).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// onCompress hook
// ═══════════════════════════════════════════════════════

describe('Janitor — onCompress hook', () => {
  it('fires with summary message and truncated count', async () => {
    const onCompress = vi.fn<(summary: Message, count: number) => void>();
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel: async () => '<history_summary>S</history_summary>',
      onCompress,
    });

    await janitor.compress(buildHistory(5));

    expect(onCompress).toHaveBeenCalledTimes(1);
    const [summaryMsg, count] = onCompress.mock.calls[0];
    expect(summaryMsg.role).toBe('user');
    expect(count).toBeGreaterThan(0);
  });

  it('passes the compressed slice as boundary details', async () => {
    const onCompress = vi.fn();
    const history = buildHistory(5);
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel: async () => '<history_summary>S</history_summary>',
      onCompress,
    });
    await janitor.compress(history);
    const [, count, details] = onCompress.mock.calls[0];
    expect(details.compressedMessages).toEqual(history.slice(0, count));
    expect(details.compressedMessages).toHaveLength(count);
  });

  it('passes boundary details in the no-compressionModel fallback too', async () => {
    const onCompress = vi.fn();
    const history = buildHistory(5);
    const janitor = new Janitor({ contextWindow: 30, tokenizer: makeTokenizer(10), onCompress });
    await janitor.compress(history);
    const [, count, details] = onCompress.mock.calls[0];
    expect(details.compressedMessages).toEqual(history.slice(0, count));
  });
});

// ═══════════════════════════════════════════════════════
// Turn-based grouping
// ═══════════════════════════════════════════════════════

describe('groupIntoTurns', () => {
  it('groups single messages into individual turns', () => {
    const history: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'bye' },
    ];
    const turns = groupIntoTurns(history);
    expect(turns).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 1, endIndex: 2 },
      { startIndex: 2, endIndex: 3 },
    ]);
  });

  it('groups assistant+tool_calls with subsequent tool results as atomic turn', () => {
    const history: Message[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: 'searching',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 's', arguments: '{}' } }],
      },
      { role: 'tool', content: 'found', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done' },
    ];
    const turns = groupIntoTurns(history);
    expect(turns).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 1, endIndex: 3 }, // assistant+tool atomic
      { startIndex: 3, endIndex: 4 },
    ]);
  });

  it('groups parallel tool_calls with all tool results', () => {
    const history: Message[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: 'running',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result a', tool_call_id: 'c1' },
      { role: 'tool', content: 'result b', tool_call_id: 'c2' },
      { role: 'assistant', content: 'done' },
    ];
    const turns = groupIntoTurns(history);
    expect(turns).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 1, endIndex: 4 }, // assistant + 2 tools
      { startIndex: 4, endIndex: 5 },
    ]);
  });

  it('handles consecutive user messages as separate turns', () => {
    const history: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'response' },
    ];
    const turns = groupIntoTurns(history);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({ startIndex: 0, endIndex: 1 });
    expect(turns[1]).toEqual({ startIndex: 1, endIndex: 2 });
  });

  it('handles system messages as individual turns', () => {
    const history: Message[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ];
    const turns = groupIntoTurns(history);
    expect(turns).toHaveLength(2);
  });

  it('handles empty history', () => {
    expect(groupIntoTurns([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// Turn-based compression (replaces adjustSplitIndex)
// ═══════════════════════════════════════════════════════

describe('Janitor — turn-based compression', () => {
  const buildToolHistory = (): Message[] => [
    { role: 'user', content: 'search for X' },
    {
      role: 'assistant',
      content: 'I will search',
      tool_calls: [
        { id: 'c1', type: 'function' as const, function: { name: 'search', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'results...', tool_call_id: 'c1' },
    {
      role: 'assistant',
      content: 'Found it. Let me read.',
      tool_calls: [
        { id: 'c2', type: 'function' as const, function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'file content', tool_call_id: 'c2' },
    { role: 'assistant', content: 'Here is the result' },
    { role: 'user', content: 'thanks' },
  ];

  it('never splits tool pairs (atomic turn grouping)', async () => {
    const mockModel = vi.fn().mockResolvedValue('summary');
    const janitor = new Janitor({
      contextWindow: 200000,
      preserveRecentMessages: 3,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    const history = buildToolHistory();
    const result = await janitor.compress(history);

    // No orphan tool results — turn-based grouping guarantees this
    for (const msg of result) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        const hasMatchingAssistant = result.some(
          (m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === msg.tool_call_id),
        );
        expect(hasMatchingAssistant).toBe(true);
      }
    }
  });

  it('handles parallel tool_calls as atomic unit', async () => {
    const history: Message[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: 'Running both',
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function' as const, function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result a', tool_call_id: 'c1' },
      { role: 'tool', content: 'result b', tool_call_id: 'c2' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'ok' },
    ];

    const mockModel = vi.fn().mockResolvedValue('summary');
    const janitor = new Janitor({
      contextWindow: 200000,
      preserveRecentMessages: 2,
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    const result = await janitor.compress(history);

    // No orphan tool results
    for (const msg of result) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        const hasMatch = result.some(
          (m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === msg.tool_call_id),
        );
        expect(hasMatch).toBe(true);
      }
    }
  });

  it('preserveRecentMessages counts turns, not individual messages', async () => {
    // History: [user, assistant+tool(c1), tool(c1), assistant, user]
    // Turns:   [user], [assistant+tool], [assistant], [user]  = 4 turns
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'running',
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'run', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'output', tool_call_id: 'c1' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ];

    const mockModel = vi.fn().mockResolvedValue('summary');
    const janitor = new Janitor({
      contextWindow: 200000,
      preserveRecentMessages: 2, // keep last 2 turns → [assistant "done", user "thanks"]
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    const result = await janitor.compress(history);

    // summary + assistant "done" + user "thanks" = 3
    expect(result).toHaveLength(3);
    expect(result[0].content).toContain('summary'); // compressed summary
    expect(result[1]).toEqual({ role: 'assistant', content: 'done' });
    expect(result[2]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('keeps assistant+tools as single unit when preserving', async () => {
    // History: [user, assistant+tools+2results, assistant, user]
    // Turns:   [user], [assistant+tool+tool], [assistant], [user] = 4 turns
    const history: Message[] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function' as const, function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'r1', tool_call_id: 'c1' },
      { role: 'tool', content: 'r2', tool_call_id: 'c2' },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'ok' },
    ];

    const mockModel = vi.fn().mockResolvedValue('summary');
    const janitor = new Janitor({
      contextWindow: 200000,
      preserveRecentMessages: 3, // keep last 3 turns → [assistant+2tools, assistant, user]
      compressionModel: mockModel,
    });

    janitor.feedTokenUsage(250000);
    const result = await janitor.compress(history);

    // summary(1) + assistant+tool+tool(3) + assistant(1) + user(1) = 6
    expect(result).toHaveLength(6);
    expect(result[0].content).toContain('summary');
    expect(result[1].role).toBe('assistant');
    expect(result[1].tool_calls).toHaveLength(2);
    expect(result[2].role).toBe('tool');
    expect(result[3].role).toBe('tool');
    expect(result[4].role).toBe('assistant');
    expect(result[5].role).toBe('user');
  });
});

// ═══════════════════════════════════════════════════════
// Prompts.formatCompactSummary — XML tag cleanup utility
// ═══════════════════════════════════════════════════════

describe('Prompts.formatCompactSummary', () => {
  it('extracts <summary> content and strips <analysis> scratchpad', () => {
    const raw =
      '<analysis>thinking through the conversation</analysis>\n<summary>Final result</summary>';
    expect(Prompts.formatCompactSummary(raw)).toBe('Final result');
  });

  it('returns content when only <summary> tag is present', () => {
    const raw = '<summary>Just the summary</summary>';
    expect(Prompts.formatCompactSummary(raw)).toBe('Just the summary');
  });

  it('strips <analysis> blocks even when no <summary> tag is present', () => {
    const raw = '<analysis>draft</analysis>\n\nRaw text without summary tag';
    expect(Prompts.formatCompactSummary(raw)).toBe('Raw text without summary tag');
  });

  it('returns plain text unchanged when no tags are present', () => {
    expect(Prompts.formatCompactSummary('plain text no tags')).toBe('plain text no tags');
  });

  it('handles empty input', () => {
    expect(Prompts.formatCompactSummary('')).toBe('');
  });

  it('is case-insensitive for tags', () => {
    const raw = '<ANALYSIS>draft</ANALYSIS><SUMMARY>final</SUMMARY>';
    expect(Prompts.formatCompactSummary(raw)).toBe('final');
  });

  it('strips multiple <analysis> blocks', () => {
    const raw = '<analysis>first</analysis><analysis>second</analysis><summary>result</summary>';
    expect(Prompts.formatCompactSummary(raw)).toBe('result');
  });

  it('collapses 3+ consecutive newlines into 2', () => {
    const raw = '<summary>line1\n\n\n\n\nline2</summary>';
    expect(Prompts.formatCompactSummary(raw)).toBe('line1\n\nline2');
  });

  it('handles multiline <summary> content correctly', () => {
    const raw = `<analysis>
reviewing...
</analysis>
<summary>
1. Task Overview:
   User requested X

2. Current State:
   - Done Y
</summary>`;
    const result = Prompts.formatCompactSummary(raw);
    expect(result).toContain('1. Task Overview:');
    expect(result).toContain('2. Current State:');
    expect(result).not.toContain('reviewing');
    expect(result).not.toContain('<analysis>');
    expect(result).not.toContain('<summary>');
  });

  it('preserves content when <summary> contains nested code blocks', () => {
    const raw = '<summary>Here is code:\n```ts\nfoo();\n```\nEnd.</summary>';
    const result = Prompts.formatCompactSummary(raw);
    expect(result).toContain('```ts');
    expect(result).toContain('foo();');
  });

  it('trims leading/trailing whitespace from extracted content', () => {
    const raw = '<summary>\n\n   content   \n\n</summary>';
    expect(Prompts.formatCompactSummary(raw)).toBe('content');
  });
});

// ═══════════════════════════════════════════════════════
// customCompressionInstructions — additive prompt customization
// ═══════════════════════════════════════════════════════

describe('Janitor — customCompressionInstructions', () => {
  it('appends additional instructions to the default prompt', async () => {
    const compressionModel = vi
      .fn<(msgs: Message[]) => Promise<string>>()
      .mockResolvedValue('<summary>s</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
      customCompressionInstructions: 'Focus on ticket IDs and customer sentiment.',
    });

    await janitor.compress(buildHistory(5));

    expect(compressionModel).toHaveBeenCalledTimes(1);
    const msgs = compressionModel.mock.calls[0][0];
    const lastMessage = msgs[msgs.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain(Prompts.CONTEXT_COMPACTION_INSTRUCTION);
    expect(lastMessage.content).toContain('Additional Instructions:');
    expect(lastMessage.content).toContain('Focus on ticket IDs and customer sentiment.');
  });

  it('does not add "Additional Instructions" section when empty', async () => {
    const compressionModel = vi
      .fn<(msgs: Message[]) => Promise<string>>()
      .mockResolvedValue('<summary>s</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
      customCompressionInstructions: '   ', // whitespace only
    });

    await janitor.compress(buildHistory(5));

    const msgs = compressionModel.mock.calls[0][0];
    const lastMessage = msgs[msgs.length - 1];
    expect(lastMessage.content).not.toContain('Additional Instructions:');
  });

  it('works without customCompressionInstructions (backward compatibility)', async () => {
    const compressionModel = vi
      .fn<(msgs: Message[]) => Promise<string>>()
      .mockResolvedValue('<summary>s</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    await janitor.compress(buildHistory(5));

    const msgs = compressionModel.mock.calls[0][0];
    const lastMessage = msgs[msgs.length - 1];
    expect(lastMessage.content).toBe(Prompts.CONTEXT_COMPACTION_INSTRUCTION);
  });
});

// ═══════════════════════════════════════════════════════
// formatCompactSummary integration in executeCompression
// ═══════════════════════════════════════════════════════

describe('Janitor — compression output cleanup', () => {
  it('strips <analysis> and extracts <summary> from compressionModel output', async () => {
    const rawOutput = '<analysis>scratchpad content</analysis>\n<summary>CLEAN_SUMMARY</summary>';
    const compressionModel = vi.fn().mockResolvedValue(rawOutput);
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const result = await janitor.compress(buildHistory(5));

    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('CLEAN_SUMMARY');
    expect(result[0].content).not.toContain('scratchpad content');
    expect(result[0].content).not.toContain('<analysis>');
    expect(result[0].content).not.toContain('<summary>');
  });

  it('passes through raw text when no recognized tags present', async () => {
    const compressionModel = vi.fn().mockResolvedValue('just plain text');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const result = await janitor.compress(buildHistory(5));
    expect(result[0].content).toContain('just plain text');
  });
});

// ═══════════════════════════════════════════════════════
// Circuit breaker — prevents infinite retry on compression failures
// ═══════════════════════════════════════════════════════

describe('Janitor — compression circuit breaker', () => {
  it('short-circuits compress() after 3 consecutive failures', async () => {
    const compressionModel = vi.fn().mockRejectedValue(new Error('API down'));
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    // Each call exceeds budget and tries to compress. E10 suppression alternates,
    // so we need to alternate calls to exercise the breaker.
    // First failure
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(janitor['_consecutiveFailures']).toBe(1);

    // E10 suppresses next call (no compressionModel invocation)
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(1);

    // Second failure
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(janitor['_consecutiveFailures']).toBe(2);

    // E10 suppresses
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(2);

    // Third failure — breaker trips after this
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(3);
    expect(janitor['_consecutiveFailures']).toBe(3);

    // Further calls: breaker is tripped, compress() returns history unchanged
    // and never calls compressionModel
    const history = buildHistory(5);
    const result = await janitor.compress(history);
    expect(compressionModel).toHaveBeenCalledTimes(3); // unchanged
    expect(result).toEqual(history); // history returned as-is

    // Keep trying — breaker stays tripped
    await janitor.compress(buildHistory(5));
    await janitor.compress(buildHistory(5));
    expect(compressionModel).toHaveBeenCalledTimes(3);
  });

  it('resets failure counter on successful compression', async () => {
    let shouldFail = true;
    const compressionModel = vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error('fail');
      return '<summary>ok</summary>';
    });
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    // Fail twice
    await janitor.compress(buildHistory(5));
    await janitor.compress(buildHistory(5)); // E10 suppressed
    await janitor.compress(buildHistory(5));
    expect(janitor['_consecutiveFailures']).toBe(2);

    // Flip to success
    shouldFail = false;
    await janitor.compress(buildHistory(5)); // E10 suppressed
    await janitor.compress(buildHistory(5)); // success
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('reset() clears failure counter', async () => {
    const compressionModel = vi.fn().mockRejectedValue(new Error('fail'));
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    await janitor.compress(buildHistory(5));
    await janitor.compress(buildHistory(5)); // E10 suppressed
    await janitor.compress(buildHistory(5));
    expect(janitor['_consecutiveFailures']).toBe(2);

    janitor.reset();
    expect(janitor['_consecutiveFailures']).toBe(0);
  });

  it('snapshot/restore preserves failure counter', async () => {
    const compressionModel = vi.fn().mockRejectedValue(new Error('fail'));
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    await janitor.compress(buildHistory(5));
    await janitor.compress(buildHistory(5)); // E10 suppressed
    await janitor.compress(buildHistory(5));
    expect(janitor['_consecutiveFailures']).toBe(2);

    const snap = janitor.snapshotState();
    expect(snap.consecutiveFailures).toBe(2);

    janitor.reset();
    expect(janitor['_consecutiveFailures']).toBe(0);

    janitor.restoreState(snap);
    expect(janitor['_consecutiveFailures']).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// Media-aware compression: attachments → text placeholders
// ═══════════════════════════════════════════════════════

describe('Janitor — media-aware compression', () => {
  it('replaces attachments in toCompress with [image]/[document] placeholders before the compression call', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const history: Message[] = [
      {
        role: 'user',
        content: 'Look at this',
        attachments: [
          { mediaType: 'image/png', data: 'BIG_BASE64_IMG', filename: 'photo.png' },
          { mediaType: 'application/pdf', data: 'PDF_BASE64' },
        ],
      },
      { role: 'assistant', content: 'I see' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Latest' },
    ];

    await janitor.compress(history);

    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    const userMsg = passedMessages.find(
      (m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes('Look at this'),
    );
    expect(userMsg).toBeDefined();
    expect(userMsg?.attachments).toBeUndefined();
    // Filename surfaces in the placeholder when available; non-image media renders as [document]
    expect(userMsg?.content).toContain('[image: photo.png]');
    expect(userMsg?.content).toContain('[document]');
    // Original text remains
    expect(userMsg?.content).toContain('Look at this');
    // Binary payloads must never reach the compression model
    expect(userMsg?.content).not.toContain('BIG_BASE64_IMG');
    expect(userMsg?.content).not.toContain('PDF_BASE64');
  });

  it('passes through messages without attachments unchanged (no synthetic markers)', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    await janitor.compress(buildHistory(5));

    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    // The trailing message is the appended instruction; skip it.
    const compressedMessages = passedMessages.slice(0, -1);
    for (const m of compressedMessages) {
      expect(m.attachments).toBeUndefined();
      expect(typeof m.content).toBe('string');
      expect(m.content as string).not.toMatch(/\[(?:image|document)/);
    }
  });

  it('preserves attachments on toKeep messages — only the toCompress slice is rewritten', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const oldAttachment = { mediaType: 'image/jpeg', data: 'OLD_DATA' };
    const recentAttachment = { mediaType: 'image/png', data: 'RECENT_DATA' };
    const history: Message[] = [
      { role: 'user', content: 'Old', attachments: [oldAttachment] },
      { role: 'assistant', content: 'Saw old' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Recent', attachments: [recentAttachment] },
    ];

    const result = await janitor.compress(history);

    // toCompress slice: attachments stripped → placeholders injected
    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    const compressedUser = passedMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('Old'),
    );
    expect(compressedUser?.attachments).toBeUndefined();
    expect(compressedUser?.content).toContain('[image]');

    // Compressed return value: toKeep messages retain their original attachments verbatim
    const recentInResult = result.find((m) => m.attachments?.length);
    expect(recentInResult).toBeDefined();
    expect(recentInResult?.attachments?.[0]).toEqual(recentAttachment);
  });

  it('does not mutate the input history', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const attachment = { mediaType: 'image/png', data: 'ORIGINAL' };
    const history: Message[] = [
      { role: 'user', content: 'Hi', attachments: [attachment] },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Latest' },
    ];

    await janitor.compress(history);

    // Original history object must remain untouched
    expect(history[0].attachments).toEqual([attachment]);
    expect(history[0].content).toBe('Hi');
  });

  it('uses [attachment] for empty mediaType, never the misleading [document]', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const history: Message[] = [
      { role: 'user', content: 'Mystery file', attachments: [{ mediaType: '', data: 'X' }] },
      { role: 'assistant', content: 'Got it' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Latest' },
    ];

    await janitor.compress(history);

    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    const userMsg = passedMessages.find(
      (m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes('Mystery file'),
    );
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain('[attachment]');
    expect(userMsg?.content).not.toContain('[document]');
  });

  it('treats empty attachments array as no attachments (no synthetic markers)', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const history: Message[] = [
      { role: 'user', content: 'Plain', attachments: [] },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Latest' },
    ];

    await janitor.compress(history);

    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    const passedMsg = passedMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Plain'),
    );
    expect(passedMsg).toBeDefined();
    expect(passedMsg?.content).not.toContain('[image');
    expect(passedMsg?.content).not.toContain('[document');
    expect(passedMsg?.content).not.toContain('[attachment');
    // stripAttachmentsForCompression returns the original message by reference when
    // attachments is empty, so the empty array survives rather than being deleted.
    expect(passedMsg?.attachments).toEqual([]);
  });

  it('case-insensitive mediaType prefix matching', async () => {
    const compressionModel = vi.fn().mockResolvedValue('<summary>S</summary>');
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel,
    });

    const history: Message[] = [
      {
        role: 'user',
        content: 'Photo upload',
        attachments: [{ mediaType: 'IMAGE/PNG', data: 'X' }],
      },
      { role: 'assistant', content: 'Nice' },
      { role: 'user', content: 'Mid' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Latest' },
    ];

    await janitor.compress(history);

    const passedMessages = compressionModel.mock.calls[0][0] as Message[];
    const userMsg = passedMessages.find(
      (m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes('Photo upload'),
    );
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain('[image]');
    expect(userMsg?.content).not.toContain('[document]');
  });
});

// ═══════════════════════════════════════════════════════
// Injected logger — constructor warning routing
// ═══════════════════════════════════════════════════════

describe('Janitor — injected logger', () => {
  it('routes the missing-tokenizer warning to the injected logger', () => {
    const logger = { warn: vi.fn() };
    new Janitor({ contextWindow: 100, logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('No tokenizer and no compressionModel');
  });
});

// ═══════════════════════════════════════════════════════
// toolResultStubThreshold — mechanical tool-result trim
// ═══════════════════════════════════════════════════════

describe('Janitor — toolResultStubThreshold', () => {
  // Helper: build a history with assistant.tool_calls + matching tool result.
  // contentSize controls the tool result body length so the test can decide
  // whether it should land above or below the stub threshold.
  const makeToolHistory = (toolName: string, contentSize: number): Message[] => [
    { role: 'user', content: 'find the bug' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: toolName, arguments: '{}' },
        },
      ],
    },
    { role: 'tool', content: 'X'.repeat(contentSize), tool_call_id: 'call_x' },
    { role: 'user', content: 'thanks' },
  ];

  it('replaces large tool-result content with a stub before summarization', async () => {
    const captured: Message[][] = [];
    const mockModel = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<history_summary>S</history_summary>';
    });
    const janitor = new Janitor({
      contextWindow: 10,
      tokenizer: makeTokenizer(10), // 4 × 10 = 40 > 10 → triggers compress
      preserveRatio: 0.1, // keep ~1 token → ~0 messages preserved
      compressionModel: mockModel,
      toolResultStubThreshold: 100,
    });

    await janitor.compress(makeToolHistory('fs_read', 5000));

    expect(mockModel).toHaveBeenCalledTimes(1);
    const sentToSummarizer = captured[0];
    const toolMsg = sentToSummarizer.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe(
      '[Tool fs_read returned 5000 chars; omitted before summarization]',
    );
    // Tool messages keep their tool_call_id (structural pairing intact)
    expect(toolMsg?.tool_call_id).toBe('call_x');
  });

  it('passes tool results below threshold through unchanged', async () => {
    const captured: Message[][] = [];
    const mockModel = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<history_summary>S</history_summary>';
    });
    const janitor = new Janitor({
      contextWindow: 10,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.1,
      compressionModel: mockModel,
      toolResultStubThreshold: 1000,
    });

    await janitor.compress(makeToolHistory('fs_read', 50));

    const toolMsg = captured[0].find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('X'.repeat(50));
  });

  it('falls back to "unknown" when tool name cannot be resolved', async () => {
    const captured: Message[][] = [];
    const mockModel = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<history_summary>S</history_summary>';
    });
    const janitor = new Janitor({
      contextWindow: 10,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.1,
      compressionModel: mockModel,
      toolResultStubThreshold: 100,
    });

    // History has a tool message whose tool_call_id matches NO assistant.tool_calls
    const history: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', content: 'X'.repeat(2000), tool_call_id: 'orphan_id' },
      { role: 'user', content: 'next' },
    ];

    await janitor.compress(history);

    const toolMsg = captured[0].find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe(
      '[Tool unknown returned 2000 chars; omitted before summarization]',
    );
  });

  it('does NOT stub when toolResultStubThreshold is unset (default behavior preserved)', async () => {
    const captured: Message[][] = [];
    const mockModel = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<history_summary>S</history_summary>';
    });
    const janitor = new Janitor({
      contextWindow: 10,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.1,
      compressionModel: mockModel,
      // toolResultStubThreshold intentionally omitted
    });

    await janitor.compress(makeToolHistory('fs_read', 5000));

    const toolMsg = captured[0].find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('X'.repeat(5000));
  });

  it('does NOT stub tool results inside the preserved (recent) portion', async () => {
    const captured: Message[][] = [];
    const mockModel = vi.fn(async (msgs: Message[]) => {
      captured.push(msgs);
      return '<history_summary>S</history_summary>';
    });
    // 8 messages × 10 tokens = 80 tokens current
    // contextWindow=50 → triggers compress; preserveTarget = 50 × 0.6 = 30
    // Iterating turns from tail: q4(10) + assistant+tool_b(20) = 30 exactly fit
    // → splitIndex lands between turn 3 (q3) and turn 4 (assistant_b),
    //   so toCompress = first 5 messages (call_a tool included),
    //   toKeep    = last 3 messages (call_b tool preserved verbatim).
    const janitor = new Janitor({
      contextWindow: 50,
      tokenizer: makeTokenizer(10),
      preserveRatio: 0.6,
      compressionModel: mockModel,
      toolResultStubThreshold: 100,
    });

    const history: Message[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'old_tool', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'A'.repeat(2000), tool_call_id: 'call_a' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_b', type: 'function', function: { name: 'recent_tool', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'B'.repeat(2000), tool_call_id: 'call_b' },
      { role: 'user', content: 'q4' },
    ];

    const result = await janitor.compress(history);

    // The recent tool message must survive untouched in the final result.
    const recentToolInResult = result.find((m) => m.role === 'tool' && m.tool_call_id === 'call_b');
    expect(recentToolInResult).toBeDefined();
    expect(recentToolInResult?.content).toBe('B'.repeat(2000));

    // What was sent to the summarizer should have the OLD tool stubbed.
    expect(mockModel).toHaveBeenCalledTimes(1);
    const toolInSummarizerInput = captured[0].find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_a',
    );
    expect(toolInSummarizerInput?.content).toBe(
      '[Tool old_tool returned 2000 chars; omitted before summarization]',
    );
    // Recent tool should NOT have been sent to the summarizer at all.
    const recentToolInSummarizerInput = captured[0].find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_b',
    );
    expect(recentToolInSummarizerInput).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// compactMessages — pure exported function
// ═══════════════════════════════════════════════════════

describe('compactMessages (pure)', () => {
  const history: Message[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1', thinking: { thinking: 'hmm' } },
    { role: 'tool', content: 'result-1', tool_call_id: 't1' },
    { role: 'user', content: 'q2' },
    { role: 'tool', content: 'result-2', tool_call_id: 't2' },
  ];

  it('replaces tool result content with the placeholder, keeping the message', () => {
    const out = compactMessages(history, { clear: ['tool-result'] });
    expect(out).toHaveLength(5);
    expect(out[2].content).toBe('[Old tool result content cleared]');
    expect(out[4].content).toBe('[Old tool result content cleared]');
    expect(out[2].tool_call_id).toBe('t1');
  });

  it('keepRecent preserves the N most recent tool results', () => {
    const out = compactMessages(history, { clear: [{ target: 'tool-result', keepRecent: 1 }] });
    expect(out[2].content).toBe('[Old tool result content cleared]');
    expect(out[4].content).toBe('result-2');
  });

  it('clears thinking without touching content', () => {
    const out = compactMessages(history, { clear: ['thinking'] });
    expect(out[1].thinking).toBeUndefined();
    expect(out[1].content).toBe('a1');
    expect(out[2].content).toBe('result-1');
  });

  it('does not mutate the input array', () => {
    compactMessages(history, { clear: ['tool-result'] });
    expect(history[2].content).toBe('result-1');
  });
});
