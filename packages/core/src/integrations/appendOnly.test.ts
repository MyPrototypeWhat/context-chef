import { describe, expect, it, vi } from 'vitest';
import { prefixBreakReporter, warnAppendOnlyConfig } from './appendOnly';

const wording = { provider: 'adapter', thinking: 'thinking' };

describe('warnAppendOnlyConfig', () => {
  it('says clearAt is ignored, behind whatever the integration reaches the provider through', () => {
    const warn = vi.fn();
    warnAppendOnlyConfig({ appendOnly: { clearAt: true } }, { warn }, wording);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      '[context-chef] appendOnly: `clearAt` is ignored by the middleware. The provider behind ' +
        'the adapter is unknown and may move a mid-conversation system message into the system ' +
        'prompt, so every event is a user message here, and a user message cannot be ' +
        'turn-scoped.',
    );
  });

  it('names every setting that moves with the conversation, in one warning', () => {
    const warn = vi.fn();
    warnAppendOnlyConfig(
      {
        appendOnly: true,
        compact: {
          reasoning: 'before-last-message',
          toolCalls: [{ type: 'all' }, { type: 'before-last-3-messages' }],
        },
        clear: ['tool-result', { target: 'tool-result', keepRecent: 2 }],
      },
      { warn },
      { ...wording, contextEditing: 'modelOptions.contextEditing' },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[context-chef] appendOnly: compact.reasoning: 'before-last-message', compact.toolCalls: " +
        "'before-last-3-messages', clear: { target: 'tool-result', keepRecent: 2 } move with the " +
        'conversation, rewriting messages earlier calls sent, so nearly every call is a ' +
        "checkpoint: the provider's prefix cache misses from the rewritten message, and signed " +
        'thinking is stripped from it on. Once a compression has landed, a rewrite that reaches ' +
        'a message it summarized also drops its summary, and the conversation is summarized ' +
        "again on every call. Use 'all', which rewrites each message once before it is first " +
        "sent, or the provider's own context editing (modelOptions.contextEditing).",
    );
  });

  it('says nothing for settings that rewrite each message once, or with appendOnly off', () => {
    const warn = vi.fn();
    warnAppendOnlyConfig(
      { appendOnly: true, compact: { reasoning: 'all', toolCalls: 'all' }, clear: ['thinking'] },
      { warn },
      wording,
    );
    warnAppendOnlyConfig(
      { compact: { reasoning: 'before-last-message' }, appendOnly: { clearAt: true } },
      { warn },
      wording,
    );
    warnAppendOnlyConfig(
      { appendOnly: false, compact: { reasoning: 'before-last-message' } },
      { warn },
      wording,
    );

    // The second call is on: only its clearAt and moving reasoning warn.
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('prefixBreakReporter', () => {
  it('hands each break on, and only warns when the handler throws', () => {
    const warn = vi.fn();
    const seen: number[] = [];
    const report = prefixBreakReporter<{ at: number }>(
      (event) => {
        seen.push(event.at);
        if (event.at === 1) throw new Error('boom');
      },
      { warn },
    );
    report({ at: 0 });
    report({ at: 1 });
    report({ at: 2 });

    expect(seen).toEqual([0, 1, 2]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[context-chef] onPrefixBreak threw — the call goes ahead');
  });

  it('does nothing without a handler', () => {
    const warn = vi.fn();
    prefixBreakReporter(undefined, { warn })({ at: 0 });

    expect(warn).not.toHaveBeenCalled();
  });
});
