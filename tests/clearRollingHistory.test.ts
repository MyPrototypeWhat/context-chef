import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

const userMsg = (content: string): Message => ({ role: 'user', content });
const assistantMsg = (content: string): Message => ({ role: 'assistant', content });

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

describe('E13: clearRollingHistory', () => {
  it('clears rolling history and produces empty history in compile output', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setTopLayer([{ role: 'system', content: 'You are helpful.' }]);
    chef.useRollingHistory([userMsg('turn 1'), assistantMsg('reply 1'), userMsg('turn 2')]);

    chef.clearRollingHistory();

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].content).toBe('You are helpful.');
  });

  it('returns this for chaining', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const result = chef.clearRollingHistory();
    expect(result).toBe(chef);
  });

  it('resets Janitor state so feedTokenUsage does not trigger stale compression', async () => {
    const compressionModel = vi.fn(async () => 'compressed summary');
    const chef = new ContextChef({
      janitor: {
        contextWindow: 200000,
        compressionModel,
      },
    });

    // Feed a high token count that would normally trigger compression
    chef.feedTokenUsage(999999);
    chef.clearRollingHistory();

    // Now add fresh history — should NOT trigger compression since state was reset
    chef.useRollingHistory([userMsg('fresh start')]);
    await chef.compile({ target: 'openai' });

    expect(compressionModel).not.toHaveBeenCalled();
  });

  it('is safe to call on already-empty history', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setTopLayer([{ role: 'system', content: 'sys' }]);

    chef.clearRollingHistory();

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.messages).toHaveLength(1);
  });

  it('does not affect topLayer or dynamicState', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setTopLayer([{ role: 'system', content: 'top' }]);
    chef.useRollingHistory([userMsg('history msg')]);

    chef.clearRollingHistory();

    expect(chef.topLayer).toHaveLength(1);
    expect(chef.topLayer[0].content).toBe('top');
  });
});
