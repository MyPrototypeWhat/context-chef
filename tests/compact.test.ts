import { describe, expect, it } from 'vitest';
import { ContextChef } from '../src/index';
import { Janitor } from '../src/modules/janitor';
import type { Message } from '../src/types';

const janitor = new Janitor({ contextWindow: Infinity });

// ─── Helpers ───

const toolCallMsg: Message = {
  role: 'assistant',
  content: '',
  tool_calls: [
    { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
  ],
};

const toolResultMsg: Message = {
  role: 'tool',
  content: 'file content here, very long...',
  tool_call_id: 'tc_1',
};

const thinkingMsg: Message = {
  role: 'assistant',
  content: 'Here is the answer.',
  thinking: { thinking: 'Let me reason about this...', signature: 'sig_abc' },
};

const redactedThinkingMsg: Message = {
  role: 'assistant',
  content: 'Answer based on redacted reasoning.',
  redacted_thinking: { data: 'opaque_data_blob' },
};

const userMsg: Message = { role: 'user', content: 'Hello' };
const assistantMsg: Message = { role: 'assistant', content: 'Hi there' };
const systemMsg: Message = { role: 'system', content: 'You are helpful.' };

// ═══════════════════════════════════════════════════════
// clearToolResults
// ═══════════════════════════════════════════════════════

describe('compact — clear tool-result', () => {
  it('replaces tool message content with placeholder', () => {
    const result = janitor.compact([toolCallMsg, toolResultMsg], { clear: ['tool-result'] });

    expect(result[1].content).toBe('[Tool result cleared]');
    expect(result[1].tool_call_id).toBe('tc_1'); // preserved
  });

  it('preserves non-tool messages', () => {
    const history = [userMsg, assistantMsg, systemMsg, toolResultMsg];
    const result = janitor.compact(history, { clear: ['tool-result'] });

    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('Hi there');
    expect(result[2].content).toBe('You are helpful.');
    expect(result[3].content).toBe('[Tool result cleared]');
  });

  it('preserves assistant tool_calls (does not strip call args)', () => {
    const result = janitor.compact([toolCallMsg, toolResultMsg], { clear: ['tool-result'] });

    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls![0].function.arguments).toBe('{"path":"a.ts"}');
  });
});

// ═══════════════════════════════════════════════════════
// clearThinking
// ═══════════════════════════════════════════════════════

describe('compact — clear thinking', () => {
  it('strips thinking from assistant messages', () => {
    const result = janitor.compact([thinkingMsg], { clear: ['thinking'] });

    expect(result[0].thinking).toBeUndefined();
    expect(result[0].content).toBe('Here is the answer.');
  });

  it('strips redacted_thinking from assistant messages', () => {
    const result = janitor.compact([redactedThinkingMsg], { clear: ['thinking'] });

    expect(result[0].redacted_thinking).toBeUndefined();
    expect(result[0].content).toBe('Answer based on redacted reasoning.');
  });

  it('leaves assistant messages without thinking unchanged', () => {
    const result = janitor.compact([assistantMsg], { clear: ['thinking'] });

    expect(result[0]).toEqual(assistantMsg);
  });

  it('does not touch non-assistant messages', () => {
    const result = janitor.compact([userMsg, systemMsg], { clear: ['thinking'] });

    expect(result[0]).toEqual(userMsg);
    expect(result[1]).toEqual(systemMsg);
  });
});

// ═══════════════════════════════════════════════════════
// Combined & edge cases
// ═══════════════════════════════════════════════════════

describe('compact — combined & edge cases', () => {
  it('applies multiple clear targets together', () => {
    const history = [userMsg, toolCallMsg, toolResultMsg, thinkingMsg];
    const result = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

    expect(result[0].content).toBe('Hello'); // user: untouched
    expect(result[1].tool_calls).toBeDefined(); // assistant tool_calls: untouched
    expect(result[2].content).toBe('[Tool result cleared]'); // tool result: cleared
    expect(result[3].thinking).toBeUndefined(); // thinking: cleared
    expect(result[3].content).toBe('Here is the answer.'); // content: preserved
  });

  it('returns messages unchanged with empty clear array', () => {
    const history = [userMsg, toolResultMsg, thinkingMsg];
    const result = janitor.compact(history, { clear: [] });

    expect(result).toEqual(history);
  });

  it('handles empty history', () => {
    const result = janitor.compact([], { clear: ['tool-result', 'thinking'] });

    expect(result).toEqual([]);
  });

  it('does not mutate original messages', () => {
    const original: Message = {
      role: 'tool',
      content: 'original content',
      tool_call_id: 'tc_1',
    };
    const history = [original];

    janitor.compact(history, { clear: ['tool-result'] });

    expect(original.content).toBe('original content');
  });
});

// ═══════════════════════════════════════════════════════
// Integration with onBudgetExceeded
// ═══════════════════════════════════════════════════════

describe('compact — integration with onBudgetExceeded', () => {
  it('can be used inside onBudgetExceeded as a first-pass compaction', async () => {
    const compactJanitor = new Janitor({ contextWindow: Infinity });
    const chef = new ContextChef({
      janitor: {
        contextWindow: 30,
        tokenizer: (msgs) => msgs.length * 10,
        onBudgetExceeded: (history) => {
          return compactJanitor.compact(history, { clear: ['tool-result'] });
        },
      },
    });

    const history: Message[] = [
      userMsg,
      toolCallMsg,
      { role: 'tool', content: 'very long tool output...', tool_call_id: 'tc_1' },
      { role: 'user', content: 'Now fix it.' },
    ];

    chef.setHistory(history);
    const payload = await chef.compile();

    // onBudgetExceeded returned compacted history (4 msgs × 10 = 40 > 30),
    // but compact only clears content, doesn't reduce message count,
    // so Janitor still compresses after re-evaluation
    const messages = payload.messages;
    expect(messages.length).toBeGreaterThan(0);
  });
});
