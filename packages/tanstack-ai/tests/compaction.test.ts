import type { ModelMessage } from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  compactTanStackMessages,
  planCompactionTanStackMessages,
  summarizeTanStackMessages,
} from '../src/compaction';

/** Minimal TanStack text adapter whose summarization stream yields `summaryText`. */
function createSummarizerAdapter(summaryText = 'SUMMARY') {
  const chunks = [
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: summaryText },
    { type: 'RUN_FINISHED', messageId: 'msg_1' },
  ];
  return {
    kind: 'text' as const,
    name: 'mock',
    model: 'mock-summarizer',
    '~types': {} as Record<string, unknown>,
    chatStream: vi.fn().mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    })),
    structuredOutput: vi.fn(),
  };
}

/** N plain user/assistant turns. TanStack messages carry no system role. */
function plainTurns(n: number): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `q${i}` });
    msgs.push({ role: 'assistant', content: `a${i}` });
  }
  return msgs;
}

describe('planCompactionTanStackMessages', () => {
  it('splits on turn boundaries and round-trips each slice as ModelMessage[]', () => {
    const plan = planCompactionTanStackMessages(plainTurns(3), { keepRecentTurns: 2 });
    expect(plan.toSummarize).toHaveLength(4);
    expect(plan.toKeep).toHaveLength(2);
    expect(plan.toKeep[0].role).toBe('user');
    expect(plan.toKeep[0].content).toBe('q2');
  });

  it('never splits an assistant tool-call from its tool results', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
        ],
      },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const plan = planCompactionTanStackMessages(messages, { keepRecentTurns: 3 });
    expect(plan.toSummarize.map((m) => m.role)).toEqual(['user']);
    expect(plan.toKeep.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant']);
  });

  it('keeps everything when keepRecentTurns covers the whole history', () => {
    const plan = planCompactionTanStackMessages(plainTurns(2), { keepRecentTurns: 99 });
    expect(plan.toSummarize).toHaveLength(0);
    expect(plan.toKeep).toHaveLength(4);
  });
});

describe('compactTanStackMessages', () => {
  it('returns [summary, ...toKeep] with a wrapped user summary', async () => {
    const messages = plainTurns(4); // 8 messages
    const result = await compactTanStackMessages(
      messages,
      createSummarizerAdapter('Hello') as never,
      {
        keepRecentTurns: 2,
      },
    );
    const summary = result[0];
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('Hello');
    expect(summary.content).toContain('continued from a previous conversation');
    expect(result.length).toBe(1 + 2);
    expect(result.slice(1)).toEqual(messages.slice(-2));
  });

  it('returns the INPUT reference unchanged when nothing is old enough', async () => {
    const messages = plainTurns(2);
    const result = await compactTanStackMessages(messages, createSummarizerAdapter() as never, {
      keepRecentTurns: 99,
    });
    expect(result).toBe(messages); // same reference — caller skips persistence
  });

  it('returns the INPUT reference unchanged when the summary is blank', async () => {
    const messages = plainTurns(4);
    const result = await compactTanStackMessages(
      messages,
      createSummarizerAdapter('   ') as never,
      {
        keepRecentTurns: 2,
      },
    );
    expect(result).toBe(messages);
  });

  it('propagates model errors', async () => {
    const adapter = createSummarizerAdapter();
    adapter.chatStream.mockImplementation(() => ({
      // biome-ignore lint/correctness/useYield: the stream fails before yielding
      [Symbol.asyncIterator]: async function* () {
        throw new Error('summarizer down');
      },
    }));
    await expect(
      compactTanStackMessages(plainTurns(4), adapter as never, { keepRecentTurns: 1 }),
    ).rejects.toThrow('summarizer down');
  });
});

describe('summarizeTanStackMessages', () => {
  it('returns the extracted summary text', async () => {
    const adapter = createSummarizerAdapter('The user explored cats.');
    const summary = await summarizeTanStackMessages(plainTurns(3), adapter as never);
    expect(summary).toBe('The user explored cats.');
    expect(adapter.chatStream).toHaveBeenCalledTimes(1);
  });

  it('returns empty string for an empty slice without calling the model', async () => {
    const adapter = createSummarizerAdapter();
    const summary = await summarizeTanStackMessages([], adapter as never);
    expect(summary).toBe('');
    expect(adapter.chatStream).not.toHaveBeenCalled();
  });

  it('role-flattens tool messages before summarization', async () => {
    const adapter = createSummarizerAdapter();
    const messages: ModelMessage[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
      },
      { role: 'tool', content: 'tool output', toolCallId: 'c1' },
    ];
    await summarizeTanStackMessages(messages, adapter as never);
    const callArgs = adapter.chatStream.mock.calls[0][0];
    for (const m of callArgs.messages) {
      expect(['user', 'assistant']).toContain(m.role);
    }
  });
});
