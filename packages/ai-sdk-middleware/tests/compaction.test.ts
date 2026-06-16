import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { compactHistory, planCompaction } from '../src/compaction';

// These are the AI-SDK boundary functions — thin wrappers over core's
// provider-agnostic `planCompaction` / `compactHistory`. The turn-split algorithm
// itself is exhaustively tested in core (durableCompaction.test.ts); the tests
// here cover what the boundary adds: fromAISDK/toAISDK round-tripping, the
// no-op reference short-circuit, and the summary's AI SDK message shape.

/** Minimal V3 model whose summarization call returns a fixed string. */
function createSummarizerModel(summaryText = 'SUMMARY'): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate(_opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const content: LanguageModelV3Content[] = [{ type: 'text', text: summaryText }];
      const finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
      return {
        content,
        finishReason,
        warnings: [],
        usage: {
          inputTokens: {
            total: 50,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        response: { id: 'id', timestamp: new Date(), modelId: 'test-model' },
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

/** N plain user/assistant turns, optionally with a leading system message. */
function plainTurns(n: number, withSystem = true): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = withSystem
    ? [{ role: 'system', content: 'You are helpful.' }]
    : [];
  for (let i = 0; i < n; i++) {
    prompt.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] });
    prompt.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  }
  return prompt;
}

describe('planCompaction', () => {
  it('delegates the split to core and round-trips each slice through the adapter', () => {
    // 3 user/assistant pairs = 6 turns (each message is its own turn).
    const plan = planCompaction(plainTurns(3), { keepRecentTurns: 2 });

    expect(plan.system.map((m) => m.role)).toEqual(['system']);
    // 6 turns, keep 2 → summarize the first 4 turns, keep the last 2.
    expect(plan.toSummarize).toHaveLength(4);
    expect(plan.toKeep).toHaveLength(2);
    // Kept tail is the most recent turn's messages.
    const lastUser = plan.toKeep[0];
    expect(lastUser.role).toBe('user');
  });

  it('round-trips a prompt with no system message', () => {
    const plan = planCompaction(plainTurns(3, false), { keepRecentTurns: 2 });

    expect(plan.system).toEqual([]);
    expect(plan.toSummarize).toHaveLength(4);
    expect(plan.toKeep).toHaveLength(2);
  });

  it('never splits an assistant tool-call from its tool result', () => {
    // turns: [user q1] [assistant+tool_call, tool_result] [user q2] [assistant a2]
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { a: 1 } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'foo',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];

    // keepRecentTurns: 3 → split at the start of the tool turn. A naive
    // "keep last 3 messages" cut would orphan the tool result; turn-based does not.
    const plan = planCompaction(prompt, { keepRecentTurns: 3 });

    expect(plan.toSummarize.map((m) => m.role)).toEqual(['user']); // just q1
    // The assistant (tool-call) and its tool result stay together at the head of toKeep.
    expect(plan.toKeep.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant']);
  });

  it('preserves a multi-block assistant message verbatim in toKeep', () => {
    const assistantContent = [
      { type: 'text' as const, text: 'let me check' },
      { type: 'reasoning' as const, text: 'because reasons' },
      { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'foo', input: { a: 1 } },
    ];
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: assistantContent },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'foo',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ];

    const plan = planCompaction(prompt, { keepRecentTurns: 99 });
    const keptAssistant = plan.toKeep.find((m) => m.role === 'assistant');
    expect(keptAssistant?.content).toEqual(assistantContent);
  });
});

describe('compactHistory', () => {
  it('returns [...system, summary, ...toKeep] with the summary as a wrapped user message', async () => {
    const prompt = plainTurns(4); // system + 8 messages (8 turns)
    const result = await compactHistory(prompt, createSummarizerModel('Hello'), {
      keepRecentTurns: 2,
    });

    expect(result[0]).toEqual(prompt[0]); // system preserved at front
    const summaryMsg = result[1];
    expect(summaryMsg.role).toBe('user');
    const text =
      summaryMsg.role === 'user' && summaryMsg.content[0].type === 'text'
        ? summaryMsg.content[0].text
        : '';
    expect(text).toContain('Hello'); // summary survived
    expect(text).toContain('continued from a previous conversation'); // wrapper framing
    // Compacted: system + summary + last 2 turns, shorter than the original.
    expect(result.length).toBeLessThan(prompt.length);
    expect(result.length).toBe(1 /* system */ + 1 /* summary */ + 2 /* kept turns */);
  });

  it('returns the prompt unchanged when nothing is old enough to compact', async () => {
    const prompt = plainTurns(2);
    const result = await compactHistory(prompt, createSummarizerModel(), { keepRecentTurns: 99 });
    expect(result).toBe(prompt); // same reference — untouched, no model call
  });

  it('returns the prompt unchanged when the summarizer yields no text', async () => {
    const prompt = plainTurns(4);
    const result = await compactHistory(prompt, createSummarizerModel('   '), {
      keepRecentTurns: 1,
    });
    expect(result).toBe(prompt);
  });

  it('produces a valid prompt when the kept tail starts with a tool turn', async () => {
    // turns: [user q1] [assistant+tool_call, tool_result] [user q2] [assistant a2]
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { a: 1 } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'foo',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];

    // 4 conversation turns; keep 3 → summarize just [user q1], keep from the tool
    // turn onward. The summary user message must be followed by the assistant
    // tool-call and its result, in order — a valid, non-orphaned prompt.
    const result = await compactHistory(prompt, createSummarizerModel('S'), { keepRecentTurns: 3 });
    expect(result.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
  });
});
