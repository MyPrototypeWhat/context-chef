import type { ToolDefinition } from '../../types';

/**
 * Tool definition for retrieving offloaded/archived content by its
 * `context://` URI. Register it yourself (mechanism, not policy) and dispatch
 * matching tool calls to `chef.resolveRecall(uri)`:
 *
 * @example
 * chef.registerTools([getRecallToolDefinition()]);
 * // in your agent loop:
 * if (call.function.name === 'recall_context') {
 *   const { uri } = JSON.parse(call.function.arguments);
 *   const content = await chef.resolveRecall(uri);
 *   history.push({ role: 'tool', tool_call_id: call.id, content: content ?? '[not found]' });
 * }
 */
export function getRecallToolDefinition(): ToolDefinition {
  return {
    name: 'recall_context',
    description:
      'Retrieve the full content behind a context:// URI cited in the conversation — an ' +
      'offloaded tool output or an archived span of compacted messages. Use when exact ' +
      'details beyond the visible summary or preview are needed.',
    parameters: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'The context:// URI to resolve, exactly as cited in the conversation.',
        },
      },
      required: ['uri'],
    },
  };
}
