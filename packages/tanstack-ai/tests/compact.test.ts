import { describe, expect, it } from 'vitest';
import type { TanStackAIMessage } from '../src/adapter';
import { compactMessages } from '../src/compact';

function msg(
  role: 'user' | 'assistant' | 'tool',
  content: string,
  extra?: Partial<TanStackAIMessage>,
): TanStackAIMessage {
  return { role, content, ...extra };
}

describe('compactMessages', () => {
  describe('toolCalls', () => {
    const conversation: TanStackAIMessage[] = [
      msg('user', 'Search for cats'),
      msg('assistant', '', {
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
        ],
      }),
      msg('tool', 'Found 5 cats', { tool_call_id: 'tc_1' }),
      msg('assistant', 'Here are the results'),
      msg('user', 'Now search for dogs'),
      msg('assistant', '', {
        tool_calls: [
          { id: 'tc_2', type: 'function', function: { name: 'search', arguments: '{"q":"dogs"}' } },
        ],
      }),
      msg('tool', 'Found 3 dogs', { tool_call_id: 'tc_2' }),
      msg('assistant', 'Here are the dog results'),
    ];

    it('mode=none keeps all tool call pairs', () => {
      const result = compactMessages(conversation, { toolCalls: 'none' });
      expect(result).toEqual(conversation);
    });

    it('mode=all removes all tool call pairs', () => {
      const result = compactMessages(conversation, { toolCalls: 'all' });
      // Both assistant tool_calls stripped, both tool messages removed
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(result.filter((m) => m.tool_calls?.length)).toHaveLength(0);
      // Non-tool messages preserved
      expect(result.filter((m) => m.role === 'user')).toHaveLength(2);
    });

    it('mode=before-last-message keeps last assistant tool pair', () => {
      const result = compactMessages(conversation, {
        toolCalls: 'before-last-message',
      });
      // First tool pair (tc_1) removed, second (tc_2) preserved
      const toolMessages = result.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe('tc_2');

      const assistantsWithTools = result.filter(
        (m) => m.role === 'assistant' && m.tool_calls?.length,
      );
      expect(assistantsWithTools).toHaveLength(1);
    });

    it('mode=before-last-2-messages keeps last 2 assistant tool pairs', () => {
      const result = compactMessages(conversation, {
        toolCalls: 'before-last-2-messages',
      });
      // Both tool pairs preserved (only 2 assistant messages with tool calls)
      const toolMessages = result.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
    });
  });

  describe('emptyMessages', () => {
    it('removes empty messages when configured', () => {
      const messages: TanStackAIMessage[] = [
        msg('user', 'Hello'),
        msg('assistant', ''),
        msg('user', ''),
        msg('assistant', 'Hi'),
      ];
      const result = compactMessages(messages, { emptyMessages: 'remove' });
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
      expect(result[1].content).toBe('Hi');
    });

    it('keeps empty assistant with tool_calls', () => {
      const messages: TanStackAIMessage[] = [
        msg('assistant', '', {
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        }),
      ];
      const result = compactMessages(messages, { emptyMessages: 'remove' });
      expect(result).toHaveLength(1);
    });

    it('keeps empty messages when mode is keep', () => {
      const messages: TanStackAIMessage[] = [msg('user', 'Hello'), msg('assistant', '')];
      const result = compactMessages(messages, { emptyMessages: 'keep' });
      expect(result).toHaveLength(2);
    });
  });

  describe('combined', () => {
    it('applies toolCalls and emptyMessages together', () => {
      const messages: TanStackAIMessage[] = [
        msg('user', 'Start'),
        msg('assistant', '', {
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        }),
        msg('tool', 'Result', { tool_call_id: 'tc_1' }),
        msg('assistant', 'Done'),
      ];
      const result = compactMessages(messages, {
        toolCalls: 'all',
        emptyMessages: 'remove',
      });
      // tool_calls stripped → assistant becomes empty → removed by emptyMessages
      // tool message removed by toolCalls
      expect(result).toEqual([msg('user', 'Start'), msg('assistant', 'Done')]);
    });
  });
});
