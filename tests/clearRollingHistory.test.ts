import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

const userMsg = (content: string): Message => ({ role: 'user', content });
const assistantMsg = (content: string): Message => ({ role: 'assistant', content });

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

describe('E13: clearHistory', () => {
  it('clears history and produces empty history in compile output', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setSystemPrompt([{ role: 'system', content: 'You are helpful.' }]);
    chef.setHistory([userMsg('turn 1'), assistantMsg('reply 1'), userMsg('turn 2')]);

    chef.clearHistory();

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].content).toBe('You are helpful.');
  });

  it('returns this for chaining', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const result = chef.clearHistory();
    expect(result).toBe(chef);
  });

  it('resets Janitor state so reportTokenUsage does not trigger stale compression', async () => {
    const compressionModel = vi.fn(async () => 'compressed summary');
    const chef = new ContextChef({
      janitor: {
        contextWindow: 200000,
        compressionModel,
      },
    });

    // Feed a high token count that would normally trigger compression
    chef.reportTokenUsage(999999);
    chef.clearHistory();

    // Now add fresh history — should NOT trigger compression since state was reset
    chef.setHistory([userMsg('fresh start')]);
    await chef.compile({ target: 'openai' });

    expect(compressionModel).not.toHaveBeenCalled();
  });

  it('is safe to call on already-empty history', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);

    chef.clearHistory();

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.messages).toHaveLength(1);
  });

  it('does not affect systemPrompt or dynamicState', async () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setSystemPrompt([{ role: 'system', content: 'top' }]);
    chef.setHistory([userMsg('history msg')]);

    chef.clearHistory();

    expect(chef['systemPrompt']).toHaveLength(1);
    expect(chef['systemPrompt'][0].content).toBe('top');
  });
});
