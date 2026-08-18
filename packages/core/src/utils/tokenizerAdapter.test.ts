import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { createTokenizerAdapter } from './tokenizerAdapter';

// Deterministic fake encoder: 1 token per 4 characters, rounded up.
const fakeEncode = (text: string) => new Array(Math.ceil(text.length / 4));

describe('createTokenizerAdapter', () => {
  it('returns 0 for an empty history', () => {
    const count = createTokenizerAdapter(fakeEncode);
    expect(count([])).toBe(0);
  });

  it('counts message content plus the default per-message overhead of 4', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const messages: Message[] = [{ role: 'user', content: 'a'.repeat(8) }];
    // 8 chars -> 2 tokens, + 4 overhead
    expect(count(messages)).toBe(6);
  });

  it('applies the per-message overhead to every message, even empty ones', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const messages: Message[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ];
    expect(count(messages)).toBe(8);
  });

  it('counts thinking content', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'abcd',
        thinking: { thinking: 'x'.repeat(8), signature: 'sig' },
      },
    ];
    // content 4 chars -> 1, thinking 8 chars -> 2, + 4 overhead
    expect(count(messages)).toBe(7);
  });

  it('counts redacted thinking data', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const messages: Message[] = [
      { role: 'assistant', content: '', redacted_thinking: { data: 'r'.repeat(12) } },
    ];
    // redacted 12 chars -> 3, + 4 overhead
    expect(count(messages)).toBe(7);
  });

  it('counts tool-call names and arguments (the write/edit span regression class)', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const args = '{"path":"a.ts","content":"hi"}'; // 30 chars -> 8 tokens
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write_file', arguments: args } },
          { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } },
        ],
      },
    ];
    // write_file 10 -> 3, args 30 -> 8, grep 4 -> 1, '{}' 2 -> 1, + 4 overhead
    expect(count(messages)).toBe(17);
  });

  it('skips attachments (base64 payloads are not tokenized)', () => {
    const count = createTokenizerAdapter(fakeEncode);
    const messages: Message[] = [
      {
        role: 'user',
        content: 'hey!',
        attachments: [{ mediaType: 'image/png', data: 'A'.repeat(4000) }],
      },
    ];
    // content 4 chars -> 1, + 4 overhead; the 4000-char blob contributes nothing
    expect(count(messages)).toBe(5);
  });

  it('honors a perMessageOverhead override', () => {
    const zero = createTokenizerAdapter(fakeEncode, { perMessageOverhead: 0 });
    expect(zero([{ role: 'user', content: 'a'.repeat(8) }])).toBe(2);

    const ten = createTokenizerAdapter(fakeEncode, { perMessageOverhead: 10 });
    expect(ten([{ role: 'user', content: '' }])).toBe(10);
  });

  it('accepts encoders returning any array-like, e.g. typed arrays', () => {
    const typedEncode = (text: string) => new Uint32Array(Math.ceil(text.length / 4));
    const count = createTokenizerAdapter(typedEncode);
    expect(count([{ role: 'user', content: 'a'.repeat(8) }])).toBe(6);
  });
});
