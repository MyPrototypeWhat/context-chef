/**
 * `new_context` — the model's handle on the overflow axis.
 */

import type { ToolDefinition } from '../types';

/**
 * One frozen definition for the process. The prefix-stability guarantee says
 * every library-owned tool schema is static, and the cheapest way to keep a
 * schema static is to only ever have one of it.
 */
const NEW_CONTEXT_TOOL: ToolDefinition = Object.freeze({
  name: 'new_context',
  description:
    'Start a new context window. Older conversation is compressed or archived according to ' +
    'the configured overflow strategy; environment and tool state are unaffected. Use after ' +
    'finishing a piece of work whose details are no longer needed, or when the remaining ' +
    'headroom is too small for the next step.',
});

/**
 * The `new_context` tool definition: no parameters, identical bytes on every
 * call, safe to place in a cached prefix.
 *
 * Registering it is the caller's decision (mechanism, not policy) and so is
 * dispatch — route a call to {@link ContextChef.requestNewContext}, which
 * forces the overflow phase of the next compile:
 *
 * @example
 * chef.registerTools([getNewContextToolDefinition()]);
 * // in your agent loop:
 * if (call.function.name === 'new_context') {
 *   chef.requestNewContext();
 *   history.push({ role: 'tool', tool_call_id: call.id, content: 'Starting a new context window.' });
 * }
 */
export function getNewContextToolDefinition(): ToolDefinition {
  return NEW_CONTEXT_TOOL;
}
