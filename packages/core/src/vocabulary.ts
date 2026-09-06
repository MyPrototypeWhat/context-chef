/**
 * The words the model reads.
 *
 * Every string ContextChef puts in front of a model — the memory instruction,
 * the memory block, the truncation marker, the summary wrapper, the handoff
 * notice — belongs to one of two vocabularies, and a session speaks exactly
 * one of them. `tools: 'legacy'` keeps the 4.x wording, where memory is its
 * own feature with its own tools; `tools: 'unified'` describes one addressed
 * context store reached through one `context` tool.
 *
 * Resolved once, in the `ContextChef` constructor, and handed to the modules
 * that render. {@link LEGACY_VOCABULARY} delegates to the existing `Prompts`
 * entries verbatim, which is what makes the default byte-identical.
 */

import { Prompts } from './prompts';

/** Which vocabulary a session speaks. Mirrors `ChefConfig.tools`. */
export type VocabularyMode = 'legacy' | 'unified';

/** Everything the truncation marker is rendered from. */
export interface OffloadPlaceholderArgs {
  /** `context://vfs/<path>` of the stored content. */
  uri: string;
  totalLines: number;
  totalChars: number;
  /** The visible head slice, post line-snap. Empty when none is shown. */
  head: string;
  /** The visible tail slice, post line-snap. Empty when none is shown. */
  tail: string;
  /** On-disk path, when the backend has one. */
  physicalPath?: string | null;
}

/** The window a summary belongs to, as the unified wrapper states it. */
export interface SummaryLineage {
  current: string;
  previous?: string;
}

/**
 * One session's model-facing wording. Field for field, the strings that differ
 * between `tools: 'legacy'` and `tools: 'unified'`.
 */
export interface Vocabulary {
  readonly mode: VocabularyMode;
  /** The standing system message injected when memory is enabled. */
  readonly memoryInstruction: string;
  /**
   * The line the injected memory block opens with. The block self-introduces
   * through it, which is what lets `compile()` drop its anchor line for a
   * memory-only tail injection — and what `auditAnthropicCachePlacement`
   * recognizes the block by.
   */
  readonly memoryBlockHeader: string;
  /** The injected memory block: header, data, key guidance. */
  memoryBlock(coreMemoryXml: string, existingKeys: string[], allowedKeys?: string[]): string;
  /** The marker left in place of offloaded tool output. */
  offloadPlaceholder(args: OffloadPlaceholderArgs): string;
  /** The continuation framing around a compression summary. */
  summaryWrapper(summary: string, lineage?: SummaryLineage): string;
  /** Default `overflow.handoff.prompt`, with its `{n_remaining}` placeholder. */
  readonly handoffNotice: string;
}

/**
 * The 4.x wording. Every field delegates to the `Prompts` entry that produced
 * it before Phase 4c, so a legacy session emits the same bytes it always has.
 * `lineage` is ignored here: adding a line to the wrapper would change the
 * default payload, which is exactly what this vocabulary exists to prevent.
 */
export const LEGACY_VOCABULARY: Vocabulary = Object.freeze({
  mode: 'legacy',
  memoryInstruction: Prompts.MEMORY_INSTRUCTION,
  memoryBlockHeader: Prompts.MEMORY_BLOCK_HEADER,
  memoryBlock: (coreMemoryXml, existingKeys, allowedKeys) =>
    Prompts.getMemoryBlock(coreMemoryXml, existingKeys, allowedKeys),
  offloadPlaceholder: ({ uri, totalLines, totalChars, head, tail, physicalPath }) =>
    Prompts.getVFSOffloadReminder(uri, totalLines, totalChars, head, tail, physicalPath ?? null),
  summaryWrapper: (summary) => Prompts.getCompactSummaryWrapper(summary),
  handoffNotice: Prompts.HANDOFF_NOTICE_TEMPLATE,
} satisfies Vocabulary);

/** The `tools: 'unified'` wording: one store, one tool, `context://` addresses. */
export const UNIFIED_VOCABULARY: Vocabulary = Object.freeze({
  mode: 'unified',
  memoryInstruction: Prompts.CONTEXT_STORE_INSTRUCTION,
  memoryBlockHeader: Prompts.CONTEXT_MEMORY_BLOCK_HEADER,
  memoryBlock: (coreMemoryXml, existingKeys, allowedKeys) =>
    Prompts.getContextMemoryBlock(coreMemoryXml, existingKeys, allowedKeys),
  offloadPlaceholder: ({ uri, totalLines, totalChars, head, tail, physicalPath }) =>
    Prompts.getContextOffloadReminder(
      uri,
      totalLines,
      totalChars,
      head,
      tail,
      physicalPath ?? null,
    ),
  summaryWrapper: (summary, lineage) => Prompts.getContextSummaryWrapper(summary, lineage),
  handoffNotice: Prompts.CONTEXT_HANDOFF_NOTICE_TEMPLATE,
} satisfies Vocabulary);

/** The vocabulary a `tools` mode speaks. */
export function resolveVocabulary(mode: VocabularyMode): Vocabulary {
  return mode === 'unified' ? UNIFIED_VOCABULARY : LEGACY_VOCABULARY;
}
