import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../../index';
import type { Message } from '../../types';
import { groupIntoTurns, Janitor } from '.';

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
    const spy = vi.fn().mockReturnValue(999999);
    const mockModel = vi.fn().mockResolvedValue('<history_summary>X</history_summary>');
    const janitor = new Janitor({
      contextWindow: 100,
      tokenizer: spy,
      preserveRatio: 0.1,
      compressionModel: mockModel,
    });

    await janitor.compress(buildHistory(3));

    expect(spy).toHaveBeenCalled();
    const firstCallArg = spy.mock.calls[0][0] as Message[];
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
    const onCompress = vi.fn();
    const janitor = new Janitor({
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel: async () => '<history_summary>S</history_summary>',
      onCompress,
    });

    await janitor.compress(buildHistory(5));

    expect(onCompress).toHaveBeenCalledTimes(1);
    const [summaryMsg, count] = onCompress.mock.calls[0] as [Message, number];
    expect(summaryMsg.role).toBe('user');
    expect(count).toBeGreaterThan(0);
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
