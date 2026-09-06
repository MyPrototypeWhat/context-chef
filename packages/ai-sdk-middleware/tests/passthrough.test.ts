/**
 * Phase 4c passthrough: the axes core grew in 4.2 reach the middleware's own
 * Janitor and Offloader unchanged — an explicit `overflow.strategy` in place
 * of the `compress` tuning, an `overflow.archive` behind the summary's
 * citation, and a `truncate.store` behind the `context://vfs/` URI.
 *
 * There is deliberately no `tools` / `contextTool` option here: this package
 * rewrites prompts and never emits tool definitions, so a tools mode would
 * have nothing to reach. Register `getContextToolDefinition()` on a
 * `ContextChef` for that.
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { InMemoryBackend, reset, Store, summarize } from '@context-chef/core';
import { describe, expect, it, vi } from 'vitest';
import { createMiddleware } from '../src/middleware';
import { truncateToolResults } from '../src/truncator';

function createMockModel(inputTokens: number): LanguageModelV4 {
  const usage = {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 10, text: undefined, reasoning: undefined },
  };
  const finishReason: LanguageModelV4FinishReason = { unified: 'stop', raw: undefined };
  const response = { id: 'test-id', timestamp: new Date(), modelId: 'test-model' };

  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate(_opts: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const content: LanguageModelV4Content[] = [{ type: 'text', text: 'Hello' }];
      return { content, finishReason, warnings: [], usage, response };
    },
    async doStream(_opts: LanguageModelV4CallOptions) {
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Hello' },
        { type: 'text-end', id: '1' },
        { type: 'finish', usage, finishReason },
      ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

const conversation = (turns: number): LanguageModelV4Prompt => {
  const prompt: LanguageModelV4Prompt = [{ role: 'system', content: 'You are helpful.' }];
  for (let i = 0; i < turns; i++) {
    prompt.push({
      role: 'user',
      content: [{ type: 'text', text: `Message ${i}: ${'x'.repeat(100)}` }],
    });
    prompt.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Response ${i}: ${'y'.repeat(100)}` }],
    });
  }
  return prompt;
};

function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is undefined`);
  return value;
}

/** Reports an over-budget usage reading so the next transform overflows. */
async function feedOverBudget(
  middleware: ReturnType<typeof createMiddleware>,
  model: LanguageModelV4,
): Promise<void> {
  await assertDefined(
    middleware.wrapGenerate,
    'wrapGenerate',
  )({
    doGenerate: () => model.doGenerate({ prompt: [] }),
    doStream: () => model.doStream({ prompt: [] }),
    params: { prompt: [] },
    model,
  });
}

const transform = async (
  middleware: ReturnType<typeof createMiddleware>,
  model: LanguageModelV4,
  prompt: LanguageModelV4Prompt,
): Promise<LanguageModelV4Prompt> =>
  (
    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model })
  ).prompt;

describe('overflow passthrough', () => {
  it('runs the configured strategy instead of the compress defaults', async () => {
    const compressionModel = vi.fn(async () => '<summary>STRATEGY SUMMARY</summary>');
    const middleware = createMiddleware({
      contextWindow: 100,
      overflow: { strategy: summarize({ compressionModel, preserveRecentMessages: 1 }) },
      onCompress: vi.fn(),
      logger: { warn: () => {} },
    });
    const model = createMockModel(200);
    await feedOverBudget(middleware, model);

    const long = conversation(10);
    const result = await transform(middleware, model, long);

    expect(compressionModel).toHaveBeenCalled();
    expect(result.length).toBeLessThan(long.length);
    expect(JSON.stringify(result)).toContain('STRATEGY SUMMARY');
  });

  it('opens a budget check on a strategy alone, with no compress block', async () => {
    const middleware = createMiddleware({
      contextWindow: 100,
      overflow: { strategy: reset() },
      logger: { warn: () => {} },
    });
    const model = createMockModel(200);
    await feedOverBudget(middleware, model);

    const long = conversation(10);
    const result = await transform(middleware, model, long);

    expect(result.length).toBeLessThan(long.length);
    expect(JSON.stringify(result)).toContain('Context window reset');
  });

  it('requires a contextWindow once a strategy is configured', () => {
    expect(() => createMiddleware({ overflow: { strategy: reset() } })).toThrow(
      /`contextWindow` is required/,
    );
  });

  it('archives the evicted span and cites it in the summary', async () => {
    const archive = new Store(new InMemoryBackend()).namespace('archive');
    const middleware = createMiddleware({
      contextWindow: 100,
      overflow: {
        strategy: summarize({
          compressionModel: async () => '<summary>ARCHIVED SUMMARY</summary>',
          preserveRecentMessages: 1,
        }),
        archive: { store: async (serialized) => (await archive.put(serialized)).uri },
      },
      logger: { warn: () => {} },
    });
    const model = createMockModel(200);
    await feedOverBudget(middleware, model);

    const result = await transform(middleware, model, conversation(10));

    expect(JSON.stringify(result)).toContain('are archived in full at context://archive/');
    expect(archive.list()).not.toHaveLength(0);
  });
});

describe('truncate.store passthrough', () => {
  const toolPrompt = (output: string): LanguageModelV4Prompt => [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'run_cmd',
          output: { type: 'text', value: output },
        },
      ],
    },
  ];

  const firstToolText = (prompt: LanguageModelV4Prompt): string => {
    const message = prompt[0];
    if (message.role !== 'tool') throw new Error('expected a tool message');
    const part = message.content[0];
    if (part.type !== 'tool-result' || part.output.type !== 'text') {
      throw new Error('expected a text tool result');
    }
    return part.output.value;
  };

  it('persists the original into the store and cites its URI', async () => {
    const store = new Store(new InMemoryBackend());
    const result = await truncateToolResults(toolPrompt('line\n'.repeat(500)), {
      threshold: 100,
      headChars: 20,
      tailChars: 20,
      store,
    });

    const text = firstToolText(result);
    expect(text).toContain('context://vfs/');
    expect(store.namespace('vfs').list()).toHaveLength(1);
  });

  it('lets the store win over a legacy adapter', async () => {
    const store = new Store(new InMemoryBackend());
    const adapter = { write: vi.fn(), read: vi.fn(() => null) };

    await truncateToolResults(toolPrompt('line\n'.repeat(500)), {
      threshold: 100,
      tailChars: 20,
      storage: adapter,
      store,
    });

    expect(adapter.write).not.toHaveBeenCalled();
    expect(store.namespace('vfs').list()).toHaveLength(1);
  });
});
