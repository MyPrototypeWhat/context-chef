import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { VFSStorageAdapter } from '@context-chef/core';
import { describe, expect, it } from 'vitest';
import { truncateToolResults } from '../src/truncator';

describe('truncateToolResults', () => {
  const makeToolPrompt = (output: string): LanguageModelV3Prompt => [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'run_cmd',
          output: { type: 'text', value: output },
        },
      ],
    },
  ];

  it('passes through content below threshold', async () => {
    const prompt = makeToolPrompt('short output');
    const result = await truncateToolResults(prompt, { threshold: 100 });
    expect(result).toEqual(prompt);
  });

  it('truncates content above threshold', async () => {
    const longOutput = 'line\n'.repeat(500);
    const prompt = makeToolPrompt(longOutput);
    const result = await truncateToolResults(prompt, {
      threshold: 100,
      headChars: 20,
      tailChars: 20,
    });

    if (result[0].role === 'tool') {
      const part = result[0].content[0];
      if (part.type === 'tool-result' && part.output.type === 'text') {
        expect(part.output.value.length).toBeLessThan(longOutput.length);
        expect(part.output.value).toContain('truncated');
        expect(part.output.value).toContain('lines');
      }
    }
  });

  it('does not truncate when headChars + tailChars >= content length', async () => {
    const prompt = makeToolPrompt('small');
    const result = await truncateToolResults(prompt, {
      threshold: 2,
      headChars: 3,
      tailChars: 3,
    });
    expect(result).toEqual(prompt);
  });

  it('does not affect non-tool messages', async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'x'.repeat(200) },
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(200) }] },
    ];
    const result = await truncateToolResults(prompt, { threshold: 10 });
    expect(result).toEqual(prompt);
  });

  it('handles json tool output', async () => {
    const bigJson = JSON.stringify({ data: 'x'.repeat(500) });
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'query',
            output: { type: 'json', value: { data: 'x'.repeat(500) } },
          },
        ],
      },
    ];
    const result = await truncateToolResults(prompt, {
      threshold: 100,
      headChars: 20,
      tailChars: 20,
    });

    if (result[0].role === 'tool') {
      const part = result[0].content[0];
      if (part.type === 'tool-result') {
        expect(part.output.type).toBe('text');
        if (part.output.type === 'text') {
          expect(part.output.value.length).toBeLessThan(bigJson.length);
        }
      }
    }
  });

  it('preserves head and tail content', async () => {
    const output = `HEAD_CONTENT${'_'.repeat(500)}TAIL_CONTENT`;
    const prompt = makeToolPrompt(output);
    const result = await truncateToolResults(prompt, {
      threshold: 50,
      headChars: 12,
      tailChars: 12,
    });

    if (result[0].role === 'tool') {
      const part = result[0].content[0];
      if (part.type === 'tool-result' && part.output.type === 'text') {
        expect(part.output.value).toContain('HEAD_CONTENT');
        expect(part.output.value).toContain('TAIL_CONTENT');
      }
    }
  });

  it('saves original to storage adapter and includes URI', async () => {
    const stored: Record<string, string> = {};
    const mockStorage: VFSStorageAdapter = {
      write(filename: string, content: string) {
        stored[filename] = content;
      },
      read(filename: string) {
        return stored[filename] ?? null;
      },
    };

    const longOutput = 'x'.repeat(200);
    const prompt = makeToolPrompt(longOutput);
    const result = await truncateToolResults(prompt, {
      threshold: 50,
      headChars: 10,
      tailChars: 10,
      storage: mockStorage,
    });

    // Original should be stored
    const storedFiles = Object.keys(stored);
    expect(storedFiles).toHaveLength(1);
    expect(stored[storedFiles[0]]).toBe(longOutput);

    // Truncated output should contain URI
    if (result[0].role === 'tool') {
      const part = result[0].content[0];
      if (part.type === 'tool-result' && part.output.type === 'text') {
        expect(part.output.value).toContain('context://vfs/');
        expect(part.output.value.length).toBeLessThan(longOutput.length);
      }
    }
  });
});
