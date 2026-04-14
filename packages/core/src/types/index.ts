/**
 * Core types for ContextChef internal representation (IR)
 */

// SDK type imports — type-only, fully erased at runtime
import type {
  MessageParam as AnthropicMessageParam,
  TextBlockParam as AnthropicTextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Content as GeminiContent, TextPart as GeminiTextPart } from '@google/generative-ai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * A tool available to the LLM. Moved here from Pruner to be shared across payload types.
 * The `tags` field is used internally by Pruner for task-based filtering and is stripped
 * before being sent to the LLM.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
}

/**
 * Thinking content produced by a model during extended thinking mode.
 * The `signature` field is required by Anthropic when echoing thinking back in multi-turn.
 */
export interface ThinkingContent {
  thinking: string;
  signature?: string;
}

/**
 * Privacy-redacted thinking block (Anthropic-specific).
 * The opaque `data` blob must be echoed verbatim in multi-turn conversations.
 */
export interface RedactedThinking {
  data: string;
}

/**
 * Media attachment on a message — images, files, audio, etc.
 * Provider-neutral IR representation; adapters convert to/from provider-specific formats
 * (OpenAI `image_url`/`file`, Anthropic `image`/`document`, Gemini `inline_data`/`file_data`).
 */
export interface Attachment {
  /** MIME type, e.g. 'image/png', 'application/pdf', 'audio/mp3' */
  mediaType: string;
  /** base64 encoded data or URL string */
  data: string;
  /** Optional filename */
  filename?: string;
}

export interface Message {
  role: Role;
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  // Used internally to mark cache breakpoints before targeting
  _cache_breakpoint?: boolean;
  /**
   * Thinking/reasoning content produced by the model.
   * - Anthropic: maps to ThinkingBlockParam (requires signature for multi-turn)
   * - Gemini: maps to { text, thought: true } TextPart
   * - OpenAI: discarded (Chat Completions does not accept reasoning input)
   */
  thinking?: ThinkingContent;
  /**
   * Redacted thinking block (Anthropic extended thinking with privacy filter).
   * Must be echoed verbatim. Not applicable to OpenAI or Gemini.
   */
  redacted_thinking?: RedactedThinking;
  /**
   * Media attachments (images, files, etc.) on this message.
   * `content` always holds the text-only representation.
   * Adapters convert provider-specific formats to/from this field.
   * When present during compression, Janitor augments the prompt
   * to guide the model toward describing media content in the summary.
   */
  attachments?: Attachment[];
  /** Allow provider-specific or user-defined fields to pass through without loss */
  [key: string]: unknown;
}

// ─── Compact options ───

/** Object form for tool-result clearing with keepRecent support. */
export interface ToolResultClearTarget {
  target: 'tool-result';
  /** Number of most recent tool results to preserve. Floored to 1 (never clears all). */
  keepRecent?: number;
}

/** Clearing targets for `Janitor.compact()`. */
export type ClearTarget = 'thinking' | 'tool-result' | ToolResultClearTarget;

/**
 * Options for `Janitor.compact()` — mechanical, zero-LLM-cost history compaction.
 *
 * **Note:** When using compact together with `compress()`, only clear `thinking`.
 * Clearing `tool-result` before compression causes the compression model to receive
 * empty tool results, producing low-quality summaries. See `Janitor.compact()` JSDoc
 * for recommended combinations.
 */
export interface CompactOptions {
  /** Which content types to clear from history. */
  clear: ClearTarget[];
}

export type TargetProvider = 'openai' | 'anthropic' | 'gemini';

// ─── Input adapter types ───

/** A Message whose role excludes 'system'. Used by setHistory to enforce separation. */
export type HistoryMessage = Message & { role: 'user' | 'assistant' | 'tool' };

/** Return type of input adapters (fromOpenAI, fromAnthropic, fromGemini). */
export interface ParsedMessages {
  /** System messages extracted from the provider messages. */
  system: Message[];
  /** Conversation history (user/assistant/tool messages). */
  history: HistoryMessage[];
}

export interface CompileOptions {
  target: TargetProvider;
}

// ─── Compile metadata ───

/** Metadata returned by compile() for observability. */
export interface CompileMeta {
  /** Memory keys that were injected into the system prompt this turn. */
  injectedMemoryKeys: string[];
  /** Memory keys that expired and were removed this turn. */
  memoryExpiredKeys: string[];
}

// ─── Per-provider payload types ───

export interface OpenAIPayload {
  messages: ChatCompletionMessageParam[];
  tools?: ToolDefinition[];
  meta?: CompileMeta;
}

export interface AnthropicPayload {
  system?: AnthropicTextBlockParam[];
  messages: AnthropicMessageParam[];
  tools?: ToolDefinition[];
  meta?: CompileMeta;
}

export interface GeminiPayload {
  messages: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
  tools?: ToolDefinition[];
  meta?: CompileMeta;
}

/**
 * Generic payload type — backward-compatible fallback for un-typed compile() calls.
 * Use compile({ target: 'openai' | 'anthropic' | 'gemini' }) to get strict SDK types.
 */
export interface TargetPayload {
  messages: Array<{ role?: string; content?: unknown; name?: string }>;
  system?: unknown;
  systemInstruction?: unknown;
  tools?: ToolDefinition[];
  meta?: CompileMeta;
}
