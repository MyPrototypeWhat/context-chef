import type { TanStackAIMessage } from './adapter';
import type { CompactConfig } from './types';

/**
 * Mechanical compaction — zero LLM cost.
 * Removes tool-call/result pairs and empty messages from IR messages
 * before LLM-based compression to reduce token usage cheaply.
 */
export function compactMessages(
  messages: TanStackAIMessage[],
  config: CompactConfig,
): TanStackAIMessage[] {
  let result = messages;

  if (config.toolCalls && config.toolCalls !== 'none') {
    result = compactToolCalls(result, config.toolCalls);
  }

  if (config.emptyMessages === 'remove') {
    result = result.filter((m) => m.content !== '' || (m.tool_calls && m.tool_calls.length > 0));
  }

  return result;
}

/**
 * Removes tool-call/result pairs from messages based on the configured strategy.
 *
 * When an assistant message's tool_calls are removed, its corresponding
 * tool-result messages (matched by tool_call_id) are also removed to
 * maintain conversation coherence.
 */
function compactToolCalls(
  messages: TanStackAIMessage[],
  mode: Exclude<CompactConfig['toolCalls'], 'none' | undefined>,
): TanStackAIMessage[] {
  const protectedCount = getProtectedCount(mode);

  // Find assistant messages that actually have tool_calls
  const toolAssistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      toolAssistantIndices.push(i);
    }
  }

  const protectedStart =
    protectedCount === 0
      ? messages.length // protect nothing
      : toolAssistantIndices.length - protectedCount >= 0
        ? toolAssistantIndices[toolAssistantIndices.length - protectedCount]
        : 0; // protect all if fewer tool-assistants than protectedCount

  // Collect tool_call_ids to remove (from unprotected assistant messages)
  const removedToolCallIds = new Set<string>();
  const result: TanStackAIMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length && i < protectedStart) {
      // Strip tool_calls from this assistant message
      for (const tc of msg.tool_calls) {
        removedToolCallIds.add(tc.id);
      }
      result.push({
        ...msg,
        tool_calls: undefined,
      });
      continue;
    }

    if (msg.role === 'tool' && msg.tool_call_id && removedToolCallIds.has(msg.tool_call_id)) {
      // Remove corresponding tool result
      continue;
    }

    result.push(msg);
  }

  return result;
}

/** Determines how many trailing assistant messages are protected from compaction. */
function getProtectedCount(mode: Exclude<CompactConfig['toolCalls'], 'none' | undefined>): number {
  if (mode === 'all') return 0;
  if (mode === 'before-last-message') return 1;

  const match = mode.match(/^before-last-(\d+)-messages$/);
  if (match) return parseInt(match[1], 10);

  throw new Error(`[context-chef] Unrecognized toolCalls compact mode: "${mode}"`);
}
