/**
 * Turning a span of conversation into a summary: the model call, the input
 * shaping that goes with it (large tool results stubbed, attachments replaced
 * by text markers), and the rendering of the resulting summary message.
 */

import { Prompts } from '../prompts';
import type { Message } from '../types';
import { LEGACY_VOCABULARY, type SummaryLineage, type Vocabulary } from '../vocabulary';
import { buildToolNameMap } from './turns';

/**
 * Replaces media attachments with text placeholders for the compression model.
 *
 * The compression model never sees binary attachment data — it only sees text
 * markers like `[image]` or `[document: report.pdf]` prepended to the message
 * content. This avoids shipping base64 payloads through the compression call
 * (which can balloon token cost and trip prompt-too-long limits on the
 * compression call itself), while still letting the summarizer note that
 * media existed at this point in the conversation.
 *
 * Pure function — does not mutate the input array or any Message inside it.
 * Messages without attachments pass through by reference (no allocation).
 *
 * Modeled on Claude Code's `stripImagesFromMessages` strategy.
 */
function stripAttachmentsForCompression(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (!msg.attachments?.length) return msg;

    const placeholders = msg.attachments
      .map((att) => Prompts.getAttachmentPlaceholder(att.mediaType, att.filename))
      .join('\n');
    const newContent = msg.content ? `${placeholders}\n${msg.content}` : placeholders;

    const { attachments: _attachments, ...rest } = msg;
    return { ...rest, content: newContent };
  });
}

/**
 * Replaces large tool-result content with a metadata stub for the
 * compression model.
 *
 * The summarizer only needs to know "what happened" at each turn — feeding
 * it 87 KB of raw `fs_read` output wastes tokens and tends to drown the
 * actual conversation arc in noise. Each oversized tool message is
 * rewritten to a one-line stub like
 * `[Tool fs_read returned 87123 chars; omitted before summarization]`,
 * preserving tool name + size so the summary can still reference the
 * operation meaningfully. tool_use ↔ tool_result pairing is structurally
 * preserved.
 *
 * Tool name is resolved from the preceding assistant turn's
 * `tool_calls[].function.name` via `tool_call_id` — falls back to
 * `'unknown'` if the link is missing.
 *
 * Pure function — does not mutate inputs. Only acts on `role: 'tool'`
 * messages whose content length exceeds `threshold`.
 */
function stripLargeToolResultsForCompression(messages: Message[], threshold: number): Message[] {
  const nameMap = buildToolNameMap(messages);
  return messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    if (msg.content.length <= threshold) return msg;
    const name = (msg.tool_call_id && nameMap.get(msg.tool_call_id)) ?? 'unknown';
    const stub = `[Tool ${name} returned ${msg.content.length} chars; omitted before summarization]`;
    return { ...msg, content: stub };
  });
}

export interface SummarizeHistoryOptions {
  /** Extra instructions appended to (not replacing) the default compaction
   *  prompt — the default <analysis>/<summary> scaffolding is always kept. */
  customCompressionInstructions?: string;
  /** Replace tool-result content longer than this many chars with a one-line
   *  metadata stub before summarizing (saves summarizer tokens). */
  toolResultStubThreshold?: number;
  /** Numbered domain guidelines injected after the base instruction and
   *  before customCompressionInstructions. See JanitorConfig.compressionGuidelines. */
  compressionGuidelines?: string[];
  /** Replace the BASE instruction (default CONTEXT_COMPACTION_INSTRUCTION).
   *  The replacement must keep the <analysis>/<summary> output contract —
   *  used internally for the anchored-compaction instruction. */
  baseInstruction?: string;
}

/**
 * Produce a compression summary for a slice of conversation `messages`, using
 * the same pipeline as the in-flight `compress` path: tool-result stubbing →
 * attachment stripping → trailing instruction → `<summary>` extraction. Returns
 * the extracted summary text (after `formatCompactSummary` strips `<analysis>`
 * and unwraps `<summary>`) — the caller wraps it (e.g. with
 * `Prompts.getCompactSummaryWrapper`) if it wants the continuation framing.
 *
 * Stateless: no circuit breaker, no fallback. THROWS if `compress` throws —
 * callers decide their own degradation. `Janitor.executeCompression` delegates
 * here and keeps its own try/catch + circuit breaker.
 *
 * An empty `messages` slice returns `''` without invoking `compress`.
 *
 * @param messages   The slice to summarize (conversation only; exclude the
 *                   standing system prompt).
 * @param compress   Model callback `(messages) => Promise<string>`. It MUST
 *                   map `tool` roles and assistant tool-calls to plain
 *                   user/assistant text — providers reject raw `tool` roles, so
 *                   a naive passthrough will break on tool messages. If you use
 *                   ai-sdk-middleware, call `summarizeMessages(prompt, model)`
 *                   instead of building this manually; its internal
 *                   `createCompressionAdapter` is the reference flattener.
 */
export async function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts: SummarizeHistoryOptions = {},
): Promise<string> {
  if (messages.length === 0) return '';

  let instruction = opts.baseInstruction ?? Prompts.CONTEXT_COMPACTION_INSTRUCTION;
  const guidelines = (opts.compressionGuidelines ?? []).map((g) => g.trim()).filter(Boolean);
  if (guidelines.length > 0) {
    instruction += `\n\nDomain Guidelines:\n${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
  }
  const extra = opts.customCompressionInstructions?.trim();
  if (extra) {
    instruction += `\n\nAdditional Instructions:\n${extra}`;
  }

  const stubbed =
    opts.toolResultStubThreshold !== undefined
      ? stripLargeToolResultsForCompression(messages, opts.toolResultStubThreshold)
      : messages;

  const compressionMessages: Message[] = [
    ...stripAttachmentsForCompression(stubbed),
    { role: 'user', content: instruction },
  ];

  const raw = await compress(compressionMessages);
  return Prompts.formatCompactSummary(raw);
}

/**
 * Renders a summary into the message that replaces the compressed span.
 *
 * One place builds this message so the runner can re-render it once the
 * result has landed — with the archive citation appended and the window
 * lineage it now knows — and produce the same bytes a strategy would have.
 *
 * `vocabulary` and `lineage` default to the 4.x rendering: the legacy
 * vocabulary ignores the lineage, and a strategy that renders speculatively
 * has no landed window to name yet.
 */
export function renderSummaryMessage(
  summary: string,
  citation = '',
  vocabulary: Vocabulary = LEGACY_VOCABULARY,
  lineage?: SummaryLineage,
): Message {
  return { role: 'user', content: vocabulary.summaryWrapper(summary + citation, lineage) };
}
