import { GeminiAdapter } from '../src/adapters/GeminiAdapter';
import type { GeminiPayload, Message } from '../src/types';

describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter();

  it('should separate system messages into systemInstruction', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an expert.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
      systemInstruction?: { parts: Array<{ text: string }> };
    };

    expect(result.systemInstruction).toBeDefined();
    expect(result.systemInstruction!.parts).toHaveLength(2);
    expect(result.systemInstruction!.parts[0].text).toBe('You are an expert.');
    expect(result.systemInstruction!.parts[1].text).toBe('Be concise.');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].parts[0].text).toBe('Hello');
  });

  it('should omit systemInstruction when no system messages exist', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];

    const result = adapter.compile([...messages]) as unknown as Record<string, unknown>;
    expect(result.systemInstruction).toBeUndefined();
  });

  it('should map assistant to model role', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('model');
    expect(result.messages[1].parts[0].text).toBe('Hello!');
    expect(result.messages[2].role).toBe('user');
  });

  it('should convert tool calls to functionCall parts', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'London' }),
            },
          },
        ],
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      }>;
    };

    expect(result.messages).toHaveLength(2);
    const modelMsg = result.messages[1];
    expect(modelMsg.role).toBe('model');
    expect(modelMsg.parts).toHaveLength(1);
    expect(modelMsg.parts[0].functionCall).toBeDefined();
    expect(modelMsg.parts[0].functionCall!.name).toBe('get_weather');
    expect(modelMsg.parts[0].functionCall!.args).toEqual({ city: 'London' });
  });

  it('should include text part when assistant message has both content and tool_calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Check weather' },
      {
        role: 'assistant',
        content: 'Let me check...',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'Paris' }),
            },
          },
        ],
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      }>;
    };

    const modelMsg = result.messages[1];
    expect(modelMsg.parts).toHaveLength(2);
    expect(modelMsg.parts[0].text).toBe('Let me check...');
    expect(modelMsg.parts[1].functionCall!.name).toBe('get_weather');
  });

  it('should convert parallel tool calls into multiple functionCall parts', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Weather in 3 cities' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'London' }) },
          },
          {
            id: 'call_2',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
          },
          {
            id: 'call_3',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Tokyo' }) },
          },
        ],
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{ functionCall?: { name: string; args: Record<string, unknown> } }>;
      }>;
    };

    const modelMsg = result.messages[1];
    expect(modelMsg.parts).toHaveLength(3);
    expect(modelMsg.parts[0].functionCall!.args).toEqual({ city: 'London' });
    expect(modelMsg.parts[1].functionCall!.args).toEqual({ city: 'Paris' });
    expect(modelMsg.parts[2].functionCall!.args).toEqual({ city: 'Tokyo' });
  });

  it('should convert tool results to functionResponse parts with user role', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'get_weather', arguments: '{"city":"London"}' },
        }],
      },
      {
        role: 'tool',
        content: JSON.stringify({ temp: 15, unit: 'celsius' }),
        name: 'get_weather',
        tool_call_id: 'call_1',
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          functionResponse?: { name: string; response: unknown };
        }>;
      }>;
    };

    expect(result.messages).toHaveLength(3);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.parts[0].functionResponse).toBeDefined();
    expect(toolResultMsg.parts[0].functionResponse!.name).toBe('get_weather');
    expect(toolResultMsg.parts[0].functionResponse!.response).toEqual({ temp: 15, unit: 'celsius' });
  });

  it('should wrap non-JSON tool result content in { result: ... }', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: 'File not found',
        name: 'read_file',
        tool_call_id: 'call_x',
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          functionResponse?: { name: string; response: unknown };
        }>;
      }>;
    };

    expect(result.messages[0].parts[0].functionResponse!.response).toEqual({ result: 'File not found' });
  });

  it('should use tool_call_id as fallback name when name is missing', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: '{"ok": true}',
        tool_call_id: 'call_fallback',
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          functionResponse?: { name: string; response: unknown };
        }>;
      }>;
    };

    expect(result.messages[0].parts[0].functionResponse!.name).toBe('call_fallback');
  });

  it('should silently ignore _cache_breakpoint', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt.', _cache_breakpoint: true },
      { role: 'user', content: 'Hello' },
    ];

    const result = adapter.compile([...messages]) as unknown as {
      systemInstruction: { parts: Array<{ text: string; cache_control?: unknown }> };
    };

    const sysPart = result.systemInstruction.parts[0];
    expect(sysPart.text).toBe('System prompt.');
    expect(sysPart).not.toHaveProperty('cache_control');
    expect(sysPart).not.toHaveProperty('_cache_breakpoint');
  });

  it('should degrade prefill: trailing model message → note on last user message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an expert.' },
      { role: 'user', content: 'Help me.' },
      { role: 'assistant', content: '<thinking>\n1. ' },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
      systemInstruction?: { parts: Array<{ text: string }> };
    };

    // Model prefill message should be removed, only user message remains
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');

    // The user message should now contain the prefill enforcement note
    const userMsg = result.messages[0];
    expect(userMsg.parts[0].text).toContain('Help me.');
    expect(userMsg.parts[0].text).toContain('SYSTEM INSTRUCTION: Your response MUST start verbatim');
    expect(userMsg.parts[0].text).toContain('<thinking>\n1. ');
  });

  it('should NOT degrade model message that has tool calls (not a prefill)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Check weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function' as const,
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        }],
      },
    ];

    const result = adapter.compile([...messages]) as {
      messages: Array<{
        role: string;
        parts: Array<{
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      }>;
    };

    // Should keep the model message as-is, no degradation
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].role).toBe('model');
    expect(result.messages[1].parts[0].functionCall).toBeDefined();
  });

  it('should handle a complete multi-turn conversation with tool calling', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a weather assistant.' },
      { role: 'user', content: 'What is the weather in London?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'get_weather', arguments: '{"city":"London"}' },
        }],
      },
      {
        role: 'tool',
        content: '{"temperature": 15, "condition": "cloudy"}',
        name: 'get_weather',
        tool_call_id: 'call_1',
      },
      { role: 'assistant', content: 'The weather in London is 15°C and cloudy.' },
      { role: 'user', content: 'Thanks! What about Paris?' },
    ];

    const result = adapter.compile([...messages]);

    expect(result.systemInstruction?.parts[0]?.text).toBe('You are a weather assistant.');
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('model');   // functionCall
    expect(result.messages[2].role).toBe('user');    // functionResponse
    expect(result.messages[3].role).toBe('model');   // assistant response
    expect(result.messages[4].role).toBe('user');    // follow-up
  });
});
