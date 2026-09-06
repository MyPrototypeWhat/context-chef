import { describe, expect, it } from 'vitest';
import { CONTEXT_COMMANDS, getContextToolDefinition } from './contextTool';

describe('getContextToolDefinition', () => {
  it('returns the same frozen object on every call', () => {
    const first = getContextToolDefinition();
    const second = getContextToolDefinition();

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.parameters)).toBe(true);
    expect(() => {
      (first as { name: string }).name = 'other';
    }).toThrow();
  });

  it('declares the seven commands and the command-specific arguments', () => {
    const params = getContextToolDefinition().parameters as {
      type: string;
      properties: Record<string, { type: string; enum?: string[] }>;
      required: string[];
    };

    expect(params.type).toBe('object');
    expect(params.properties.command.enum).toEqual([
      'view',
      'create',
      'str_replace',
      'insert',
      'delete',
      'rename',
      'search',
    ]);
    expect(params.properties.command.enum).toEqual([...CONTEXT_COMMANDS]);
    expect(params.required).toEqual(['command', 'path']);
    expect(Object.keys(params.properties)).toEqual([
      'command',
      'path',
      'file_text',
      'old_str',
      'new_str',
      'insert_line',
      'insert_text',
      'new_path',
      'query',
      'description',
    ]);
    expect(params.properties.insert_line.type).toBe('integer');
  });

  it('carries no volatile content — the schema sits in the cached prefix', () => {
    const serialized = JSON.stringify(getContextToolDefinition());

    // No live state: no key enums, no counts, no timestamps, no paths.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toMatch(/\bvfs_[a-f0-9]+/);
    const enums = JSON.stringify(
      (getContextToolDefinition().parameters as { properties: Record<string, unknown> }).properties,
    ).match(/"enum":/g);
    expect(enums).toHaveLength(1); // only `command`
  });

  it('tells the model what a context:// path is and that errors are recoverable', () => {
    const { description } = getContextToolDefinition();

    expect(description).toContain('context://<namespace>/<path>');
    expect(description).toContain('memory/');
    expect(description).toContain('automatically');
    expect(description).toContain('error message');
  });
});
