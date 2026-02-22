/**
 * Core types for ContextChef internal representation (IR)
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface Message {
  role: Role;
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  // Used internally to mark cache breakpoints before targeting
  _cache_breakpoint?: boolean;
}

export type TargetProvider = 'openai' | 'anthropic' | 'gemini';

export interface CompileOptions {
  target: TargetProvider;
}

/** Minimal message shape; adapters may return provider-specific formats */
export interface TargetPayload {
  messages: Array<{ role?: string; content?: unknown; name?: string }>;
  // Future expansions: tools, tool_choice, etc.
}
