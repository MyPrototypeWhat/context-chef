import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { withContextChef } from '../src/index';
import { createMiddleware } from '../src/middleware';

function createMockModel(options?: { inputTokens?: number; outputText?: string }): LanguageModelV3 {
  const inputTokens = options?.inputTokens ?? 100;
  const outputText = options?.outputText ?? 'Hello';

  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: 'json' as const,

    async doGenerate(opts: LanguageModelV3CallOptions) {
      return {
        content: [{ type: 'text' as const, text: outputText }] as LanguageModelV3Content[],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: {
            total: inputTokens,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        response: {
          id: 'test-id',
          timestamp: new Date(),
          modelId: 'test-model',
        },
      };
    },

    async doStream(opts: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: outputText },
        { type: 'text-end', id: '1' },
        {
          type: 'finish',
          usage: {
            inputTokens: {
              total: inputTokens,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          finishReason: 'stop',
        },
      ];

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

      return { stream };
    },
  } as LanguageModelV3;
}

function makeConversation(messageCount: number): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [{ role: 'system', content: 'You are helpful.' }];
  for (let i = 0; i < messageCount; i++) {
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
}

describe('createMiddleware', () => {
  it('passes through when no truncation or compression needed', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const params = { prompt } as LanguageModelV3CallOptions;
    const result = await middleware.transformParams!({
      params,
      type: 'generate',
      model: createMockModel(),
    });

    expect(result.prompt).toEqual(prompt);
  });

  it('truncates large tool results', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      truncate: { threshold: 50, headChars: 10, tailChars: 10 },
    });

    const longOutput = 'x'.repeat(200);
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Run command' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'run_cmd',
            input: { cmd: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'run_cmd',
            output: { type: 'text', value: longOutput },
          },
        ],
      },
    ];

    const params = { prompt } as LanguageModelV3CallOptions;
    const result = await middleware.transformParams!({
      params,
      type: 'generate',
      model: createMockModel(),
    });

    const toolMsg = result.prompt.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    if (toolMsg?.role === 'tool') {
      const part = toolMsg.content[0];
      if (part.type === 'tool-result' && part.output.type === 'text') {
        expect(part.output.value.length).toBeLessThan(longOutput.length);
        expect(part.output.value).toContain('truncated');
      }
    }
  });

  it('wrapGenerate feeds token usage to janitor', async () => {
    const middleware = createMiddleware({
      contextWindow: 500,
    });

    const model = createMockModel({ inputTokens: 200 });

    const doGenerate = async () => {
      return model.doGenerate({ prompt: [] } as LanguageModelV3CallOptions);
    };
    const doStream = async () => {
      return model.doStream({ prompt: [] } as LanguageModelV3CallOptions);
    };

    const result = await middleware.wrapGenerate!({
      doGenerate: doGenerate as any,
      doStream: doStream as any,
      params: { prompt: [] } as LanguageModelV3CallOptions,
      model,
    });

    expect(result.usage.inputTokens.total).toBe(200);
  });

  it('wrapStream captures usage from finish chunk', async () => {
    const middleware = createMiddleware({
      contextWindow: 500,
    });

    const model = createMockModel({ inputTokens: 300 });

    const doGenerate = async () => {
      return model.doGenerate({ prompt: [] } as LanguageModelV3CallOptions);
    };
    const doStream = async () => {
      return model.doStream({ prompt: [] } as LanguageModelV3CallOptions);
    };

    const streamResult = await middleware.wrapStream!({
      doGenerate: doGenerate as any,
      doStream: doStream as any,
      params: { prompt: [] } as LanguageModelV3CallOptions,
      model,
    });

    const reader = streamResult.stream.getReader();
    const chunks: LanguageModelV3StreamPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const finishChunk = chunks.find((c) => c.type === 'finish');
    expect(finishChunk).toBeDefined();
    if (finishChunk?.type === 'finish') {
      expect(finishChunk.usage.inputTokens.total).toBe(300);
    }
  });

  it('compresses history when over budget', async () => {
    const onCompress = vi.fn();
    const middleware = createMiddleware({
      contextWindow: 100,
      onCompress,
    });

    const model = createMockModel({ inputTokens: 200 });

    const doGenerate = async () => {
      return model.doGenerate({ prompt: [] } as LanguageModelV3CallOptions);
    };
    const doStream = async () => {
      return model.doStream({ prompt: [] } as LanguageModelV3CallOptions);
    };

    await middleware.wrapGenerate!({
      doGenerate: doGenerate as any,
      doStream: doStream as any,
      params: { prompt: [] } as LanguageModelV3CallOptions,
      model,
    });

    const longPrompt = makeConversation(10);
    const params = { prompt: longPrompt } as LanguageModelV3CallOptions;
    const result = await middleware.transformParams!({
      params,
      type: 'generate',
      model,
    });

    expect(result.prompt.length).toBeLessThan(longPrompt.length);
  });
});

describe('withContextChef wrapper', () => {
  it('returns a LanguageModelV3', () => {
    const model = createMockModel();
    const wrapped = withContextChef(model, { contextWindow: 128_000 });

    expect(wrapped.specificationVersion).toBe('v3');
    expect(wrapped.provider).toBeDefined();
    expect(wrapped.modelId).toBeDefined();
    expect(typeof wrapped.doGenerate).toBe('function');
    expect(typeof wrapped.doStream).toBe('function');
  });

  it('wrapped model doGenerate works end-to-end', async () => {
    const model = createMockModel({ outputText: 'Hello from wrapped model' });
    const wrapped = withContextChef(model, {
      contextWindow: 128_000,
      truncate: { threshold: 1000 },
    });

    const result = await wrapped.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    } as LanguageModelV3CallOptions);

    const textContent = result.content.find((c: LanguageModelV3Content) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect((textContent as { type: 'text'; text: string }).text).toBe('Hello from wrapped model');
  });
});
