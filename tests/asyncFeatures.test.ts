import { ContextChef } from '../src/index';
import { Janitor } from '../src/modules/Janitor';
import type { Message } from '../src/types';

describe('ContextChef Async Features (pi-mono inspiration)', () => {
  it('should trigger Janitor compression when history exceeds limit', async () => {
    // Mock: returns a summary already wrapped in <history_summary> tags,
    // mirroring what a real LLM would output when given CONTEXT_COMPACTION_INSTRUCTION.
    const mockCompressionModel = jest
      .fn()
      .mockResolvedValue('<history_summary>MOCK_SUMMARY</history_summary>');

    const chef = new ContextChef({
      janitor: {
        maxHistoryLimit: 5,
        preserveRecentCount: 2,
        compressionModel: mockCompressionModel,
      },
    });

    // Create 6 messages (exceeds limit of 5)
    const history: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'user',
      content: `Message ${i + 1}`,
    }));

    chef.useRollingHistory(history);

    const payload = await chef.compileAsync();

    // The janitor should preserve 2 messages, and replace the remaining 4 with 1 summary.
    // Total messages in rolling history = 1 summary + 2 preserved = 3.
    expect(payload.messages.length).toBe(3);

    // Check summary message
    const summaryMsg = payload.messages[0];
    expect(summaryMsg.role).toBe('system');
    expect(summaryMsg.content).toContain('<history_summary>');
    expect(summaryMsg.content).toContain('MOCK_SUMMARY');

    // Check preserved messages
    expect(payload.messages[1].content).toBe('Message 5');
    expect(payload.messages[2].content).toBe('Message 6');

    // Ensure our mock LLM was actually called
    expect(mockCompressionModel).toHaveBeenCalledTimes(1);
    const passedMessages = mockCompressionModel.mock.calls[0][0];
    // 4 compressed messages + 1 CONTEXT_COMPACTION_INSTRUCTION appended by Janitor
    expect(passedMessages.length).toBe(5);
  });

  it('should execute transformContext hook to inject or modify messages', async () => {
    const chef = new ContextChef({
      transformContext: async (messages: Message[]) => {
        // Example: An extension that injects a secret branch summary
        return [{ role: 'system', content: 'Secret Extension Injected' }, ...messages];
      },
    });

    chef.setTopLayer([{ role: 'system', content: 'Top Layer' }]);

    const payload = await chef.compileAsync();

    expect(payload.messages.length).toBe(2);
    expect(payload.messages[0].content).toBe('Secret Extension Injected');
    expect(payload.messages[1].content).toBe('Top Layer');
  });

  it('should execute synchronous transformContext in compile()', () => {
    const chef = new ContextChef({
      transformContext: (messages: Message[]) => {
        return messages.map((m) => ({ ...m, name: 'transformed_user' }));
      },
    });

    chef.useRollingHistory([{ role: 'user', content: 'Hello' }]);

    const payload = chef.compile();

    expect(payload.messages.length).toBe(1);
    expect(payload.messages[0].name).toBe('transformed_user');
  });

  it('should throw if async transformContext is used with sync compile()', () => {
    const chef = new ContextChef({
      transformContext: async (messages: Message[]) => messages,
    });

    chef.useRollingHistory([{ role: 'user', content: 'Hello' }]);

    expect(() => chef.compile()).toThrow('transformContext is async. Use compileAsync() instead.');
  });
});

// ─── Janitor: token-based compression (C3) ───
// Uses a custom tokenizer to make all assertions deterministic.
// Each message is assigned a fixed token cost so we can reason about splits exactly.

describe('Janitor — token-based compression (maxHistoryTokens)', () => {
  // Helper: build a history of N user messages, each costing `tokensPerMsg` tokens
  // via the custom tokenizer (tokenizer receives JSON.stringify of all messages)
  const buildHistory = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => ({
      role: 'user' as const,
      content: `msg-${i + 1}`,
    }));

  // Simple deterministic tokenizer: 100 tokens per message in the serialized array
  // JSON.stringify of N messages is ~N * (some chars), so we just count occurrences
  // of "msg-" as a proxy for message count — keeps tests simple
  const makeTokenizer = (tokensPerMsg: number) =>
    (text: string): number => {
      const count = (text.match(/"msg-/g) ?? []).length;
      return count * tokensPerMsg;
    };

  it('does NOT compress when total tokens are within budget', async () => {
    const mockModel = jest.fn().mockResolvedValue('<history_summary>S</history_summary>');
    const janitor = new Janitor({
      maxHistoryTokens: 1000,
      preserveRecentTokens: 500,
      tokenizer: makeTokenizer(10), // 5 messages × 10 = 50 tokens, well under 1000
      compressionModel: mockModel,
    });

    const history = buildHistory(5);
    const result = await janitor.compress(history);

    expect(result).toHaveLength(5);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('compresses when tokens exceed maxHistoryTokens', async () => {
    const mockModel = jest.fn().mockResolvedValue('<history_summary>COMPRESSED</history_summary>');
    const janitor = new Janitor({
      maxHistoryTokens: 30,
      preserveRecentTokens: 10, // keep last ~1 message (10 tokens each)
      tokenizer: makeTokenizer(10), // 5 messages × 10 = 50 tokens > 30
      compressionModel: mockModel,
    });

    const history = buildHistory(5);
    const result = await janitor.compress(history);

    expect(mockModel).toHaveBeenCalledTimes(1);
    // First message in result should be the summary
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('COMPRESSED');
    // Total result must be shorter than original
    expect(result.length).toBeLessThan(history.length + 1);
  });

  it('preserveRecentTokens defaults to 70% of maxHistoryTokens when omitted', async () => {
    // With 5 messages × 10 tokens = 50 total, maxHistoryTokens=40 triggers compression.
    // Default preserve = floor(40 * 0.7) = 28 tokens → keeps last 2 messages (2×10=20 ≤ 28).
    const mockModel = jest.fn().mockResolvedValue('<history_summary>DEFAULT</history_summary>');
    const janitor = new Janitor({
      maxHistoryTokens: 40,
      // preserveRecentTokens NOT set — should default to 70%
      tokenizer: makeTokenizer(10),
      compressionModel: mockModel,
    });

    const history = buildHistory(5);
    const result = await janitor.compress(history);

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(result[0].role).toBe('system');
    // Kept messages + 1 summary
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('calls the custom tokenizer with the serialized message JSON', async () => {
    const spy = jest.fn().mockReturnValue(999999); // always huge → always compress
    const mockModel = jest.fn().mockResolvedValue('<history_summary>X</history_summary>');
    const janitor = new Janitor({
      maxHistoryTokens: 100,
      preserveRecentTokens: 10,
      tokenizer: spy,
      compressionModel: mockModel,
    });

    const history = buildHistory(3);
    await janitor.compress(history);

    // tokenizer must have been called with a JSON string
    expect(spy).toHaveBeenCalled();
    const firstCallArg = spy.mock.calls[0][0] as string;
    expect(typeof firstCallArg).toBe('string');
    expect(() => JSON.parse(firstCallArg)).not.toThrow();
  });

  it('fires onCompress with the summary message and truncated count', async () => {
    const onCompress = jest.fn();
    const janitor = new Janitor({
      maxHistoryTokens: 30,
      preserveRecentTokens: 10,
      tokenizer: makeTokenizer(10),
      compressionModel: async () => '<history_summary>S</history_summary>',
      onCompress,
    });

    await janitor.compress(buildHistory(5));

    expect(onCompress).toHaveBeenCalledTimes(1);
    const [summaryMsg, count] = onCompress.mock.calls[0] as [Message, number];
    expect(summaryMsg.role).toBe('system');
    expect(summaryMsg.content).toContain('<history_summary>');
    expect(count).toBeGreaterThan(0);
  });

  it('falls back to placeholder summary when no compressionModel is provided', async () => {
    const janitor = new Janitor({
      maxHistoryTokens: 30,
      preserveRecentTokens: 10,
      tokenizer: makeTokenizer(10),
      // no compressionModel
    });

    const result = await janitor.compress(buildHistory(5));

    // Compression must have fired (result shorter than original + 1 summary)
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('<history_summary>');
    expect(result[0].content).toContain('older messages were truncated');
  });

  it('integrates with ContextChef.compileAsync() via token budget', async () => {
    const mockModel = jest.fn().mockResolvedValue('<history_summary>VIA_CHEF</history_summary>');
    const chef = new ContextChef({
      janitor: {
        maxHistoryTokens: 30,
        preserveRecentTokens: 10,
        tokenizer: makeTokenizer(10),
        compressionModel: mockModel,
      },
    });

    chef.useRollingHistory(buildHistory(5));
    const payload = await chef.compileAsync();

    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[0].content).toContain('VIA_CHEF');
  });
});
