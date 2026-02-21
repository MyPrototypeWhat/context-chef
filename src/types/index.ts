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

export interface TargetPayload {
  messages: any[];
  // Future expansions: tools, tool_choice, etc.
}
