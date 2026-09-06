import type { Message, ToolDefinition } from '../../types';

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
 *   const content = await chef.resolveRecall(uri, { format: 'text' });
 *   history.push({ role: 'tool', tool_call_id: call.id, content: content ?? '[not found]' });
 * }
 *
 * @deprecated Under `ChefConfig.tools: 'unified'` this is the `context` tool's
 *   `view` command on a `context://vfs/…` or `context://archive/…` path, which
 *   reaches every other namespace too and needs no separate registration.
 *   `chef.handleTool` keeps dispatching `recall_context` unchanged in 4.x; the
 *   definition is removed in 5.0.
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

/**
 * How `chef.resolveRecall` renders what it found.
 *
 * - `'raw'` (default): the stored payload verbatim. An archived compression
 *   span comes back as the `{ version, messages }` JSON the Janitor wrote.
 * - `'text'`: an archived span is rendered as a readable transcript. Anything
 *   else — an offloaded tool output, a caller-written archive payload — is
 *   returned unchanged, so the mode is safe to apply to any URI.
 */
export type RecallFormat = 'raw' | 'text';

export interface ResolveRecallOptions {
  /** Rendering mode. Defaults to `'raw'`. */
  format?: RecallFormat;
}

/** Serialized shape written by the Janitor's compression archive. */
interface ArchivedSpan {
  version: number;
  messages: Message[];
}

function isArchivedSpan(value: unknown): value is ArchivedSpan {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; messages?: unknown };
  return (
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(
      (m) => typeof m === 'object' && m !== null && typeof (m as Message).role === 'string',
    )
  );
}

/** Renders one archived message: a role header plus whatever it carried. */
function renderMessage(message: Message, toolNames: Map<string, string>): string {
  const lines: string[] = [];

  if (message.role === 'tool') {
    const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
    lines.push(name ? `tool result (${name}):` : 'tool result:');
  } else {
    lines.push(`${message.role}:`);
  }

  if (message.thinking?.thinking) lines.push(`[thinking] ${message.thinking.thinking}`);
  if (message.content) lines.push(message.content);
  for (const call of message.tool_calls ?? []) {
    lines.push(`[tool call] ${call.function.name}(${call.function.arguments})`);
  }
  for (const attachment of message.attachments ?? []) {
    lines.push(`[attachment] ${attachment.filename ?? attachment.mediaType}`);
  }

  return lines.join('\n');
}

/**
 * Renders recalled content for `format: 'text'`. An archived compression span
 * becomes a transcript; every other payload passes through untouched.
 */
export function renderRecalledContent(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!isArchivedSpan(parsed)) return stored;

  // Tool results carry only a call id; the names live on the assistant turns
  // in the same span, so a local pass is enough to label them.
  const toolNames = new Map<string, string>();
  for (const message of parsed.messages) {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  }

  const header = `[archived span — ${parsed.messages.length} message${
    parsed.messages.length === 1 ? '' : 's'
  }]`;
  const body = parsed.messages.map((m) => renderMessage(m, toolNames)).join('\n\n');
  return body ? `${header}\n\n${body}` : header;
}
