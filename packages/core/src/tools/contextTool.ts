/**
 * `context` — the model's single handle on everything outside the window.
 */

import type { ToolDefinition } from '../types';

/** The seven commands, in the order the schema lists them. */
export const CONTEXT_COMMANDS = [
  'view',
  'create',
  'str_replace',
  'insert',
  'delete',
  'rename',
  'search',
] as const;

export type ContextCommand = (typeof CONTEXT_COMMANDS)[number];

/** Recursively freeze so the shared definition cannot be edited in place. */
function deepFreeze<T>(obj: T): T {
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * One frozen definition for the process.
 *
 * Tool schemas sit at the top of every provider's prompt prefix, so nothing
 * here may vary with live state: no enum of memory keys, no list of stored
 * paths, no counts. What exists right now is conveyed further down the
 * prompt — in the injected memory block and in the tool results this tool
 * returns — where a change costs a fraction of a cache invalidation.
 */
const CONTEXT_TOOL: ToolDefinition = deepFreeze({
  name: 'context',
  description:
    'Read and write the context store — the addressed content that lives outside this ' +
    'conversation window. Addresses look like `context://<namespace>/<path>` (the ' +
    '`context://` prefix is optional, so `notes/plan.md` works too). `memory/` holds durable ' +
    'facts worth carrying between conversations, `notes/` is your own working scratch space, ' +
    'and `vfs/` holds tool output that was too large to keep inline. A span of this ' +
    'conversation that was compacted away stays readable at the address its summary cites. ' +
    'Entries under `memory/` are shown to you automatically every turn; every other namespace ' +
    'stays out of the window until you read it with this tool. A namespace root such as ' +
    '`context://notes/` is a directory — `view` lists ' +
    'it. `memory/` and `notes/` are writable; the rest are read-only unless the host says ' +
    'otherwise. An unknown path, a malformed argument or a write to a read-only namespace ' +
    'comes back as an error message rather than failing the turn — read it and correct the call.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [...CONTEXT_COMMANDS],
        description:
          'The operation to perform. `view` reads an entry or lists a directory; `create` ' +
          'writes a new entry and fails if one already exists; `str_replace` swaps the single ' +
          'exact occurrence of `old_str` for `new_str`; `insert` puts `insert_text` at line ' +
          '`insert_line`; `delete` removes an entry; `rename` moves it to `new_path`; `search` ' +
          'finds entries under `path` whose content matches `query`.',
      },
      path: {
        type: 'string',
        description:
          'The entry to act on, as `context://<namespace>/<path>` or `<namespace>/<path>`. ' +
          'A trailing slash (or a bare namespace) addresses the directory itself.',
      },
      file_text: {
        type: 'string',
        description: 'The full content of the new entry. Required for `create`.',
      },
      old_str: {
        type: 'string',
        description:
          'For `str_replace`: the exact text to replace, including whitespace. It must occur ' +
          'exactly once in the entry — include surrounding lines to disambiguate.',
      },
      new_str: {
        type: 'string',
        description: 'For `str_replace`: the replacement text. Omit it to delete the matched text.',
      },
      insert_line: {
        type: 'integer',
        description:
          'For `insert`: the 0-based line the inserted text becomes. 0 puts it at the top; the ' +
          'line count of the entry appends to the end.',
      },
      insert_text: {
        type: 'string',
        description: 'For `insert`: the text to insert. Required for `insert`.',
      },
      new_path: {
        type: 'string',
        description:
          'For `rename`: the new address, in the same namespace as `path`. It must not already exist.',
      },
      query: {
        type: 'string',
        description:
          'For `search`: the text to look for. `path` scopes the search to entries beneath it.',
      },
      description: {
        type: 'string',
        description:
          'For `create` under `memory/`: a short note on what this entry is for and when it ' +
          'should be consulted. Ignored elsewhere.',
      },
    },
    required: ['command', 'path'],
  },
});

/**
 * The `context` tool definition: static, identical bytes on every call, safe to
 * place in a cached prefix. The returned object is frozen and
 * reference-stable, so `payload.tools` stays deep-equal between compiles.
 *
 * `ChefConfig.tools: 'unified'` puts it in the compiled payload for you.
 * Registering it yourself is equally fine — dispatch matching calls to
 * `chef.handleTool(call)`:
 *
 * @example
 * chef.registerTools([getContextToolDefinition()]);
 * // in your agent loop:
 * if (chef.ownsTool(call.function.name)) {
 *   const content = await chef.handleTool({
 *     name: call.function.name,
 *     arguments: call.function.arguments,
 *   });
 *   history.push({ role: 'tool', tool_call_id: call.id, content });
 * }
 */
export function getContextToolDefinition(): ToolDefinition {
  return CONTEXT_TOOL;
}
