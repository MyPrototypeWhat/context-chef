import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import type { Skill } from '@context-chef/core';
import { describe, expect, it, vi } from 'vitest';
import { withContextChef } from '../src/index';
import { createMiddleware } from '../src/middleware';

function createMockModel(options?: { inputTokens?: number; outputText?: string }): LanguageModelV3 {
  const inputTokens = options?.inputTokens ?? 100;
  const outputText = options?.outputText ?? 'Hello';

  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},

    async doGenerate(_opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const content: LanguageModelV3Content[] = [{ type: 'text', text: outputText }];
      const finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
      return {
        content,
        finishReason,
        warnings: [],
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

    async doStream(_opts: LanguageModelV3CallOptions) {
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
          finishReason: { unified: 'stop', raw: undefined },
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
  };
  return model;
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

/** Assert middleware method exists and return it (avoids `possibly undefined` errors) */
function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is undefined`);
  return value;
}

describe('createMiddleware', () => {
  it('passes through when no truncation or compression needed', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const params: LanguageModelV3CallOptions = { prompt };
    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
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

    const params: LanguageModelV3CallOptions = { prompt };
    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
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

    const doGenerate = (): PromiseLike<LanguageModelV3GenerateResult> =>
      model.doGenerate({ prompt: [] });
    const doStream = (): PromiseLike<LanguageModelV3StreamResult> => model.doStream({ prompt: [] });

    const result = await assertDefined(
      middleware.wrapGenerate,
      'wrapGenerate',
    )({
      doGenerate,
      doStream,
      params: { prompt: [] },
      model,
    });

    expect(result.usage.inputTokens.total).toBe(200);
  });

  it('wrapStream captures usage from finish chunk', async () => {
    const middleware = createMiddleware({
      contextWindow: 500,
    });

    const model = createMockModel({ inputTokens: 300 });

    const doGenerate = (): PromiseLike<LanguageModelV3GenerateResult> =>
      model.doGenerate({ prompt: [] });
    const doStream = (): PromiseLike<LanguageModelV3StreamResult> => model.doStream({ prompt: [] });

    const streamResult = await assertDefined(
      middleware.wrapStream,
      'wrapStream',
    )({
      doGenerate,
      doStream,
      params: { prompt: [] },
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

    const doGenerate = (): PromiseLike<LanguageModelV3GenerateResult> =>
      model.doGenerate({ prompt: [] });
    const doStream = (): PromiseLike<LanguageModelV3StreamResult> => model.doStream({ prompt: [] });

    await assertDefined(
      middleware.wrapGenerate,
      'wrapGenerate',
    )({
      doGenerate,
      doStream,
      params: { prompt: [] },
      model,
    });

    const longPrompt = makeConversation(10);
    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt: longPrompt },
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
    });

    const textContent = result.content.find((c: LanguageModelV3Content) => c.type === 'text');
    expect(textContent).toBeDefined();
    if (textContent?.type === 'text') {
      expect(textContent.text).toBe('Hello from wrapped model');
    }
  });
});

describe('compact', () => {
  it('prunes tool-call and tool-result messages', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      compact: { toolCalls: 'all' },
    });

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
            output: { type: 'text', value: 'very long tool output here' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    // tool message should be removed entirely
    const toolMsg = result.prompt.find((m) => m.role === 'tool');
    expect(toolMsg).toBeUndefined();

    // assistant tool-call message should also be removed (empty after pruning)
    const assistantMsgs = result.prompt.filter((m) => m.role === 'assistant');
    for (const msg of assistantMsgs) {
      if (msg.role === 'assistant') {
        const hasToolCall = msg.content.some((p) => p.type === 'tool-call');
        expect(hasToolCall).toBe(false);
      }
    }
  });

  it('prunes reasoning content', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      compact: { reasoning: 'all' },
    });

    const prompt: LanguageModelV3Prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I need to think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    const assistantMsg = result.prompt.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    if (assistantMsg?.role === 'assistant') {
      const hasReasoning = assistantMsg.content.some((p) => p.type === 'reasoning');
      expect(hasReasoning).toBe(false);
    }
  });
});

describe('onBudgetExceeded', () => {
  it('calls hook when budget is exceeded', async () => {
    const onBudgetExceeded = vi.fn().mockReturnValue(null);
    const middleware = createMiddleware({
      contextWindow: 100,
      onBudgetExceeded,
    });

    const model = createMockModel({ inputTokens: 200 });

    // Feed high token usage to trigger budget exceeded
    const doGenerate = (): PromiseLike<LanguageModelV3GenerateResult> =>
      model.doGenerate({ prompt: [] });
    const doStream = (): PromiseLike<LanguageModelV3StreamResult> => model.doStream({ prompt: [] });
    await assertDefined(
      middleware.wrapGenerate,
      'wrapGenerate',
    )({
      doGenerate,
      doStream,
      params: { prompt: [] },
      model,
    });

    const longPrompt = makeConversation(5);
    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt: longPrompt },
      type: 'generate',
      model,
    });

    expect(onBudgetExceeded).toHaveBeenCalled();
  });
});

describe('dynamicState', () => {
  it('injects state as XML into last user message (last_user placement)', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: () => ({ currentStep: 'analysis', progress: '50%' }),
        placement: 'last_user',
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'What next?' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    const userMsg = result.prompt.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    if (userMsg?.role === 'user') {
      expect(userMsg.content.length).toBe(2);
      const lastPart = userMsg.content[userMsg.content.length - 1];
      if (lastPart.type === 'text') {
        expect(lastPart.text).toContain('<dynamic_state>');
        expect(lastPart.text).toContain('<currentStep>analysis</currentStep>');
        expect(lastPart.text).toContain('<progress>50%</progress>');
      }
    }
  });

  it('injects state as system message (system placement)', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: () => ({ mode: 'debug' }),
        placement: 'system',
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    const lastMsg = result.prompt[result.prompt.length - 1];
    expect(lastMsg.role).toBe('system');
    if (lastMsg.role === 'system') {
      expect(lastMsg.content).toContain('CURRENT TASK STATE');
      expect(lastMsg.content).toContain('<mode>debug</mode>');
    }
  });

  it('defaults to last_user placement', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: () => ({ key: 'value' }),
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    // Should inject into user message, not add system message
    const userMsg = result.prompt.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    if (userMsg?.role === 'user') {
      const lastPart = userMsg.content[userMsg.content.length - 1];
      if (lastPart.type === 'text') {
        expect(lastPart.text).toContain('<key>value</key>');
      }
    }
  });

  it('calls getState on each invocation', async () => {
    let callCount = 0;
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: () => {
          callCount++;
          return { step: callCount };
        },
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    expect(callCount).toBe(2);
  });

  it('handles async getState', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: async () => ({ async: 'state' }),
        placement: 'system',
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    const lastMsg = result.prompt[result.prompt.length - 1];
    if (lastMsg.role === 'system') {
      expect(lastMsg.content).toContain('<async>state</async>');
    }
  });
});

describe('transformContext', () => {
  it('transforms prompt after compression', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      transformContext: (prompt) => {
        return [{ role: 'system', content: 'Injected by transform' } as const, ...prompt];
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    expect(result.prompt[0].role).toBe('system');
    if (result.prompt[0].role === 'system') {
      expect(result.prompt[0].content).toBe('Injected by transform');
    }
  });

  it('supports async transform', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      transformContext: async (prompt) => {
        return [...prompt, { role: 'system', content: 'async injected' } as const];
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    const lastMsg = result.prompt[result.prompt.length - 1];
    expect(lastMsg.role).toBe('system');
    if (lastMsg.role === 'system') {
      expect(lastMsg.content).toBe('async injected');
    }
  });

  it('runs after dynamicState injection', async () => {
    const transformContext = vi.fn((prompt: LanguageModelV3Prompt) => prompt);
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      dynamicState: {
        getState: () => ({ injected: true }),
        placement: 'system',
      },
      transformContext,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    expect(transformContext).toHaveBeenCalledTimes(1);
    const received = transformContext.mock.calls[0][0];
    // transformContext should see the dynamic state system message
    const systemMsgs = received.filter((m: LanguageModelV3Prompt[number]) => m.role === 'system');
    const hasState = systemMsgs.some(
      (m: LanguageModelV3Prompt[number]) =>
        m.role === 'system' && m.content.includes('<injected>true</injected>'),
    );
    expect(hasState).toBe(true);
  });
});

describe('skill', () => {
  const planningSkill: Skill = {
    name: 'planning',
    description: 'Plan before editing',
    instructions: 'Read code, list affected files, write plan to scratchpad.',
  };

  it('injects a static Skill object as a dedicated system message', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: planningSkill,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
      { role: 'user', content: [{ type: 'text', text: 'What next?' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({
      params: { prompt },
      type: 'generate',
      model: createMockModel(),
    });

    // Skill message should sit AFTER user system, BEFORE conversation.
    const systemMsgs = result.prompt.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(2);
    const skillSysMsg = systemMsgs[1];
    if (skillSysMsg.role === 'system') {
      expect(skillSysMsg.content).toBe(planningSkill.instructions);
    }

    const skillIdx = result.prompt.findIndex(
      (m) => m.role === 'system' && m.content === planningSkill.instructions,
    );
    const firstUserIdx = result.prompt.findIndex((m) => m.role === 'user');
    const userSysIdx = result.prompt.findIndex(
      (m) => m.role === 'system' && m.content === 'You are helpful.',
    );
    expect(userSysIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(firstUserIdx);
  });

  it('invokes the function form on every transformParams call', async () => {
    const skillFn = vi.fn(() => planningSkill);
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: skillFn,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    expect(skillFn).toHaveBeenCalledTimes(2);
  });

  it('skips injection when the function returns null', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: () => null,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    const systemMsgs = result.prompt.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
  });

  it('toggles between active and inactive on subsequent calls', async () => {
    let active: Skill | null = planningSkill;
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: () => active,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const first = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });
    expect(first.prompt.filter((m) => m.role === 'system').length).toBe(2);

    active = null;
    const second = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });
    expect(second.prompt.filter((m) => m.role === 'system').length).toBe(1);
  });

  it('supports async skill resolvers', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: async () => planningSkill,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    const systemMsgs = result.prompt.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
    if (systemMsgs[0].role === 'system') {
      expect(systemMsgs[0].content).toBe(planningSkill.instructions);
    }
  });

  it('does not modify the prompt when the option is omitted', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    expect(result.prompt).toEqual(prompt);
  });

  it('skips injection when instructions is an empty string', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: { name: 'noop', description: 'noop', instructions: '' },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    const systemMsgs = result.prompt.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
  });

  it('skips injection when instructions is whitespace-only', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: { name: 'blank', description: 'blank', instructions: '   \n\t  ' },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    const systemMsgs = result.prompt.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
  });

  it('coexists with dynamicState — skill is system, state is last_user', async () => {
    const middleware = createMiddleware({
      contextWindow: 1_000_000,
      skill: planningSkill,
      dynamicState: {
        getState: () => ({ step: 'analysis' }),
      },
    });

    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ];

    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt }, type: 'generate', model: createMockModel() });

    // Skill instructions appear once as a system message
    const skillSysMsgs = result.prompt.filter(
      (m) => m.role === 'system' && m.content === planningSkill.instructions,
    );
    expect(skillSysMsgs.length).toBe(1);

    // dynamicState was injected into the last user message, not system
    const userMsg = result.prompt.find((m) => m.role === 'user');
    if (userMsg?.role === 'user') {
      const lastPart = userMsg.content[userMsg.content.length - 1];
      if (lastPart.type === 'text') {
        expect(lastPart.text).toContain('<step>analysis</step>');
      }
    }
  });

  it('coexists with compress — skill survives over-budget compression', async () => {
    const middleware = createMiddleware({
      contextWindow: 100,
      skill: planningSkill,
    });

    const model = createMockModel({ inputTokens: 200 });
    const doGenerate = (): PromiseLike<LanguageModelV3GenerateResult> =>
      model.doGenerate({ prompt: [] });
    const doStream = (): PromiseLike<LanguageModelV3StreamResult> => model.doStream({ prompt: [] });

    // Push token usage so the next transform triggers compression.
    await assertDefined(
      middleware.wrapGenerate,
      'wrapGenerate',
    )({ doGenerate, doStream, params: { prompt: [] }, model });

    const longPrompt = makeConversation(10);
    const result = await assertDefined(
      middleware.transformParams,
      'transformParams',
    )({ params: { prompt: longPrompt }, type: 'generate', model });

    const skillSysMsgs = result.prompt.filter(
      (m) => m.role === 'system' && m.content === planningSkill.instructions,
    );
    expect(skillSysMsgs.length).toBe(1);
    // Conversation should still have been compressed.
    expect(result.prompt.length).toBeLessThan(longPrompt.length);
  });
});
