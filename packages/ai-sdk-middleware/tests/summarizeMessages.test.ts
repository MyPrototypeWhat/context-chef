import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';

import { summarizeMessages } from '../src';

function mockModel(text: string): LanguageModelV3 {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},

    doGenerate: vi.fn(
      async (_opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
        const content: LanguageModelV3Content[] = [{ type: 'text', text }];
        const finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
        return {
          content,
          finishReason,
          warnings: [],
          usage: {
            inputTokens: {
              total: 100,
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
    ),

    async doStream(_opts: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        {
          type: 'finish',
          usage: {
            inputTokens: {
              total: 100,
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

const prompt = [
  { role: 'system' as const, content: 'You are helpful.' },
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'plan a trip' }] },
  { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'here is a plan' }] },
];

describe('summarizeMessages', () => {
  it('converts AI-SDK prompt → IR (dropping system), summarizes, returns extracted <summary>', async () => {
    const model = mockModel('<analysis>x</analysis><summary>trip plan</summary>');
    const out = await summarizeMessages(prompt, model);
    expect(out).toBe('trip plan');
    expect(model.doGenerate).toHaveBeenCalledOnce();
  });

  it('passes toolResultStubThreshold through to core', async () => {
    const model = mockModel('<summary>ok</summary>');
    const out = await summarizeMessages(prompt, model, { toolResultStubThreshold: 5000 });
    expect(out).toBe('ok');
  });

  it('empty prompt returns empty string without calling the model', async () => {
    const model = mockModel('<summary>nope</summary>');
    const out = await summarizeMessages([], model);
    expect(out).toBe('');
    expect(model.doGenerate).not.toHaveBeenCalled();
  });

  it('role-flattening + system-drop: tool→user text, assistant tool-call→text, system dropped (C1+C2)', async () => {
    // Build a prompt with system, user, assistant-with-tool-call, and tool-result.
    // After fromAISDK + filter(system) + createCompressionAdapter:
    //   - system should be dropped entirely
    //   - tool message becomes a user message with "[Tool result(call_1): RAW_TOOL_OUTPUT]"
    //   - assistant tool-call becomes "[Called tool: search({"q":"x"})]" text
    //   - no raw role:'tool' message should reach the model
    const toolPrompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'SYSTEM_MARKER_DROP_ME' },
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'search',
            input: { q: 'x' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'search',
            output: { type: 'text', value: 'RAW_TOOL_OUTPUT' },
          },
        ],
      },
    ];

    const model = mockModel('<summary>ok</summary>');
    await summarizeMessages(toolPrompt, model);

    expect(model.doGenerate).toHaveBeenCalledOnce();
    const callArg = (model.doGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const seen = JSON.stringify(callArg.prompt ?? callArg);

    // Tool message flattened to user text (not raw tool role)
    expect(seen).toContain('[Tool result');
    // Tool-result content passed through
    expect(seen).toContain('RAW_TOOL_OUTPUT');
    // Assistant tool-call flattened to text
    expect(seen).toContain('[Called tool:');
    // No raw tool role reached the model
    expect(seen).not.toContain('"role":"tool"');
    // System message dropped
    expect(seen).not.toContain('SYSTEM_MARKER_DROP_ME');
  });
});
