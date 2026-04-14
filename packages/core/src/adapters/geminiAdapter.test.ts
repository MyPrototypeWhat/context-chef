import type { Content, TextPart } from '@google/generative-ai';
import { describe, expect, it } from 'vitest';
import type { GeminiPayload, Message } from '../types';
import { fromGemini, GeminiAdapter } from './geminiAdapter';

/**
 * Unified plain-object inspection shape. Covers every field tests touch
 * (text, functionCall, functionResponse, systemInstruction with optional
 * cache_control). Used as the target type for a JSON round-trip helper so
 * tests don't need per-assertion shape casts.
 */
interface GeminiPlainResult {
  messages: Array<{
    role: string;
    parts: Array<{
      text?: string;
      functionCall?: { name: string; args: Record<string, unknown> };
      functionResponse?: { name: string; response: unknown };
    }>;
  }>;
  systemInstruction?: {
    parts: Array<{ text: string; cache_control?: unknown }>;
  };
}

/**
 * Round-trip via JSON strips the SDK's complex union types to plain objects.
 * JSON.parse returns `any`, which TypeScript assigns to the target interface
 * without an explicit cast.
 */
function toPlain(result: GeminiPayload): GeminiPlainResult {
  const plain: GeminiPlainResult = JSON.parse(JSON.stringify(result));
  return plain;
}

describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter();

  it('should separate system messages into systemInstruction', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an expert.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = toPlain(adapter.compile([...messages]));

    expect(result.systemInstruction).toBeDefined();
    expect(result.systemInstruction?.parts).toHaveLength(2);
    expect(result.systemInstruction?.parts[0].text).toBe('You are an expert.');
    expect(result.systemInstruction?.parts[1].text).toBe('Be concise.');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].parts[0].text).toBe('Hello');
  });

  it('should omit systemInstruction when no system messages exist', () => {
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];

    const result = toPlain(adapter.compile([...messages]));
    expect(result.systemInstruction).toBeUndefined();
  });

  it('should map assistant to model role', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ];

    const result = toPlain(adapter.compile([...messages]));

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

    const result = toPlain(adapter.compile([...messages]));

    expect(result.messages).toHaveLength(2);
    const modelMsg = result.messages[1];
    expect(modelMsg.role).toBe('model');
    expect(modelMsg.parts).toHaveLength(1);
    expect(modelMsg.parts[0].functionCall).toBeDefined();
    expect(modelMsg.parts[0].functionCall?.name).toBe('get_weather');
    expect(modelMsg.parts[0].functionCall?.args).toEqual({ city: 'London' });
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

    const result = toPlain(adapter.compile([...messages]));

    const modelMsg = result.messages[1];
    expect(modelMsg.parts).toHaveLength(2);
    expect(modelMsg.parts[0].text).toBe('Let me check...');
    expect(modelMsg.parts[1].functionCall?.name).toBe('get_weather');
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

    const result = toPlain(adapter.compile([...messages]));

    const modelMsg = result.messages[1];
    expect(modelMsg.parts).toHaveLength(3);
    expect(modelMsg.parts[0].functionCall?.args).toEqual({ city: 'London' });
    expect(modelMsg.parts[1].functionCall?.args).toEqual({ city: 'Paris' });
    expect(modelMsg.parts[2].functionCall?.args).toEqual({ city: 'Tokyo' });
  });

  it('should convert tool results to functionResponse parts with user role', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ temp: 15, unit: 'celsius' }),
        name: 'get_weather',
        tool_call_id: 'call_1',
      },
    ];

    const result = toPlain(adapter.compile([...messages]));

    expect(result.messages).toHaveLength(3);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.parts[0].functionResponse).toBeDefined();
    expect(toolResultMsg.parts[0].functionResponse?.name).toBe('get_weather');
    expect(toolResultMsg.parts[0].functionResponse?.response).toEqual({
      temp: 15,
      unit: 'celsius',
    });
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

    const result = toPlain(adapter.compile([...messages]));

    expect(result.messages[0].parts[0].functionResponse?.response).toEqual({
      result: 'File not found',
    });
  });

  it('should use tool_call_id as fallback name when name is missing', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        content: '{"ok": true}',
        tool_call_id: 'call_fallback',
      },
    ];

    const result = toPlain(adapter.compile([...messages]));

    expect(result.messages[0].parts[0].functionResponse?.name).toBe('call_fallback');
  });

  it('should silently ignore _cache_breakpoint', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt.', _cache_breakpoint: true },
      { role: 'user', content: 'Hello' },
    ];

    const result = toPlain(adapter.compile([...messages]));
    const sysPart = result.systemInstruction?.parts[0];
    expect(sysPart).toBeDefined();
    if (!sysPart) return;
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

    const result = toPlain(adapter.compile([...messages]));

    // Model prefill message should be removed, only user message remains
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');

    // The user message should now contain the prefill enforcement note
    const userMsg = result.messages[0];
    expect(userMsg.parts[0].text).toContain('Help me.');
    expect(userMsg.parts[0].text).toContain(
      'SYSTEM INSTRUCTION: Your response MUST start verbatim',
    );
    expect(userMsg.parts[0].text).toContain('<thinking>\n1. ');
  });

  it('should NOT degrade model message that has tool calls (not a prefill)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Check weather' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ];

    const result = toPlain(adapter.compile([...messages]));

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
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
          },
        ],
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
    expect(result.messages[1].role).toBe('model'); // functionCall
    expect(result.messages[2].role).toBe('user'); // functionResponse
    expect(result.messages[3].role).toBe('model'); // assistant response
    expect(result.messages[4].role).toBe('user'); // follow-up
  });
});

// ═══════════════════════════════════════════════════════
// fromGemini — input adapter
// ═══════════════════════════════════════════════════════

describe('fromGemini', () => {
  it('extracts systemInstruction into system messages', () => {
    const systemInstruction = {
      parts: [{ text: 'You are an expert.' } as TextPart, { text: 'Be concise.' } as TextPart],
    };
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Hello' }] }];
    const result = fromGemini(contents, systemInstruction);

    expect(result.system).toHaveLength(2);
    expect(result.system[0]).toMatchObject({ role: 'system', content: 'You are an expert.' });
    expect(result.system[1]).toMatchObject({ role: 'system', content: 'Be concise.' });
    expect(result.history).toHaveLength(1);
  });

  it('returns empty system when no systemInstruction', () => {
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Hi' }] }];
    const { system, history } = fromGemini(contents);

    expect(system).toHaveLength(0);
    expect(history).toHaveLength(1);
  });

  it('maps model role to assistant', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello!' }] },
    ];
    const { history } = fromGemini(contents);

    expect(history[0]).toMatchObject({ role: 'user', content: 'Hi' });
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Hello!' });
  });

  it('converts inlineData to attachments', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'Look at this' },
          { inlineData: { mimeType: 'image/png', data: 'base64data' } },
        ],
      },
    ];
    const { history } = fromGemini(contents);

    expect(history[0].content).toBe('Look at this');
    expect(history[0].attachments).toHaveLength(1);
    expect(history[0].attachments?.[0]).toEqual({
      mediaType: 'image/png',
      data: 'base64data',
    });
  });

  it('converts fileData to attachments', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/file.pdf' } }],
      },
    ];
    const { history } = fromGemini(contents);

    expect(history[0].attachments?.[0]).toEqual({
      mediaType: 'application/pdf',
      data: 'gs://bucket/file.pdf',
    });
  });

  it('converts functionCall to tool_calls with synthetic IDs', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'London' } } }],
      },
    ];
    const { history } = fromGemini(contents);

    expect(history[0].role).toBe('assistant');
    expect(history[0].tool_calls).toHaveLength(1);
    expect(history[0].tool_calls?.[0]).toMatchObject({
      id: 'gemini-fc-get_weather-0',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"London"}' },
    });
  });

  it('converts functionResponse to tool message with correlated tool_call_id', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'London' } } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 15 } } }],
      },
    ];
    const { history } = fromGemini(contents);

    // The functionCall message
    expect(history[0].tool_calls?.[0].id).toBe('gemini-fc-get_weather-0');
    // The functionResponse message should have the matching tool_call_id
    const toolMsg = history.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe('gemini-fc-get_weather-0');
    expect(toolMsg?.content).toBe('{"temp":15}');
  });

  it('handles image-only messages (no text)', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'img-only' } }],
      },
    ];
    const { history } = fromGemini(contents);

    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('');
    expect(history[0].attachments).toHaveLength(1);
  });

  it('no attachments field when no media parts', () => {
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Just text' }] }];
    const { history } = fromGemini(contents);

    expect(history[0].attachments).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// GeminiAdapter.compile — attachments output
// ═══════════════════════════════════════════════════════

describe('GeminiAdapter — attachments output', () => {
  const adapter = new GeminiAdapter();

  it('converts base64 image attachments to inlineData parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Look at this',
        attachments: [{ mediaType: 'image/png', data: 'base64imgdata' }],
      },
    ];
    const result = toPlain(adapter.compile([...messages]));
    const parts = result.messages[0].parts;

    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe('Look at this');
    expect((parts[1] as { inlineData: { mimeType: string; data: string } }).inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64imgdata',
    });
  });

  it('converts URL attachments to fileData parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Check this',
        attachments: [{ mediaType: 'application/pdf', data: 'https://example.com/doc.pdf' }],
      },
    ];
    const result = toPlain(adapter.compile([...messages]));
    const parts = result.messages[0].parts;

    expect((parts[1] as { fileData: { mimeType: string; fileUri: string } }).fileData).toEqual({
      mimeType: 'application/pdf',
      fileUri: 'https://example.com/doc.pdf',
    });
  });

  it('converts gs:// URIs to fileData parts', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'Read this',
        attachments: [{ mediaType: 'application/pdf', data: 'gs://bucket/file.pdf' }],
      },
    ];
    const result = toPlain(adapter.compile([...messages]));
    const parts = result.messages[0].parts;

    expect((parts[1] as { fileData: { mimeType: string; fileUri: string } }).fileData).toEqual({
      mimeType: 'application/pdf',
      fileUri: 'gs://bucket/file.pdf',
    });
  });

  it('does not add attachment parts when no attachments', () => {
    const messages: Message[] = [{ role: 'user', content: 'Plain text' }];
    const result = toPlain(adapter.compile([...messages]));

    expect(result.messages[0].parts).toHaveLength(1);
    expect(result.messages[0].parts[0].text).toBe('Plain text');
  });
});
