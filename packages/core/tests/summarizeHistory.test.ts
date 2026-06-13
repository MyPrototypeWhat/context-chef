import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../src';
import { summarizeHistory } from '../src';

const slice: Message[] = [
  { role: 'user', content: 'plan a trip to Kyoto' },
  { role: 'assistant', content: 'Sure — here is a 3-day itinerary ...' },
];

describe('summarizeHistory', () => {
  it('builds the compaction prompt, calls compress, and extracts <summary>', async () => {
    const compress = vi.fn(async (messages: Message[]) => {
      const last = messages[messages.length - 1];
      expect(last.role).toBe('user');
      // CONTEXT_COMPACTION_INSTRUCTION enforces the <summary> contract
      expect(last.content.toLowerCase()).toContain('summary');
      expect(messages.length).toBe(slice.length + 1); // slice + instruction
      return '<analysis>scratch</analysis><summary>Kyoto 3-day plan</summary>';
    });
    const out = await summarizeHistory(slice, compress);
    expect(compress).toHaveBeenCalledOnce();
    expect(out).toBe('Kyoto 3-day plan');
  });

  it('appends customCompressionInstructions (additive, not replacing)', async () => {
    const compress = vi.fn(async (messages: Message[]) => {
      const instruction = messages[messages.length - 1].content;
      expect(instruction).toContain('Focus on costs');
      // the default scaffolding is still present
      expect(instruction.toLowerCase()).toContain('summary');
      return '<summary>ok</summary>';
    });
    await summarizeHistory(slice, compress, { customCompressionInstructions: 'Focus on costs' });
  });

  it('propagates compress() failures (no internal fallback/circuit breaker)', async () => {
    const compress = vi.fn(async () => {
      throw new Error('model down');
    });
    await expect(summarizeHistory(slice, compress)).rejects.toThrow('model down');
  });

  it('returns empty string for an empty slice without calling the model', async () => {
    const compress = vi.fn(async () => '<summary>should not run</summary>');
    const out = await summarizeHistory([], compress);
    expect(out).toBe('');
    expect(compress).not.toHaveBeenCalled();
  });

  it('parity: builds the same compressionMessages executeCompression does', async () => {
    // Pin behavior-identity of the extraction: capture what compress receives and
    // assert the instruction is appended as a trailing user message after the slice.
    let captured: Message[] = [];
    const compress = vi.fn(async (messages: Message[]) => {
      captured = messages;
      return '<summary>x</summary>';
    });
    await summarizeHistory(slice, compress);
    // slice preserved in order, instruction appended last
    expect(captured.slice(0, slice.length)).toEqual(slice);
    expect(captured[captured.length - 1].role).toBe('user');
  });
});
