import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Memory, type MemoryConfig } from '../modules/memory';
import { Offloader } from '../modules/offloader';
import { FileSystemBackend } from '../store/backends/fileSystem';
import { InMemoryBackend } from '../store/backends/inMemory';
import { Store } from '../store/store';
import type { SearchHit, StorageBackend } from '../store/types';
import {
  type ContextToolCall,
  type ContextToolHost,
  dispatchContextTool,
  isContextToolName,
} from './dispatch';
import { type ContextToolPolicyConfig, resolveContextToolPolicy } from './policy';

/** InMemoryBackend plus the optional `search` capability. */
class SearchableBackend extends InMemoryBackend {
  search(ns: string, query: string): SearchHit[] {
    const needle = query.toLowerCase();
    return this.list(ns)
      .filter((listed) => this.read(ns, listed.path)?.content.toLowerCase().includes(needle))
      .map((listed) => ({ path: listed.path, meta: listed.meta, snippet: 'native hit' }));
  }
}

interface Harness {
  host: ContextToolHost;
  backend: StorageBackend;
  store: Store;
  memory: Memory | null;
  offloader: Offloader;
  newContextCalls: number;
  run(call: ContextToolCall): Promise<string>;
  context(args: Record<string, unknown>): Promise<string>;
}

function harness(
  options: {
    backend?: StorageBackend;
    memory?: Partial<MemoryConfig> | null;
    policy?: ContextToolPolicyConfig;
    /** The Offloader's URI scheme, when the test needs a non-default one. */
    uriScheme?: string;
  } = {},
): Harness {
  const backend = options.backend ?? new InMemoryBackend();
  const store = new Store(backend);
  const offloader = new Offloader({ store, threshold: 0, uriScheme: options.uriScheme });
  const memory = options.memory === null ? null : new Memory({ store, ...(options.memory ?? {}) });

  const state = { newContextCalls: 0 };
  const host: ContextToolHost = {
    memory,
    offloader,
    store,
    policy: resolveContextToolPolicy(options.policy),
    requestNewContext: () => {
      state.newContextCalls++;
    },
  };

  return {
    host,
    backend,
    store,
    memory,
    offloader,
    get newContextCalls() {
      return state.newContextCalls;
    },
    run: (call) => dispatchContextTool(host, call),
    context: (args) => dispatchContextTool(host, { name: 'context', arguments: args }),
  };
}

describe('dispatchContextTool — notes/', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await h.store.namespace('notes').put('plan.md', 'alpha\nbeta\ngamma');
  });

  it('views a file with line numbers', async () => {
    const result = await h.context({ command: 'view', path: 'context://notes/plan.md' });
    expect(result).toBe('     1\talpha\n     2\tbeta\n     3\tgamma');
  });

  it('accepts a bare namespace path and a JSON-string arguments payload', async () => {
    const result = await h.run({
      name: 'context',
      arguments: JSON.stringify({ command: 'view', path: 'notes/plan.md' }),
    });
    expect(result).toContain('alpha');
  });

  it('lists a namespace root as a directory', async () => {
    await h.store.namespace('notes').put('todo.md', 'x');
    const result = await h.context({ command: 'view', path: 'context://notes/' });
    expect(result).toBe(
      'context://notes/ (2 entries):\n- context://notes/plan.md\n- context://notes/todo.md',
    );
  });

  it('lists a nested prefix when the path itself holds no entry', async () => {
    await h.store.namespace('notes').put('specs/api.md', 'x');
    const result = await h.context({ command: 'view', path: 'notes/specs' });
    expect(result).toContain('context://notes/specs/api.md');
  });

  it('reports an empty directory rather than an error', async () => {
    const result = await h.context({ command: 'view', path: 'notes/archive/' });
    expect(result).toBe('context://notes/archive/ is empty.');
  });

  it('errors on an unknown path', async () => {
    const result = await h.context({ command: 'view', path: 'notes/missing.md' });
    expect(result).toBe('Error: nothing is stored at context://notes/missing.md.');
  });

  it('creates a new entry', async () => {
    const result = await h.context({
      command: 'create',
      path: 'notes/new.md',
      file_text: 'hello',
    });
    expect(result).toBe('Created context://notes/new.md.');
    expect((await h.store.namespace('notes').get('new.md'))?.content).toBe('hello');
  });

  it('refuses to create over an existing entry', async () => {
    const result = await h.context({ command: 'create', path: 'notes/plan.md', file_text: 'x' });
    expect(result).toContain('Error: context://notes/plan.md already exists');
    expect((await h.store.namespace('notes').get('plan.md'))?.content).toBe('alpha\nbeta\ngamma');
  });

  it('requires file_text for create', async () => {
    const result = await h.context({ command: 'create', path: 'notes/new.md' });
    expect(result).toBe(
      'Error: the "file_text" argument is required and must be a non-empty string.',
    );
  });

  it('str_replace swaps a unique occurrence and keeps createdAt', async () => {
    const before = await h.store.namespace('notes').get('plan.md');
    const result = await h.context({
      command: 'str_replace',
      path: 'notes/plan.md',
      old_str: 'beta',
      new_str: 'BETA',
    });
    const after = await h.store.namespace('notes').get('plan.md');

    expect(result).toBe('Edited context://notes/plan.md.');
    expect(after?.content).toBe('alpha\nBETA\ngamma');
    expect(after?.meta.createdAt).toBe(before?.meta.createdAt);
  });

  it('str_replace treats $& in new_str as literal text', async () => {
    await h.context({
      command: 'str_replace',
      path: 'notes/plan.md',
      old_str: 'beta',
      new_str: '$&$&',
    });
    expect((await h.store.namespace('notes').get('plan.md'))?.content).toBe('alpha\n$&$&\ngamma');
  });

  it('str_replace errors when old_str is absent', async () => {
    const result = await h.context({
      command: 'str_replace',
      path: 'notes/plan.md',
      old_str: 'delta',
      new_str: 'x',
    });
    expect(result).toContain('old_str was not found in context://notes/plan.md');
  });

  it('str_replace errors when old_str is ambiguous', async () => {
    await h.store.namespace('notes').put('dup.md', 'same\nsame');
    const result = await h.context({
      command: 'str_replace',
      path: 'notes/dup.md',
      old_str: 'same',
      new_str: 'x',
    });
    expect(result).toContain('appears more than once');
  });

  it('inserts at a 0-based line', async () => {
    const result = await h.context({
      command: 'insert',
      path: 'notes/plan.md',
      insert_line: 0,
      insert_text: 'zero',
    });
    expect(result).toBe('Inserted into context://notes/plan.md.');
    expect((await h.store.namespace('notes').get('plan.md'))?.content).toBe(
      'zero\nalpha\nbeta\ngamma',
    );
  });

  it('appends when insert_line equals the line count', async () => {
    await h.context({
      command: 'insert',
      path: 'notes/plan.md',
      insert_line: 3,
      insert_text: 'delta',
    });
    expect((await h.store.namespace('notes').get('plan.md'))?.content).toBe(
      'alpha\nbeta\ngamma\ndelta',
    );
  });

  it('errors when insert_line is out of range', async () => {
    const result = await h.context({
      command: 'insert',
      path: 'notes/plan.md',
      insert_line: 9,
      insert_text: 'x',
    });
    expect(result).toBe(
      'Error: insert_line 9 is out of range for context://notes/plan.md, which has 3 lines. Use 0 to 3.',
    );
  });

  it('deletes an entry, and errors on a second delete', async () => {
    expect(await h.context({ command: 'delete', path: 'notes/plan.md' })).toBe(
      'Deleted context://notes/plan.md.',
    );
    expect(await h.context({ command: 'delete', path: 'notes/plan.md' })).toBe(
      'Error: nothing is stored at context://notes/plan.md.',
    );
  });

  it('renames an entry', async () => {
    const result = await h.context({
      command: 'rename',
      path: 'notes/plan.md',
      new_path: 'notes/plan-v2.md',
    });
    expect(result).toBe('Renamed context://notes/plan.md to context://notes/plan-v2.md.');
    expect(await h.store.namespace('notes').get('plan.md')).toBeNull();
    expect((await h.store.namespace('notes').get('plan-v2.md'))?.content).toBe(
      'alpha\nbeta\ngamma',
    );
  });

  it('refuses to rename onto an existing entry', async () => {
    await h.store.namespace('notes').put('taken.md', 'x');
    const result = await h.context({
      command: 'rename',
      path: 'notes/plan.md',
      new_path: 'notes/taken.md',
    });
    expect(result).toBe('Error: context://notes/taken.md already exists.');
    expect(await h.store.namespace('notes').get('plan.md')).not.toBeNull();
  });

  it('refuses to rename across namespaces', async () => {
    const result = await h.context({
      command: 'rename',
      path: 'notes/plan.md',
      new_path: 'memory/plan',
    });
    expect(result).toContain('cannot move context://notes/plan.md into another namespace');
  });

  it('searches by scanning when the backend has no search capability', async () => {
    await h.store.namespace('notes').put('specs/api.md', 'the beta endpoint');
    const result = await h.context({ command: 'search', path: 'notes/', query: 'beta' });

    expect(result).toContain('2 matches for "beta" under context://notes/');
    expect(result).toContain('context://notes/plan.md');
    expect(result).toContain('context://notes/specs/api.md');
  });

  it('scopes a scanned search to the path prefix', async () => {
    await h.store.namespace('notes').put('specs/api.md', 'the beta endpoint');
    const result = await h.context({ command: 'search', path: 'notes/specs', query: 'beta' });

    expect(result).toContain('1 match for "beta"');
    expect(result).not.toContain('plan.md');
  });

  it('uses the backend search when it has one', async () => {
    const searchable = harness({ backend: new SearchableBackend() });
    await searchable.store.namespace('notes').put('plan.md', 'alpha beta');
    const result = await searchable.context({ command: 'search', path: 'notes/', query: 'beta' });

    expect(result).toContain('native hit');
  });

  it('reports no matches without an error', async () => {
    const result = await h.context({ command: 'search', path: 'notes/', query: 'nothing here' });
    expect(result).toBe('No matches for "nothing here" under context://notes/.');
  });

  it('rejects a directory as the target of a write', async () => {
    const result = await h.context({ command: 'delete', path: 'notes/' });
    expect(result).toBe('Error: context://notes/ is a directory. Name an entry to delete.');
  });

  it('rejects a path that escapes its namespace', async () => {
    const result = await h.context({ command: 'view', path: 'notes/../../etc/passwd' });
    expect(result).toContain('".." is not allowed in a path');
  });

  it('rejects a malformed path', async () => {
    const result = await h.context({ command: 'view', path: 'context://' });
    expect(result).toContain('is not a context path');
  });

  // Regression: "parsePath validates `..` in the path but not in the namespace
  // segment" and "Namespace segment is never validated, so
  // context://../<dir>/<file> reads outside the store root". Reads are
  // unrestricted by design, so parsePath is the whole containment for them.
  describe('path validation', () => {
    const rejected: [string, string][] = [
      ['a namespace that climbs out of the store root', 'context://../'],
      ['a namespace that climbs into a sibling directory', 'context://../secrets/key.txt'],
      ['a dot namespace', 'context://./notes/plan.md'],
      ['a backslash traversal', 'context://notes/..\\..\\evil.txt'],
      ['a backslash separator', 'context://notes\\evil.txt'],
      ['a dot segment inside the path', 'context://notes/./plan.md'],
      ['an empty path segment', 'context://notes//plan.md'],
      ['a foreign scheme read as a namespace', 'unknown://vfs_abc.txt'],
    ];

    it.each(rejected)('rejects %s', async (_why, path) => {
      const result = await h.context({ command: 'view', path });
      expect(result).toMatch(/^Error: .*is not a context path/);
    });

    it.each(rejected)('rejects %s for a write too', async (_why, path) => {
      const result = await h.context({ command: 'create', path, file_text: 'pwned' });
      expect(result).toMatch(/^Error: /);
    });

    it('still accepts keys with spaces, unicode and dots in them', async () => {
      await h.store.namespace('notes').put('my 笔记 v1.2.md', 'kept');
      const result = await h.context({ command: 'view', path: 'notes/my 笔记 v1.2.md' });
      expect(result).toBe('     1\tkept');
    });

    it('still treats a trailing slash as a directory', async () => {
      await h.store.namespace('notes').put('specs/api.md', 'x');
      const result = await h.context({ command: 'view', path: 'context://notes/specs/' });
      expect(result).toContain('context://notes/specs/api.md');
    });
  });

  it('rejects an unknown command', async () => {
    const result = await h.context({ command: 'append', path: 'notes/plan.md' });
    expect(result).toContain('Error: unknown command "append"');
  });

  it('rejects arguments that are not a JSON object', async () => {
    expect(await h.run({ name: 'context', arguments: 'not json' })).toBe(
      'Error: the tool arguments were not valid JSON.',
    );
    expect(await h.run({ name: 'context', arguments: '[1,2]' })).toBe(
      'Error: the tool arguments must be a JSON object.',
    );
  });
});

describe('dispatchContextTool — memory/', () => {
  it('creates, views and lists entries with descriptions', async () => {
    const h = harness();
    await h.context({
      command: 'create',
      path: 'memory/project_language',
      file_text: 'TypeScript',
      description: 'The language this project is written in',
    });
    await h.context({ command: 'create', path: 'memory/tone', file_text: 'concise' });

    expect(await h.context({ command: 'view', path: 'memory/project_language' })).toBe(
      'TypeScript',
    );
    expect(await h.context({ command: 'view', path: 'memory/' })).toBe(
      [
        'context://memory/ (2 entries):',
        '- context://memory/project_language — The language this project is written in',
        '- context://memory/tone',
      ].join('\n'),
    );
  });

  it('refuses to create over an existing key', async () => {
    const h = harness();
    await h.context({ command: 'create', path: 'memory/k', file_text: 'v' });
    const result = await h.context({ command: 'create', path: 'memory/k', file_text: 'w' });
    expect(result).toContain('Error: context://memory/k already exists');
  });

  it('returns an error string when allowedKeys does not cover the key', async () => {
    const h = harness({ memory: { allowedKeys: ['allowed'] } });
    const result = await h.context({ command: 'create', path: 'memory/denied', file_text: 'v' });

    expect(result).toBe(
      'Error: context://memory/denied is not an allowed memory key. Allowed keys: allowed.',
    );
    expect(await h.memory?.get('denied')).toBeNull();
  });

  it('returns an error string when onMemoryUpdate vetoes the write', async () => {
    const h = harness({ memory: { onMemoryUpdate: () => false } });
    const result = await h.context({ command: 'create', path: 'memory/k', file_text: 'v' });

    expect(result).toBe('Error: the write to context://memory/k was rejected by the host.');
    expect(await h.memory?.get('k')).toBeNull();
  });

  it('fires onMemoryChanged for a create and a delete', async () => {
    const onMemoryChanged = vi.fn();
    const h = harness({ memory: { onMemoryChanged } });

    await h.context({ command: 'create', path: 'memory/k', file_text: 'v' });
    await h.context({ command: 'delete', path: 'memory/k' });

    expect(onMemoryChanged.mock.calls.map(([event]) => event.type)).toEqual(['set', 'delete']);
  });

  it('str_replace routes through updateMemory and bumps updateCount', async () => {
    const h = harness();
    await h.context({ command: 'create', path: 'memory/k', file_text: 'alpha beta' });
    expect((await h.memory?.getEntry('k'))?.updateCount).toBe(1);

    const result = await h.context({
      command: 'str_replace',
      path: 'memory/k',
      old_str: 'beta',
      new_str: 'gamma',
    });

    expect(result).toBe('Edited context://memory/k.');
    const entry = await h.memory?.getEntry('k');
    expect(entry?.value).toBe('alpha gamma');
    expect(entry?.updateCount).toBe(2);
  });

  it('str_replace respects the veto hook', async () => {
    let allow = true;
    const h = harness({ memory: { onMemoryUpdate: () => allow } });
    await h.context({ command: 'create', path: 'memory/k', file_text: 'alpha' });
    allow = false;

    const result = await h.context({
      command: 'str_replace',
      path: 'memory/k',
      old_str: 'alpha',
      new_str: 'beta',
    });
    expect(result).toBe('Error: the write to context://memory/k was rejected by the host.');
    expect(await h.memory?.get('k')).toBe('alpha');
  });

  it('inserts into an entry value', async () => {
    const h = harness();
    await h.context({ command: 'create', path: 'memory/k', file_text: 'one\ntwo' });
    await h.context({ command: 'insert', path: 'memory/k', insert_line: 1, insert_text: 'mid' });

    expect(await h.memory?.get('k')).toBe('one\nmid\ntwo');
  });

  it('renames a key, honouring allowedKeys on the destination', async () => {
    const h = harness({ memory: { allowedKeys: ['old', 'new'] } });
    await h.context({ command: 'create', path: 'memory/old', file_text: 'v' });

    expect(
      await h.context({ command: 'rename', path: 'memory/old', new_path: 'memory/nope' }),
    ).toContain('is not an allowed memory key');

    const result = await h.context({
      command: 'rename',
      path: 'memory/old',
      new_path: 'memory/new',
    });
    expect(result).toBe('Renamed context://memory/old to context://memory/new.');
    expect(await h.memory?.get('old')).toBeNull();
    expect(await h.memory?.get('new')).toBe('v');
  });

  it('searches values and descriptions', async () => {
    const h = harness();
    await h.context({
      command: 'create',
      path: 'memory/a',
      file_text: 'nothing relevant',
      description: 'about deployments',
    });
    await h.context({ command: 'create', path: 'memory/b', file_text: 'deployment steps' });
    await h.context({ command: 'create', path: 'memory/c', file_text: 'unrelated' });

    const result = await h.context({ command: 'search', path: 'memory/', query: 'deploy' });
    expect(result).toContain('2 matches for "deploy" under context://memory/');
    expect(result).toContain('context://memory/a');
    expect(result).toContain('context://memory/b');
    expect(result).not.toContain('context://memory/c');
  });

  it('errors clearly when no memory module is configured', async () => {
    const h = harness({ memory: null });
    const result = await h.context({ command: 'view', path: 'memory/k' });

    expect(result).toContain('Error: context://memory/ is not available');
    expect(result).toContain('memory: { store }');
  });

  it('rejects a directory target for a write', async () => {
    const h = harness();
    const result = await h.context({ command: 'create', path: 'memory/', file_text: 'v' });
    expect(result).toBe('Error: context://memory/ is a directory. Name the memory key to create.');
  });
});

describe('dispatchContextTool — vfs/ and archive/', () => {
  it('views an offloaded URI as its stored content', async () => {
    const h = harness();
    const { uri } = await h.offloader.offloadAsync('the full tool output', {
      threshold: 0,
      headChars: 0,
      tailChars: 0,
    });

    expect(await h.context({ command: 'view', path: uri as string })).toBe('the full tool output');
  });

  it('renders an archived span as a transcript', async () => {
    const h = harness();
    const span = JSON.stringify({
      version: 1,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    const { uri } = await h.offloader.offloadAsync(span, {
      threshold: 0,
      headChars: 0,
      tailChars: 0,
    });

    const result = await h.context({ command: 'view', path: uri as string });
    expect(result).toContain('[archived span — 2 messages]');
    expect(result).toContain('user:\nhello');
    expect(result).toContain('assistant:\nhi');
  });

  it('denies writes into vfs/ under the default policy', async () => {
    const h = harness();
    const result = await h.context({ command: 'create', path: 'vfs/note.txt', file_text: 'x' });

    expect(result).toBe(
      'Error: context://vfs/note.txt is read-only. This tool may write to: context://memory/, context://notes/.',
    );
    expect(await h.store.namespace('vfs').get('note.txt')).toBeNull();
  });

  it('allows writes into vfs/ when the policy includes it', async () => {
    const h = harness({ policy: { writable: ['notes', 'vfs'] } });
    const result = await h.context({ command: 'create', path: 'vfs/note.txt', file_text: 'x' });

    expect(result).toBe('Created context://vfs/note.txt.');
    expect((await h.store.namespace('vfs').get('note.txt'))?.content).toBe('x');
  });

  it('reads any namespace regardless of the write policy', async () => {
    const h = harness({ policy: { writable: [] } });
    await h.store.namespace('custom').put('a.txt', 'readable');

    expect(await h.context({ command: 'view', path: 'custom/a.txt' })).toBe('     1\treadable');
  });
});

describe('dispatchContextTool — tool names', () => {
  it('classifies the five owned names and nothing else', () => {
    for (const name of [
      'context',
      'new_context',
      'create_memory',
      'modify_memory',
      'recall_context',
    ]) {
      expect(isContextToolName(name)).toBe(true);
    }
    for (const name of ['read_file', 'context_', 'Context', '']) {
      expect(isContextToolName(name)).toBe(false);
    }
  });

  it('throws on a foreign tool name — a routing bug, not a model mistake', async () => {
    const h = harness();
    await expect(h.run({ name: 'read_file', arguments: {} })).rejects.toThrow(
      /is not a ContextChef tool/,
    );
  });

  it('new_context requests a fresh window', async () => {
    const h = harness();
    expect(await h.run({ name: 'new_context', arguments: '{}' })).toBe(
      'Starting a new context window.',
    );
    expect(await h.run({ name: 'new_context' })).toBe('Starting a new context window.');
    expect(h.newContextCalls).toBe(2);
  });

  it('create_memory writes into memory/', async () => {
    const h = harness();
    const result = await h.run({
      name: 'create_memory',
      arguments: { key: 'k', value: 'v', description: 'why' },
    });

    expect(result).toBe('Created context://memory/k.');
    expect((await h.memory?.getEntry('k'))?.description).toBe('why');
  });

  // The legacy tools take the key raw, so the path check the `context` tool
  // gets from parsePath has to happen here too — a memory key is a storage key.
  it('create_memory and modify_memory refuse a traversing key', async () => {
    const h = harness();
    expect(
      await h.run({ name: 'create_memory', arguments: { key: '../evil', value: 'v' } }),
    ).toContain('is not a context path');
    expect(
      await h.run({
        name: 'modify_memory',
        arguments: { action: 'update', key: 'notes\\evil', value: 'v' },
      }),
    ).toContain('is not a context path');
    expect(await h.memory?.getAll()).toEqual([]);
  });

  it('modify_memory updates and deletes', async () => {
    const h = harness();
    await h.run({ name: 'create_memory', arguments: { key: 'k', value: 'v' } });

    expect(
      await h.run({
        name: 'modify_memory',
        arguments: { action: 'update', key: 'k', value: 'v2' },
      }),
    ).toBe('Updated context://memory/k.');
    expect(await h.memory?.get('k')).toBe('v2');

    expect(await h.run({ name: 'modify_memory', arguments: { action: 'delete', key: 'k' } })).toBe(
      'Deleted context://memory/k.',
    );
    expect(await h.memory?.get('k')).toBeNull();
  });

  it('modify_memory reports an unknown key and an unknown action', async () => {
    const h = harness();
    expect(
      await h.run({ name: 'modify_memory', arguments: { action: 'update', key: 'k', value: 'v' } }),
    ).toBe('Error: nothing is stored at context://memory/k.');

    await h.run({ name: 'create_memory', arguments: { key: 'k', value: 'v' } });
    expect(await h.run({ name: 'modify_memory', arguments: { action: 'purge', key: 'k' } })).toBe(
      'Error: action must be "update" or "delete", got "purge".',
    );
  });

  it('recall_context is view by another name', async () => {
    const h = harness();
    const { uri } = await h.offloader.offloadAsync('recalled body', {
      threshold: 0,
      headChars: 0,
      tailChars: 0,
    });

    expect(await h.run({ name: 'recall_context', arguments: { uri } })).toBe('recalled body');
    expect(
      await h.run({ name: 'recall_context', arguments: { uri: 'context://vfs/gone.txt' } }),
    ).toBe('Error: nothing is stored at context://vfs/gone.txt.');
  });
});

// Regression: "Namespace segment is never validated, so context://../<dir>/<file>
// reads outside the store root" — proved against a real filesystem backend,
// since an in-memory namespace has no parent to escape into.
describe('dispatchContextTool — store root containment', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'context-chef-escape-'));

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function fsHarness() {
    fs.mkdirSync(path.join(base, 'secrets'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'secrets', 'key.txt'),
      JSON.stringify({ content: 'AWS_SECRET=hunter2', meta: {} }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(base, 'creds.json'),
      JSON.stringify({ content: 'AWS_SECRET=hunter2', meta: {} }),
      'utf8',
    );
    return harness({ backend: new FileSystemBackend(path.join(base, 'store')) });
  }

  it('cannot view a file beside the store root', async () => {
    const h = fsHarness();
    const result = await h.context({ command: 'view', path: 'context://../creds.json' });
    expect(result).not.toContain('hunter2');
    expect(result).toContain('is not a context path');
  });

  it('cannot view a file under a sibling directory', async () => {
    const h = fsHarness();
    const result = await h.context({ command: 'view', path: 'context://../secrets/key.txt' });
    expect(result).not.toContain('hunter2');
    expect(result).toContain('is not a context path');
  });

  it('cannot enumerate the store root parent', async () => {
    const h = fsHarness();
    const result = await h.context({ command: 'view', path: 'context://../' });
    expect(result).not.toContain('creds.json');
    expect(result).toContain('is not a context path');
  });

  it('cannot search outside the store root', async () => {
    const h = fsHarness();
    const result = await h.context({ command: 'search', path: 'context://../', query: 'AWS' });
    expect(result).not.toContain('hunter2');
    expect(result).toContain('is not a context path');
  });

  it('cannot write outside the store root, and leaves nothing behind if it tries', async () => {
    const h = fsHarness();
    const result = await h.context({
      command: 'create',
      path: 'context://notes/..\\..\\evil.txt',
      file_text: 'pwned',
    });
    expect(result).toMatch(/^Error: /);
    expect(fs.existsSync(path.join(base, 'evil.txt'))).toBe(false);
    expect(fs.readdirSync(base).sort()).toEqual(['creds.json', 'secrets']);
  });
});

// Regression: "recall_context / context view cannot resolve offloaded content
// when vfs.uriScheme is customised" — every truncation marker cites
// offloader.uri(), so the dispatcher has to understand that scheme.
describe('dispatchContextTool — custom vfs.uriScheme', () => {
  it('recalls the URI the Offloader itself cited', async () => {
    const h = harness({ uriScheme: 'mem://' });
    const { uri } = await h.offloader.offloadAsync('offloaded body', {
      threshold: 0,
      headChars: 0,
      tailChars: 0,
    });

    expect(uri).toMatch(/^mem:\/\//);
    expect(await h.run({ name: 'recall_context', arguments: { uri } })).toBe('offloaded body');
    expect(await h.context({ command: 'view', path: uri })).toBe('offloaded body');
  });

  it('reports a miss under the custom scheme as a miss, not a bad path', async () => {
    const h = harness({ uriScheme: 'mem://' });
    expect(await h.run({ name: 'recall_context', arguments: { uri: 'mem://gone.txt' } })).toBe(
      'Error: nothing is stored at context://vfs/gone.txt.',
    );
  });

  it('refuses a traversing path smuggled in under the custom scheme', async () => {
    const h = harness({ uriScheme: 'mem://' });
    const result = await h.run({ name: 'recall_context', arguments: { uri: 'mem://../evil.txt' } });
    expect(result).toContain('is not a context path');
  });

  it('leaves the default scheme addressing exactly as it was', async () => {
    const h = harness();
    const { uri } = await h.offloader.offloadAsync('default body', {
      threshold: 0,
      headChars: 0,
      tailChars: 0,
    });

    expect(uri).toMatch(/^context:\/\/vfs\//);
    expect(await h.run({ name: 'recall_context', arguments: { uri } })).toBe('default body');
    expect(await h.context({ command: 'view', path: 'context://vfs/' })).toContain(
      'context://vfs/',
    );
  });
});
