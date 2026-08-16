import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { getAdapter } from './adapterFactory';
import {
  fromOpenAIResponses,
  OpenAIResponsesAdapter,
  type OpenAIResponsesInputItem,
  type OpenAIResponsesReasoningItem,
} from './openAIResponsesAdapter';

const adapter = new OpenAIResponsesAdapter();

describe('fromOpenAIResponses', () => {
  it('maps message items to IR history and instructions to a system message', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
    ];
    const { system, history } = fromOpenAIResponses(items, 'You are helpful.');

    expect(system).toEqual([{ role: 'system', content: 'You are helpful.' }]);
    expect(history).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
  });

  it('accepts string content and items without an explicit type', () => {
    const { history } = fromOpenAIResponses([
      { role: 'user', content: 'Plain string' },
      { role: 'assistant', content: 'Also plain' },
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Plain string' },
      { role: 'assistant', content: 'Also plain' },
    ]);
  });

  it('extracts system and developer message items into system messages', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'system', content: 'Be terse.' },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Use metric.' }],
      },
      { type: 'message', role: 'user', content: 'Hi' },
    ];
    const { system, history } = fromOpenAIResponses(items, 'Root instructions');

    expect(system).toEqual([
      { role: 'system', content: 'Root instructions' },
      { role: 'system', content: 'Be terse.' },
      { role: 'system', content: 'Use metric.' },
    ]);
    expect(history).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('joins function_call and function_call_output via call_id into tool_calls + tool messages', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: 'Weather?' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":20}' },
    ];
    const { history } = fromOpenAIResponses(items);

    expect(history).toEqual([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: 'tool', content: '{"temp":20}', tool_call_id: 'call_1' },
    ]);
  });

  it('joins out-of-order outputs back to their calls in call order', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: 'Weather and time?' },
      { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '{}' },
      { type: 'function_call', call_id: 'call_b', name: 'get_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_b', output: '12:00' },
      { type: 'function_call_output', call_id: 'call_a', output: 'sunny' },
    ];
    const { history } = fromOpenAIResponses(items);

    expect(history).toHaveLength(4);
    const assistant = history[1];
    expect(assistant.tool_calls?.map((tc) => tc.id)).toEqual(['call_a', 'call_b']);
    expect(history[2]).toEqual({ role: 'tool', content: 'sunny', tool_call_id: 'call_a' });
    expect(history[3]).toEqual({ role: 'tool', content: '12:00', tool_call_id: 'call_b' });
  });

  it('merges a function_call into the preceding assistant message item of the same turn', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: 'Do it' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working on it.' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'do_it', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ];
    const { history } = fromOpenAIResponses(items);

    expect(history).toEqual([
      { role: 'user', content: 'Do it' },
      {
        role: 'assistant',
        content: 'Working on it.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'do_it', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'done', tool_call_id: 'call_1' },
    ]);
  });

  it('starts a new assistant turn for a function_call after a function_call_output', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: 'Chain two tools' },
      { type: 'function_call', call_id: 'call_1', name: 'first', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'one' },
      { type: 'function_call', call_id: 'call_2', name: 'second', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'two' },
    ];
    const { history } = fromOpenAIResponses(items);

    const assistants = history.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0].tool_calls?.map((tc) => tc.id)).toEqual(['call_1']);
    expect(assistants[1].tool_calls?.map((tc) => tc.id)).toEqual(['call_2']);
  });

  it('attaches reasoning items to the following assistant message, preserving encrypted_content', () => {
    const reasoning: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Thinking about weather' }],
      encrypted_content: 'gAAAA-opaque-blob',
    };
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: 'Weather?' },
      reasoning,
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ];
    const { history } = fromOpenAIResponses(items);

    const assistant = history.find((m) => m.role === 'assistant');
    expect(assistant?._openai_reasoning).toEqual([reasoning]);
  });

  it('attaches trailing reasoning to a standalone assistant stub', () => {
    const reasoning: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs_9',
      summary: [],
      encrypted_content: 'gAAAA-tail',
    };
    const { history } = fromOpenAIResponses([
      { type: 'message', role: 'user', content: 'Hi' },
      reasoning,
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '', _openai_reasoning: [reasoning] },
    ]);
  });

  it('maps input_image and input_file parts to IR attachments', () => {
    const { history } = fromOpenAIResponses([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'See these' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,BBB',
            filename: 'report.pdf',
          },
        ],
      },
    ]);

    expect(history[0].content).toBe('See these');
    expect(history[0].attachments).toEqual([
      { mediaType: 'image/png', data: 'data:image/png;base64,AAA' },
      {
        mediaType: 'application/pdf',
        data: 'data:application/pdf;base64,BBB',
        filename: 'report.pdf',
      },
    ]);
  });

  describe('boundary sanitization', () => {
    it('drops orphan function_call_output items', () => {
      const { history } = fromOpenAIResponses([
        { type: 'message', role: 'user', content: 'Hi' },
        { type: 'function_call_output', call_id: 'call_ghost', output: 'orphan' },
      ]);

      expect(history).toEqual([{ role: 'user', content: 'Hi' }]);
    });

    it('injects a placeholder tool result for a function_call without output', () => {
      const { history } = fromOpenAIResponses([
        { type: 'message', role: 'user', content: 'Hi' },
        { type: 'function_call', call_id: 'call_1', name: 'lonely', arguments: '{}' },
      ]);

      expect(history[2]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '[No tool result available]',
      });
    });

    it('prepends a synthetic user message when history starts with an assistant', () => {
      const { history } = fromOpenAIResponses([
        { type: 'message', role: 'assistant', content: 'I start' },
      ]);

      expect(history[0].role).toBe('user');
      expect(history[1]).toEqual({ role: 'assistant', content: 'I start' });
    });
  });
});

describe('OpenAIResponsesAdapter', () => {
  it('joins system messages into instructions and maps text turns to message items', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const payload = adapter.compile([...messages]);

    expect(payload.instructions).toBe('You are helpful.\n\nBe terse.');
    expect(payload.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
    ]);
  });

  it('omits instructions when there are no system messages', () => {
    const payload = adapter.compile([{ role: 'user', content: 'Hi' }]);
    expect(payload.instructions).toBeUndefined();
  });

  it('maps tool_calls to function_call items and tool messages to function_call_output', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: 'tool', content: '{"temp":20}', tool_call_id: 'call_1' },
    ];
    const payload = adapter.compile([...messages]);

    expect(payload.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":20}' },
    ]);
  });

  it('emits assistant text before its function_call items', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Do it' },
      {
        role: 'assistant',
        content: 'Working on it.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'do_it', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'done', tool_call_id: 'call_1' },
    ];
    const payload = adapter.compile([...messages]);

    expect(payload.input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Working on it.' }],
    });
    expect(payload.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
  });

  it('re-emits _openai_reasoning items verbatim before the assistant message that carries them', () => {
    const reasoning: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Plan' }],
      encrypted_content: 'gAAAA-opaque',
    };
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!', _openai_reasoning: [reasoning] },
    ];
    const payload = adapter.compile([...messages]);

    expect(payload.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      reasoning,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] },
    ]);
  });

  it('converts user attachments to input_image / input_file parts, wrapping raw base64 as data URLs', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Look',
        attachments: [
          { mediaType: 'image/png', data: 'iVBORrawbase64' },
          { mediaType: 'image/jpeg', data: 'https://example.com/cat.jpg' },
          { mediaType: 'application/pdf', data: 'JVBERrawbase64', filename: 'doc.pdf' },
          { mediaType: 'application/pdf', data: 'https://example.com/doc.pdf' },
        ],
      },
    ];
    const payload = adapter.compile([...messages]);

    expect(payload.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORrawbase64' },
          { type: 'input_image', image_url: 'https://example.com/cat.jpg' },
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,JVBERrawbase64',
            filename: 'doc.pdf',
          },
          { type: 'input_file', file_url: 'https://example.com/doc.pdf' },
        ],
      },
    ]);
  });

  it('strips internal IR fields (_cache_breakpoint, thinking) from output', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi', _cache_breakpoint: true },
      {
        role: 'assistant',
        content: 'Yo',
        thinking: { thinking: 'internal', signature: 'sig' },
      },
    ];
    const payload = adapter.compile([...messages]);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('_cache_breakpoint');
    expect(serialized).not.toContain('internal');
    expect(serialized).not.toContain('thinking');
  });

  it('is registered as the "openai-responses" builtin target', () => {
    expect(getAdapter('openai-responses')).toBeInstanceOf(OpenAIResponsesAdapter);
  });
});

describe('round-trip fidelity', () => {
  it('fromOpenAIResponses -> compile reproduces the original items and instructions', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in NYC?' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Need the weather tool' }],
        content: [{ type: 'reasoning_text', text: 'The user wants NYC weather.' }],
        encrypted_content: 'gAAAA-byte-identical-blob',
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":20}' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'It is 20°C in NYC.' }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks!' }] },
    ];
    const { system, history } = fromOpenAIResponses(items, 'You are a weather bot.');
    const payload = adapter.compile([...system, ...history]);

    expect(payload.instructions).toBe('You are a weather bot.');
    expect(payload.input).toEqual(items);
    // Byte-identical reasoning round-trip, including encrypted_content
    expect(JSON.stringify(payload.input[1])).toBe(JSON.stringify(items[1]));
  });

  it('round-trips a trailing reasoning item without inventing extra messages', () => {
    const items: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      { type: 'reasoning', id: 'rs_tail', summary: [], encrypted_content: 'gAAAA-tail' },
    ];
    const { system, history } = fromOpenAIResponses(items);
    const payload = adapter.compile([...system, ...history]);

    expect(payload.input).toEqual(items);
  });

  it('round-trips attachments on user messages', () => {
    const items: OpenAIResponsesInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'See this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,BBB',
            filename: 'report.pdf',
          },
        ],
      },
    ];
    const { system, history } = fromOpenAIResponses(items);
    const payload = adapter.compile([...system, ...history]);

    expect(payload.input).toEqual(items);
  });
});
