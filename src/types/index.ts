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
  /** Allow provider-specific or user-defined fields to pass through without loss */
  [key: string]: unknown;
}

export type TargetProvider = 'openai' | 'anthropic' | 'gemini';

export interface CompileOptions {
  target: TargetProvider;
}

// ─── Per-provider payload types ───

export interface OpenAIPayload {
  messages: ChatCompletionMessageParam[];
  tools?: ToolDefinition[];
}

export interface AnthropicPayload {
  system?: AnthropicTextBlockParam[];
  messages: AnthropicMessageParam[];
  tools?: ToolDefinition[];
}

export interface GeminiPayload {
  messages: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
  tools?: ToolDefinition[];
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
}
