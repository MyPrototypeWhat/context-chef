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

describe('compactMessages — invalid mode rejection', () => {
  it('lists all valid toolCalls modes when given an unknown one', () => {
    expect(() =>
      compactMessages([msg('user', 'q')], {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type to exercise the runtime error
        toolCalls: 'bogus' as any,
      }),
    ).toThrow(/Valid modes: 'none', 'all', 'before-last-message', 'before-last-N-messages'/);
  });

  it('rejects an unknown mode inside the array form', () => {
    expect(() =>
      compactMessages([msg('user', 'q')], {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type to exercise the runtime error
        toolCalls: [{ type: 'bogus' as any }],
      }),
    ).toThrow(/Unrecognized toolCalls compact mode/);
  });
});

describe('compactMessages', () => {
  describe('toolCalls', () => {
    // Ends with a tool turn so window-based protection is observable.
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
    ];

    it('mode=none keeps all tool call pairs', () => {
      const result = compactMessages(conversation, { toolCalls: 'none' });
      expect(result).toEqual(conversation);
    });

    it('mode=all removes all tool call pairs', () => {
      const result = compactMessages(conversation, { toolCalls: 'all', emptyMessages: 'keep' });
      // Both assistant tool_calls stripped, both tool messages removed
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(result.filter((m) => m.tool_calls?.length)).toHaveLength(0);
      // Non-tool messages preserved
      expect(result.filter((m) => m.role === 'user')).toHaveLength(2);
    });

    it('mode=all with default emptyMessages removes now-empty assistants too', () => {
      const result = compactMessages(conversation, { toolCalls: 'all' });
      expect(result).toEqual([
        msg('user', 'Search for cats'),
        msg('assistant', 'Here are the results'),
        msg('user', 'Now search for dogs'),
      ]);
    });

    it('mode=before-last-message protects tool pairs referenced by the final message', () => {
      const result = compactMessages(conversation, {
        toolCalls: 'before-last-message',
        emptyMessages: 'keep',
      });
      // Final message is the tc_2 tool result — that pair survives everywhere,
      // the older tc_1 pair is removed.
      const toolMessages = result.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe('tc_2');

      const assistantsWithTools = result.filter(
        (m) => m.role === 'assistant' && m.tool_calls?.length,
      );
      expect(assistantsWithTools).toHaveLength(1);
      expect(assistantsWithTools[0].tool_calls?.[0].id).toBe('tc_2');
    });

    it('window counts messages of the whole array (pruneMessages semantics)', () => {
      // Last message is a plain assistant answer — nothing referenced in the
      // window, so before-last-message prunes BOTH tool pairs.
      const endsWithText = [...conversation, msg('assistant', 'Here are the dog results')];
      const result = compactMessages(endsWithText, {
        toolCalls: 'before-last-message',
        emptyMessages: 'keep',
      });
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(result.filter((m) => m.tool_calls?.length)).toHaveLength(0);
    });

    it('mode=before-last-2-messages keeps the pair referenced by the last 2 messages', () => {
      const result = compactMessages(conversation, {
        toolCalls: 'before-last-2-messages',
        emptyMessages: 'keep',
      });
      // Window = [assistant(tc_2), tool(tc_2)] → tc_2 kept, tc_1 pruned.
      const toolMessages = result.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe('tc_2');
    });

    it('array form prunes only the named tools', () => {
      const mixed: TanStackAIMessage[] = [
        msg('user', 'Do both'),
        msg('assistant', '', {
          tool_calls: [
            { id: 'tc_s', type: 'function', function: { name: 'search', arguments: '{}' } },
            { id: 'tc_r', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        }),
        msg('tool', 'search result', { tool_call_id: 'tc_s' }),
        msg('tool', 'file contents', { tool_call_id: 'tc_r' }),
        msg('assistant', 'Done'),
        msg('user', 'Thanks'),
      ];
      const result = compactMessages(mixed, {
        toolCalls: [{ type: 'all', tools: ['search'] }],
        emptyMessages: 'keep',
      });
      // search pruned everywhere; read_file untouched.
      const toolMessages = result.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe('tc_r');
      const assistant = result.find((m) => m.tool_calls?.length);
      expect(assistant?.tool_calls?.map((tc) => tc.id)).toEqual(['tc_r']);
    });

    it('array form applies multiple entries in order', () => {
      const mixed: TanStackAIMessage[] = [
        msg('user', 'Do both'),
        msg('assistant', '', {
          tool_calls: [
            { id: 'tc_s', type: 'function', function: { name: 'search', arguments: '{}' } },
            { id: 'tc_r', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        }),
        msg('tool', 'search result', { tool_call_id: 'tc_s' }),
        msg('tool', 'file contents', { tool_call_id: 'tc_r' }),
        msg('assistant', 'Done'),
      ];
      const result = compactMessages(mixed, {
        toolCalls: [
          { type: 'all', tools: ['search'] },
          { type: 'all', tools: ['read_file'] },
        ],
        emptyMessages: 'keep',
      });
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(result.filter((m) => m.tool_calls?.length)).toHaveLength(0);
    });

    it('resolves tool names for result messages via the assistant tool_calls map', () => {
      // The result message carries no `name` — pruning by tool name must
      // still find and remove it through its tool_call_id.
      const mixed: TanStackAIMessage[] = [
        msg('user', 'Search'),
        msg('assistant', 'ok', {
          tool_calls: [
            { id: 'tc_s', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        }),
        msg('tool', 'result', { tool_call_id: 'tc_s' }),
        msg('assistant', 'Done'),
      ];
      const result = compactMessages(mixed, { toolCalls: [{ type: 'all', tools: ['search'] }] });
      expect(result.filter((m) => m.role === 'tool')).toHaveLength(0);
    });
  });

  describe('reasoning', () => {
    const withThinking: TanStackAIMessage[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1', { thinking: { thinking: 'old reasoning' } }),
      msg('user', 'q2'),
      msg('assistant', 'a2', { thinking: { thinking: 'new reasoning' } }),
    ];

    it("mode='none' (default) keeps all reasoning", () => {
      const result = compactMessages(withThinking, {});
      expect(result.filter((m) => m.thinking)).toHaveLength(2);
    });

    it("mode='all' strips reasoning from every assistant message", () => {
      const result = compactMessages(withThinking, { reasoning: 'all' });
      expect(result.filter((m) => m.thinking)).toHaveLength(0);
      // Messages themselves are kept
      expect(result).toHaveLength(4);
    });

    it("mode='before-last-message' keeps reasoning only on the final message", () => {
      const result = compactMessages(withThinking, { reasoning: 'before-last-message' });
      expect(result[1].thinking).toBeUndefined();
      expect(result[3].thinking).toEqual({ thinking: 'new reasoning' });
    });

    it("mode='before-last-message' strips everything when the final message is not assistant", () => {
      const endsWithUser = [...withThinking, msg('user', 'q3')];
      const result = compactMessages(endsWithUser, { reasoning: 'before-last-message' });
      expect(result.filter((m) => m.thinking)).toHaveLength(0);
    });
  });

  describe('emptyMessages', () => {
    it('removes empty messages by default', () => {
      const messages: TanStackAIMessage[] = [
        msg('user', 'Hello'),
        msg('assistant', ''),
        msg('user', ''),
        msg('assistant', 'Hi'),
      ];
      const result = compactMessages(messages, {});
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

    it('keeps empty messages that carry attachments', () => {
      const messages: TanStackAIMessage[] = [
        msg('user', '', { attachments: [{ mediaType: 'image/png', data: 'aGk=' }] }),
        msg('assistant', 'Nice image'),
      ];
      const result = compactMessages(messages, { emptyMessages: 'remove' });
      expect(result).toHaveLength(2);
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
