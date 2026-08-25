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

/**
 * Minimal logging hook for degradation warnings (storage write failures,
 * misconfiguration, swallowed callback errors). Defaults to `console`.
 * Pass your host's logger service to land warnings in application logs.
 */
export interface ChefLogger {
  warn(message: string, ...args: unknown[]): void;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
  /**
   * Gemini thought signature riding on this functionCall part. Gemini 3.x
   * validates that function calls in the current turn echo their signature
   * verbatim (400 error otherwise). Stored here — NOT in `Message.thinking` —
   * so `compact({ clear: ['thinking'] })` can never destroy it. Round-trips
   * through `fromGemini` / the Gemini target adapter; other adapters ignore it.
   */
  thoughtSignature?: string;
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
  /**
   * Deferred-loading annotation: a tool marked `defer_loading: true` is not
   * loaded into the initial context. Two provider mechanisms consume it:
   * Claude discovers deferred tools on demand via tool search, and (under the
   * `mid-conversation-tool-changes` beta) a deferred tool stays withheld
   * until a `tool_addition` block surfaces it mid-conversation. Deferred
   * definitions are stripped before the cache key is computed, so adding them
   * never invalidates an existing cache entry. OpenAI has an equivalent
   * native tool-search mechanism. ContextChef passes the flag through
   * `payload.tools` verbatim; converting to the provider's wire field
   * (`defer_loading`) is the caller's tool-conversion step, same as the rest
   * of the definition. Ignored by providers without deferred loading.
   */
  deferLoading?: boolean;
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
  /**
   * Constraint pinning: a pinned message survives every lossy operation
   * verbatim. `Janitor.compress()` re-inserts it (in original order) right
   * after the summary instead of summarizing it away, and `compact()` never
   * clears its tool results / thinking / reasoning tags.
   *
   * Pinning is turn-scoped: pinning any message of an atomic turn (assistant
   * with tool_calls + its tool results) protects the whole turn, so tool
   * pairing stays intact.
   *
   * Use for governance/safety constraints, standing task rules, and anything
   * whose loss would change behavior. Research background: compaction that
   * drops policy text raises constraint-violation rates from 0% to 30%+
   * (arXiv:2606.22528); pinning restores 0%.
   */
  pinned?: boolean;
  /**
   * Positional system message: only meaningful on `role: 'system'`. A marked
   * message stays AT ITS POSITION in the message stream instead of being
   * hoisted into the provider's top-level system parameter.
   *
   * Anthropic supports mid-conversation `role: "system"` messages natively on
   * Fable 5 / Mythos 5 / Opus 4.8 / Opus 5 (NOT Sonnet 5): the cached prefix
   * stays intact and the text carries operator precedence — the intended
   * channel for announcing mid-session capability changes (tools/skills
   * added or withdrawn). OpenAI Chat Completions keeps system messages
   * inline anyway, so the flag is a no-op there; the Responses adapter emits
   * a positional system message as an inline `message` item instead of
   * folding it into the top-level `instructions` parameter. Gemini has no
   * system role in `contents`; the adapter degrades a positional system
   * message to a `user` content entry verbatim.
   *
   * Placement contract (Anthropic API constraint): a positional system
   * message is valid only IMMEDIATELY AFTER a user turn — in IR terms, the
   * preceding message must be a `user` or `tool` message (tool results map
   * to user-role `tool_result` content on the wire). Leading the stream,
   * following a plain assistant turn, or sitting between a `tool_use` and
   * its `tool_result` are all rejected by the API, so the Anthropic adapter
   * hoists a positional message in any of those positions into the
   * top-level system prompt instead (warn-once per adapter instance).
   * Consecutive positional system messages after one user turn are fine.
   *
   * Round-trip note: the `from*` input parsers SKIP mid-stream system
   * entries rather than parsing them into history — they are volatile
   * channel content (announcements are re-rendered every compile until
   * retracted), and baking them into durable history would put the text in
   * the cached prefix and defeat retraction.
   */
  _positional?: boolean;
  /** Allow provider-specific or user-defined fields to pass through without loss */
  [key: string]: unknown;
}

// ─── Compact options ───

/** Object form for tool-result clearing with keepRecent / name-based filtering. */
export interface ToolResultClearTarget {
  target: 'tool-result';
  /** Number of most recent clearable tool results to preserve. Floored to 1 (never clears all). */
  keepRecent?: number;
  /**
   * Only clear results produced by these tool names. Tool names are resolved
   * from the preceding assistant turn's `tool_calls` via `tool_call_id`;
   * results whose name cannot be resolved are left untouched when a filter
   * is present. Mirrors Anthropic `clear_tool_uses` semantics locally.
   */
  toolFilter?: string[];
  /**
   * Never clear results produced by these tool names. Applied after
   * `toolFilter` (an exemption wins over a filter match). Mirrors Anthropic
   * `exclude_tools`.
   */
  exemptTools?: string[];
}

/**
 * Clearing targets for `Janitor.compact()`.
 *
 * - `'thinking'`: strips Anthropic-native `thinking` / `redacted_thinking` fields
 * - `'tool-result'`: replaces old tool-result content with a placeholder
 * - `'reasoning-tags'`: strips `<think>...</think>` XML blocks from assistant
 *   content strings (DeepSeek-R1 / QwQ / locally-hosted reasoning models)
 */
export type ClearTarget = 'thinking' | 'tool-result' | 'reasoning-tags' | ToolResultClearTarget;

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

/** Built-in adapter names registered automatically on package import. */
export type BuiltinTargetProvider = 'openai' | 'anthropic' | 'gemini';

/**
 * Adapter target name. Includes the three built-ins plus any string the user
 * has registered via `adapterRegistry.register(name, adapter)`. The
 * `(string & {})` trick keeps IDE auto-complete on the literals while still
 * accepting arbitrary strings at the type level.
 */
export type TargetProvider = BuiltinTargetProvider | (string & {});

/**
 * Target adapter contract: receives compiled IR messages and returns a
 * provider-shaped payload. Implement this to plug a custom provider into
 * `chef.compile()` via `adapterRegistry.register()` or by passing the
 * instance directly as `compile({ target: instance })`.
 */
export interface ITargetAdapter {
  compile(messages: Message[]): TargetPayload;
}

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
  /**
   * Where to send the compiled payload. Three forms accepted:
   * - Built-in literal (`'openai' | 'anthropic' | 'gemini'`) — strict payload type
   * - Registered name (`'cohere'`, etc.) — looked up via `adapterRegistry`
   * - `ITargetAdapter` instance — used directly, bypassing the registry
   *
   * Falls back to `ChefConfig.defaultTarget`, then to `'openai'`, when omitted.
   */
  target?: TargetProvider | ITargetAdapter;
  /**
   * Cooperative cancellation signal for this compile() call.
   *
   * Two effects:
   * 1. Forwarded to every `chef.on(event, handler)` handler as the second
   *    argument so observers can short-circuit slow async work (DB writes,
   *    metric exports, fetch calls).
   * 2. Checked at internal phase boundaries (after `compile:start`, after
   *    Janitor compress, after `onBeforeCompile`, after memory sweep, after
   *    `transformContext`). When `signal.aborted` becomes true at a boundary,
   *    compile() throws via `signal.throwIfAborted()` (DOMException with
   *    `name: 'AbortError'`).
   *
   * Signal is also threaded into `memory:changed` / `memory:expired` events
   * fired during this compile(). Memory events emitted from external
   * `memory().set()` / `memory().delete()` calls outside of compile() receive
   * `signal: undefined`.
   *
   * Caveats:
   * - **`compile:start` is emitted before any abort check**, so observers may
   *   still receive a `compile:start` event for a compile() call that
   *   ultimately throws AbortError without emitting `compile:done`.
   * - **Memory turn counter advances at step 4 (before step 7 boundary)**, so
   *   aborting after step 4 leaves `Memory.turnCount` advanced even though no
   *   payload was produced. Subsequent compiles continue from the advanced
   *   turn — TTL-based entries may expire one turn earlier than expected.
   * - **Cancellation is coarse-grained.** Long-running phases (`Janitor.compress`,
   *   user-supplied `onBeforeCompile` / `transformContext`) run to completion;
   *   abort is only honored at the next phase boundary.
   */
  signal?: AbortSignal;
}

// ─── Compile metadata ───

/** Metadata returned by compile() for observability. */
export interface CompileMeta {
  /** Memory keys that were injected into the system prompt this turn. */
  injectedMemoryKeys: string[];
  /** Memory keys that expired and were removed this turn. */
  memoryExpiredKeys: string[];
  /** Name of the active skill at compile time, if any was activated. */
  activeSkillName?: string;
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
  /**
   * Server-side context management config, set when
   * `ChefConfig.contextManagement.strategy === 'server'`. Spread into the
   * Messages API request verbatim (`context_management: { edits: [...] }`).
   */
  context_management?: unknown;
  /**
   * Beta headers the emitted `context_management` edits require
   * (e.g. 'compact-2026-01-12', 'context-management-2025-06-27'). Pass as the
   * `anthropic-beta` header / SDK `betas` option.
   */
  betas?: string[];
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
