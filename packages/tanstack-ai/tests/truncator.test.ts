import type { ModelMessage } from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';
import { truncateToolResults } from '../src/truncator';

describe('truncateToolResults', () => {
  it('does not truncate short content', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'tool', content: 'Short result', toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, { threshold: 100 });
    expect(result).toEqual(messages);
  });

  it('does not truncate when head + tail >= length', async () => {
    const messages: ModelMessage[] = [
      { role: 'tool', content: 'A'.repeat(50), toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 30,
      headChars: 25,
      tailChars: 25,
    });
    expect(result).toEqual(messages);
  });

  it('truncates content over threshold', async () => {
    const longContent = 'Line 1\n'.repeat(100);
    const messages: ModelMessage[] = [{ role: 'tool', content: longContent, toolCallId: 'tc_1' }];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
    });
    expect(result).toHaveLength(1);
    const content = result[0].content as string;
    expect(content).toContain('--- truncated');
    expect(content).toContain('chars total');
    expect(content.length).toBeLessThan(longContent.length);
  });

  it('skips non-tool messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'A'.repeat(200) },
      { role: 'assistant', content: 'B'.repeat(200) },
    ];
    const result = await truncateToolResults(messages, { threshold: 50 });
    expect(result).toEqual(messages);
  });

  it('uses storage adapter when provided', async () => {
    const mockStorage = {
      write: vi.fn(),
      read: vi.fn(),
    };
    const longContent = 'X'.repeat(500);
    const messages: ModelMessage[] = [{ role: 'tool', content: longContent, toolCallId: 'tc_1' }];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      storage: mockStorage,
    });
    expect(mockStorage.write).toHaveBeenCalled();
    const content = result[0].content as string;
    expect(content).toContain('context://vfs/');
  });

  it('falls back to simple truncation on storage error', async () => {
    const mockStorage = {
      write: vi.fn().mockRejectedValue(new Error('Storage failed')),
      read: vi.fn(),
    };
    const longContent = 'Y'.repeat(500);
    const messages: ModelMessage[] = [{ role: 'tool', content: longContent, toolCallId: 'tc_1' }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      storage: mockStorage,
    });
    expect(result[0].content).toContain('--- truncated');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Storage adapter write failed'));
    warnSpy.mockRestore();
  });
});
