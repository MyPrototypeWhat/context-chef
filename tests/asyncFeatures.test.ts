import { ContextChef } from '../src/index';
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
