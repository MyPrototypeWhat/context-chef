import type { TanStackAIMessage } from './adapter';
import type { CompactConfig } from './types';

type ToolCallsEntry = {
  type: 'all' | 'before-last-message' | `before-last-${number}-messages`;
  tools?: string[];
};

/**
 * Mechanical compaction — zero LLM cost. Operates on IR messages between
 * `fromTanStackAI` and compression.
 *
 * Semantics mirror AI SDK `pruneMessages` (and therefore
 * `@context-chef/ai-sdk-middleware`'s `compact`):
 *
 * - `reasoning`: strips IR `thinking` from assistant messages —
 *   `'before-last-message'` keeps it only on the final message of the array.
 * - `toolCalls`: "last N messages" windows count messages of the whole
 *   array (any role). Tool calls/results referenced from inside the window
 *   are kept everywhere; outside it, matching tool calls are stripped from
 *   assistant messages and their result messages removed. Array entries
 *   apply their mode only to the tools named in `tools` (all when omitted)
 *   and are applied in order.
 * - `emptyMessages` (default `'remove'`): drops messages left with no text
 *   content, no tool calls, no thinking, and no attachments.
 */
export function compactMessages(
  messages: TanStackAIMessage[],
  config: CompactConfig,
): TanStackAIMessage[] {
  let result = messages;

  if (config.reasoning === 'all' || config.reasoning === 'before-last-message') {
    const keepLastIndex = config.reasoning === 'before-last-message' ? result.length - 1 : -1;
    result = result.map((m, i) =>
      m.role === 'assistant' && m.thinking && i !== keepLastIndex
        ? { ...m, thinking: undefined }
        : m,
    );
  }

  for (const entry of normalizeToolCallsConfig(config.toolCalls)) {
    result = applyToolCallsEntry(result, entry);
  }

  if (config.emptyMessages !== 'keep') {
    result = result.filter(
      (m) =>
        m.content !== '' ||
        (m.tool_calls && m.tool_calls.length > 0) ||
        m.thinking ||
        (m.attachments && m.attachments.length > 0),
    );
  }

  return result;
}

/** Normalizes the `toolCalls` option to a homogeneous entry list. */
function normalizeToolCallsConfig(toolCalls: CompactConfig['toolCalls']): ToolCallsEntry[] {
  if (toolCalls === undefined || toolCalls === 'none') return [];
  if (Array.isArray(toolCalls)) {
    for (const entry of toolCalls) windowSize(entry.type); // validate eagerly
    return toolCalls;
  }
  windowSize(toolCalls); // validate eagerly
  return [{ type: toolCalls }];
}

/**
 * Number of trailing messages protected by a mode; `undefined` for 'all'
 * (no window — everything is prunable).
 */
function windowSize(mode: ToolCallsEntry['type']): number | undefined {
  if (mode === 'all') return undefined;
  if (mode === 'before-last-message') return 1;

  const match = /^before-last-(\d+)-messages$/.exec(mode);
  if (match) return Number.parseInt(match[1], 10);

  throw new Error(
    `[context-chef] Unrecognized toolCalls compact mode: "${mode}". ` +
      `Valid modes: 'none', 'all', 'before-last-message', 'before-last-N-messages' ` +
      `(replace N with a positive integer, e.g. 'before-last-3-messages'), ` +
      `or an array of { type, tools? } entries using those modes.`,
  );
}

/**
 * Applies one toolCalls entry: strips matching tool calls from assistant
 * messages outside the protected window and removes their result messages.
 * Tool-call IDs referenced anywhere inside the window are kept everywhere,
 * so a result inside the window never loses its originating call.
 */
function applyToolCallsEntry(
  messages: TanStackAIMessage[],
  entry: ToolCallsEntry,
): TanStackAIMessage[] {
  const size = windowSize(entry.type);
  const windowStart = size === undefined ? messages.length : Math.max(0, messages.length - size);

  const keptIds = new Set<string>();
  for (let i = windowStart; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) keptIds.add(tc.id);
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      keptIds.add(msg.tool_call_id);
    }
  }

  // Resolve tool names for result messages that lack `name`.
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) idToName.set(tc.id, tc.function.name);
    }
  }

  // With a `tools` filter, only the named tools are pruned; a result whose
  // tool name cannot be resolved is conservatively kept.
  const shouldPrune = (name: string | undefined): boolean =>
    entry.tools == null || (name !== undefined && entry.tools.includes(name));

  const result: TanStackAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= windowStart) {
      result.push(msg);
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const kept = msg.tool_calls.filter(
        (tc) => keptIds.has(tc.id) || !shouldPrune(tc.function.name),
      );
      result.push(
        kept.length === msg.tool_calls.length
          ? msg
          : { ...msg, tool_calls: kept.length ? kept : undefined },
      );
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id && !keptIds.has(msg.tool_call_id)) {
      const name = msg.name ?? idToName.get(msg.tool_call_id);
      if (shouldPrune(name)) continue; // drop the result message
    }

    result.push(msg);
  }

  return result;
}
