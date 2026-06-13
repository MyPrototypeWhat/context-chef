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

  it('routes storage-failure warnings to the injected logger', async () => {
    const logger = { warn: vi.fn() };
    const storage = {
      write: () => {
        throw new Error('disk full');
      },
      read: () => null,
    };
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [{ role: 'tool', content: longContent, toolCallId: 'tc_1' }];
    const result = await truncateToolResults(
      messages,
      { threshold: 50, headChars: 10, tailChars: 10, storage },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('Storage adapter write failed');
    // Result should still contain truncated content (fallback succeeded)
    expect(result[0].content).toContain('--- truncated');
  });

  it('preserves a tool listed by name (string entry) and bypasses storage', async () => {
    const mockStorage = {
      write: vi.fn(),
      read: vi.fn(),
    };
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [
      { role: 'tool', name: 'read_file', content: longContent, toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      storage: mockStorage,
      perTool: ['read_file'],
    });

    expect(result).toEqual(messages);
    expect(mockStorage.write).not.toHaveBeenCalled();
  });

  it('respects per-tool threshold override', async () => {
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [
      { role: 'tool', name: 'fetch_logs', content: longContent, toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 100,
      headChars: 10,
      tailChars: 10,
      perTool: [{ name: 'fetch_logs', threshold: 1000 }],
    });

    expect(result).toEqual(messages);
  });

  it('respects per-tool tailChars override', async () => {
    const content = `${'A'.repeat(200)}TAIL_MARKER`;
    const messages: ModelMessage[] = [
      { role: 'tool', name: 'big_query', content, toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 0,
      tailChars: 5,
      perTool: [{ name: 'big_query', tailChars: 50 }],
    });

    const out = result[0].content as string;
    expect(out).toContain('TAIL_MARKER');
    expect(out).toContain('truncated');
  });

  it('last entry wins on duplicate tool name', async () => {
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [
      { role: 'tool', name: 'foo', content: longContent, toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      perTool: [{ name: 'foo', threshold: 999 }, 'foo'],
    });

    // String 'foo' wins → preserved as-is
    expect(result).toEqual(messages);
  });

  it('resolves tool name from preceding assistant toolCalls when msg.name is missing', async () => {
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      // Note: no `name` — matches the canonical UIMessage → ModelMessage shape
      { role: 'tool', content: longContent, toolCallId: 'tc_1' },
    ];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      perTool: ['read_file'],
    });

    // Resolved via toolCallId → preserved as-is
    expect(result[1]).toEqual(messages[1]);
  });

  it('falls through to defaults when tool name cannot be resolved', async () => {
    const longContent = 'x'.repeat(500);
    const messages: ModelMessage[] = [{ role: 'tool', content: longContent, toolCallId: 'tc_1' }];
    const result = await truncateToolResults(messages, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      perTool: ['read_file'],
    });

    // No name on msg AND no preceding assistant → default truncation applies
    const out = result[0].content as string;
    expect(out).toContain('--- truncated');
    expect(out.length).toBeLessThan(longContent.length);
  });
});
