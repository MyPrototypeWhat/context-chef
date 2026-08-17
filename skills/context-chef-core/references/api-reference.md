# context-chef API Quick Reference (v4)

## Installation

```bash
npm install @context-chef/core zod
```

## Exports

All names below are verified against the v4 public barrel (`packages/core/src/index.ts`).

```typescript
import {
  // Facade
  ContextChef,

  // Modules (standalone use)
  Janitor,               // compact() + compress() + snapshot/restore
  Pruner,                // standalone tool management
  Offloader,             // standalone offloader for VFS resolve/cleanup
  Memory,                // standalone memory module
  Guardrail,             // output-format guardrails
  Assembler,             // sandwich assembly (rarely needed directly)

  // Memory stores
  InMemoryStore,         // ephemeral (testing)
  VFSMemoryStore,        // persistent (production)
  FileSystemAdapter,     // default VFS storage adapter

  // Adapters
  adapterRegistry,       // global registry: register/unregister/get/list
  AdapterRegistry,       // the registry class
  getAdapter,            // adapterRegistry.get() shorthand
  fromOpenAI,            // provider messages → IR { system, history }
  fromAnthropic,
  fromGemini,
  fromOpenAIResponses,   // Responses API items → IR
  OpenAIResponsesAdapter, // target adapter for the 'openai-responses' target

  // Compression primitives
  summarizeHistory,      // stateless summarization primitive
  planCompaction,        // durable compaction: plan-only turn-safe split
  compactHistory,        // durable compaction: one-shot summarize + reassemble
  compactMessages,       // pure function behind Janitor.compact()
  flattenForCompression, // role-flattens tool messages for plain-chat summarizers
  groupIntoTurns,        // atomic turn grouping (assistant + its tool results)

  // Recall
  getRecallToolDefinition, // recall_context tool def → dispatch to chef.resolveRecall(uri)

  // Skill module
  loadSkill,             // single SKILL.md → Skill
  loadSkillsDir,         // <dir>/<name>/SKILL.md scan (tolerant)
  loadSkillsDirs,        // multi-dir merge with precedence/namespace
  renderSkill,           // $ARGUMENTS / $0..$N / ${VAR} substitution
  formatSkillListing,    // system-prompt-friendly listing

  // Utilities
  estimate,              // rough token estimate for a string
  estimateObject,        // rough token estimate for any object
  objectToXml,           // object → XML (what setDynamicState uses)
  ensureValidHistory,    // drops orphan tool results etc.
  Prompts,               // prompt constants + helpers (getCompactSummaryWrapper, ...)
  TypedEventEmitter,
  SessionPool,           // keyed chef instances for multi-session hosts
  DEFAULT_SESSION_KEY,
  normalizeSessionKey,
  dedupeConstructionWarnings,
  VFSCleanupNotSupportedError,
} from "@context-chef/core";

// Types
import type {
  Message, ToolDefinition, ToolCall, ThinkingContent, RedactedThinking, Attachment,
  HistoryMessage, ParsedMessages,
  CompileOptions, CompileMeta, TargetProvider, BuiltinTargetProvider, ITargetAdapter,
  OpenAIPayload, AnthropicPayload, GeminiPayload, OpenAIResponsesPayload, TargetPayload,
  CompactOptions, ClearTarget, ToolResultClearTarget,
  JanitorConfig, JanitorConfigWithTokenizer, JanitorConfigWithoutTokenizer,
  JanitorSnapshot, CompressionDetails, CompressionArchiveConfig,
  SummarizeHistoryOptions, PlanCompactionOptions, CompactionPlan, Turn,
  UsagePreferenceWithTokenizer, UsagePreferenceWithoutTokenizer,
  MemoryConfig, MemoryEntry, MemorySetOptions, MemoryChangeEvent, TTLValue,
  MemoryPlacement, MemoryStore, MemoryStoreEntry, MemorySnapshot,
  OffloadOptions, VFSConfig, VFSStorageAdapter, VFSResult, VFSEntryMeta,
  VFSEvictionReason, VFSCleanupResult, CleanupOptions,
  PrunerConfig, PrunerResult, PrunerSnapshot,
  Skill, SkillLoadResult, LoadSkillsDirsOptions, FormatSkillListingOptions, RenderSkillOptions,
  BeforeCompileContext, ChefSnapshot, ChefConfig, ChefEvents, ToolCallCheckResult,
  GuardrailOptions, DynamicStatePlacement, ChefLogger, EventHandler,
} from "@context-chef/core";
```

## ChefConfig

```typescript
interface ChefConfig {
  vfs?: Partial<VFSConfig>;             // see VFSConfig below
  janitor?: JanitorConfig;              // see JanitorConfig below
  pruner?: PrunerConfig;                // { strategy?: 'union' | 'intersection' }
  memory?: MemoryConfig;                // see MemoryConfig below

  /** Sink for degradation warnings across all modules. Defaults to console.
   *  A module-level logger in vfs/janitor config wins over this one. */
  logger?: ChefLogger;                  // { warn(message, ...args): void }

  /**
   * Default adapter target used when compile() is called without a target.
   * Accepts a registered name (built-in or via adapterRegistry.register())
   * or an ITargetAdapter instance.
   * Resolution order: options.target → defaultTarget → 'openai'.
   */
  defaultTarget?: TargetProvider | ITargetAdapter;

  /**
   * Where history compression happens:
   * - 'client' (default): Janitor compresses locally.
   * - 'server': client LLM compression is skipped entirely; on the Anthropic
   *   target the payload carries context_management + betas. Compaction
   *   blocks returned by the API round-trip through fromAnthropic (pinned).
   * Construction warning if 'server' is combined with janitor.compressionModel.
   */
  contextManagement?: {
    strategy: 'client' | 'server';
    /** Provider-shaped edits config, passed through verbatim. Default when
     *  omitted under 'server': { edits: [{ type: 'compact_20260112' }] } */
    server?: unknown;
  };

  /** Transform the full message array after assembly, before adapter formatting. */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;

  /**
   * Uniform tool-result rewrite applied to every role:'tool' message at the
   * START of compile() — BEFORE compression, so the summarizer sees the
   * transformed content. Use for auto-offload, PII redaction, error
   * normalization. Non-mutating (stored history is untouched).
   * info.toolName is resolved via tool_call_id (null when unresolvable).
   */
  transformToolResult?: (
    content: string,
    info: { toolName: string | null; toolCallId: string | null },
  ) => string | Promise<string>;

  /**
   * Inject external context (RAG, AST, MCP) before compilation.
   * Return a string to inject as <implicit_context>, or null to skip.
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}
```

## Events

Subscribe with `chef.on(event, handler)`, unsubscribe with `chef.off(event, handler)`. Handlers are **error-isolated** (v4): a throwing handler is logged and compile() continues. Handlers receive an optional `AbortSignal` as the second argument when triggered by `compile({ signal })`.

```typescript
interface ChefEvents {
  'compile:start':      { systemPrompt: readonly Message[]; history: readonly Message[] };
  'compile:done':       { payload: TargetPayload };
  'compress:start':     { historyLength: number; currentTokens: number; limit: number }; // budget exceeded, before summarization
  'compress:end':       { compressed: boolean }; // false = budget fine or result rejected
  'compress':           { summary: Message; truncatedCount: number; details: CompressionDetails };
  'offload:created':    { uri: string };   // chef.offload/offloadAsync or the compression archive
  'pruner:tool-blocked': { name: string }; // checkToolCall() rejected a call
  'memory:changed':     MemoryChangeEvent;
  'memory:expired':     MemoryEntry;
}
```

Intercept hooks (can modify data / veto) remain config callbacks: `onBeforeCompress` (JanitorConfig), `onMemoryUpdate` (MemoryConfig), `onBeforeCompile` / `transformContext` / `transformToolResult` (ChefConfig).

## JanitorConfig

`JanitorConfig = JanitorConfigWithTokenizer | JanitorConfigWithoutTokenizer` — discriminated on the presence of `tokenizer`.

```typescript
interface JanitorConfigBase {
  contextWindow: number;  // Required. Model's context window in tokens

  /**
   * Compression triggers at contextWindow * triggerRatio. DEFAULT 0.7 (v4,
   * "pre-rot" — quality degrades well before the hard limit). Set 1 to
   * restore pre-4.0 trigger-at-window behavior. In the tokenizer path,
   * preserveRatio applies to this effective budget.
   */
  triggerRatio?: number;

  /**
   * Shrink guard (default 0.5; spans >= 2000 chars only): a summary that
   * doesn't shrink the compressed span's char length by at least this ratio
   * is a FAILED compression — history unchanged, circuit breaker++.
   * 0 disables. Prevents compression death loops.
   */
  minShrinkRatio?: number;

  /**
   * Post-summarization gate. Return false (or throw) to REJECT the summary:
   * history unchanged, circuit breaker incremented.
   */
  validateCompression?: (
    summary: string,
    info: { compressed: Message[]; kept: Message[] },
  ) => boolean | Promise<boolean>;

  /**
   * Reversible compression: archive the full pre-compression span; the
   * summary cites the archive URI. 'vfs' shorthand (ContextChef only) stores
   * in the chef's VFS. Standalone Janitor needs the object form.
   * Best-effort: a failing store logs a warning, compression proceeds.
   * Pair with getRecallToolDefinition() + chef.resolveRecall(uri).
   */
  archive?: CompressionArchiveConfig | 'vfs';
  // CompressionArchiveConfig = {
  //   store: (serialized: string, meta: { messageCount: number }) => string | Promise<string>
  // }  — serialized = JSON.stringify({ version: 1, messages })

  /** Numbered domain guidelines injected into the compression prompt
   *  (before customCompressionInstructions). */
  compressionGuidelines?: string[];

  /**
   * - 'rewrite' (default): each compression regenerates the whole summary.
   * - 'incremental-anchored': persistent anchor document; each compression
   *   merges ONLY the newly evicted span into it. janitor.getAnchorDoc()
   *   exposes it; survives snapshot()/restore(); cleared by reset().
   */
  compressionMode?: 'rewrite' | 'incremental-anchored';

  /**
   * - 'blocking' (default): compress() awaits summarization.
   * - 'background': first over-budget compile returns history UNCHANGED and
   *   summarizes in the background; a later compress() swaps the result in
   *   only if the span is still a prefix (message identity check) — stale
   *   results are discarded. onCompress fires at application time.
   *   Background state is NOT snapshotted.
   */
  compressionScheduling?: 'blocking' | 'background';

  // --- Tokenizer path (precise per-turn split) ---
  preserveRatio?: number;           // fraction of the effective budget to preserve (default 0.8)

  // --- reportTokenUsage path (simple) ---
  preserveRecentMessages?: number;  // recent TURNS to keep (default 1)

  // --- Compression model ---
  /**
   * Cheap-model summarizer. May reject: after 3 consecutive failures,
   * compress() short-circuits until success or reset()/clearHistory().
   * v4 BREAKING: a model failure leaves history UNCHANGED (no placeholder
   * truncation). Without a compressionModel, over-budget spans are DROPPED
   * (pinned messages kept, placeholder summary reported via onCompress only).
   */
  compressionModel?: (messagesToCompress: Message[]) => Promise<string>;

  /**
   * Replace tool-result content longer than N chars with a one-line stub
   * inside the to-be-summarized portion only. Recent (preserved) tool
   * results untouched. Default: disabled. Recommended starting value: 5000.
   */
  toolResultStubThreshold?: number;

  /** Extra instructions appended to (not replacing) the compression prompt. */
  customCompressionInstructions?: string;

  // --- Hooks ---
  /** Fires AFTER compression. details.compressedMessages = the replaced slice. */
  onCompress?: (summaryMessage: Message, truncatedCount: number, details: CompressionDetails) => void | Promise<void>;

  /**
   * Fires BEFORE compression when the budget is exceeded.
   * Return modified Message[] to intervene (e.g. compact thinking first) —
   * the budget is re-evaluated on the returned history — or null/undefined
   * to let default compression proceed. A throwing hook is caught, logged,
   * and treated as null.
   */
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;

  logger?: ChefLogger;
}

// With tokenizer:
//   tokenizer: (messages: Message[]) => number
//   usagePreference?: 'max' | 'feedFirst' | 'tokenizerFirst'   (default 'max')
// Without tokenizer:
//   usagePreference?: 'max' | 'feedFirst'
```

### Constraint pinning

`Message.pinned?: boolean` — a pinned message survives every lossy operation verbatim: `compress()` re-inserts it (in order) right after the summary; `compact()` never clears its tool results / thinking / reasoning tags. Pinning is **turn-scoped**: pinning any message of an atomic turn (assistant with tool_calls + its tool results) protects the whole turn. Use for governance/safety constraints and standing task rules.

### `compact()` — mechanical, zero-LLM-cost compaction

Method on `Janitor` (`chef` users: construct a standalone `new Janitor({ contextWindow: Infinity })` or use the exported pure `compactMessages(history, options)`).

```typescript
type ClearTarget = 'thinking' | 'tool-result' | 'reasoning-tags' | ToolResultClearTarget;

interface ToolResultClearTarget {
  target: 'tool-result';
  keepRecent?: number;      // most recent CLEARABLE results to preserve (floored to 1)
  toolFilter?: string[];    // only clear results from these tools (unresolvable names untouched)
  exemptTools?: string[];   // never clear these (an exemption wins over a filter match)
}

janitor.compact(history, { clear: ['tool-result'] });                    // strip old tool results
janitor.compact(history, { clear: ['thinking'] });                       // strip thinking/redacted_thinking
janitor.compact(history, { clear: ['reasoning-tags'] });                 // strip <think>...</think> from assistant text (v4)
janitor.compact(history, { clear: [{ target: 'tool-result', keepRecent: 5, exemptTools: ['read_file'] }] });
```

**Interaction with `compress()`:** if tool-result content should be trimmed before it reaches the compression model, prefer `toolResultStubThreshold` over `compact({ clear: ['tool-result'] })` — the stub path operates on the same boundary compress uses. Recommended combos: compact alone → clear anything; compact + compress → clear `thinking` (and/or `reasoning-tags`) only.

### Durable compaction (caller-owned message stores)

For hosts that persist their own history and want compaction to shrink the store, not just the in-flight payload:

```typescript
// Plan-only: turn-safe split, never orphans a tool result
function planCompaction(history: Message[], options: { keepRecentTurns: number }): CompactionPlan;
// CompactionPlan = { system: Message[]; toSummarize: Message[]; toKeep: Message[] }
// Input contract: flat Message[] with system messages INLINE (fromAnthropic/fromOpenAI/
// fromGemini callers must reassemble [...system, ...history] first).

// One-shot: plan → summarize → [...system, <summary user message>, ...toKeep]
function compactHistory(
  history: Message[],
  compress: (messages: Message[]) => Promise<string>,
  options: { keepRecentTurns: number } & SummarizeHistoryOptions,
): Promise<Message[]>;
// Returns the input REFERENCE unchanged on no-op (nothing old enough, or empty
// summary) — check `result === history` to skip persistence. Throws only if
// `compress` throws.

// Raw primitive
function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts?: SummarizeHistoryOptions,
): Promise<string>;
// SummarizeHistoryOptions = { customCompressionInstructions?, toolResultStubThreshold?,
//                             compressionGuidelines?, baseInstruction? }
```

Empty slice → `''` (no model call); stateless (no circuit breaker); **throws** if `compress` throws. `compress` **must role-flatten** `tool` / assistant-tool-call messages (plain chat endpoints reject raw `tool` roles) — use the exported `flattenForCompression(messages)`. Wrap results with `Prompts.getCompactSummaryWrapper(summary)` for continuation framing. AI SDK users: prefer the wrappers in `@context-chef/ai-sdk-middleware`; TanStack users: `@context-chef/tanstack-ai` exports `planCompactionTanStackMessages` / `compactTanStackMessages`.

### Recall (archive + VFS retrieval)

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]); // recall_context tool
// In the dispatch loop:
if (call.function.name === 'recall_context') {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({ role: 'tool', tool_call_id: call.id, content: content ?? '[not found]' });
}
```

`resolveRecall` covers both offloaded tool outputs (`chef.offload`) and archived compressed spans (`janitor.archive`).

## MemoryConfig

```typescript
type MemoryPlacement = 'after_system' | 'before_history_tail';

interface MemoryConfig {
  store: MemoryStore;                       // InMemoryStore or VFSMemoryStore
  defaultTTL?: TTLValue;                    // bare number = turns
  allowedKeys?: string[];                   // whitelist of allowed memory keys

  /**
   * Where the volatile <memory> data block lands (v4):
   * - 'after_system' (default): instruction + data folded into one system
   *   message after the user's system prompt. Trade-off: on Anthropic/Gemini
   *   the volatile text enters the top-level system parameter, so downstream
   *   cache breakpoints invalidate whenever memory changes.
   * - 'before_history_tail': stable instruction stays at top (cacheable);
   *   the data block is appended to the most recent user message, so cache
   *   breakpoints earlier in the stream survive memory mutations.
   *   Caveat: in tool-ending compiles the "most recent user" is the turn
   *   that started the tool sequence — breakpoints after it will miss.
   */
  memoryPlacement?: MemoryPlacement;

  /** Filter/sort/truncate entries before injection. Runs EXACTLY ONCE per
   *  compile (v4 single-scan: one full store read per compile). */
  selector?: (entries: MemoryEntry[]) => MemoryEntry[];

  /** Veto hook — return false to block the write (create/update/delete). */
  onMemoryUpdate?: (key: string, value: string | null, oldValue: string | null) => boolean | Promise<boolean>;

  /** Notification — fires after any memory change (set, delete, expire). */
  onMemoryChanged?: (event: MemoryChangeEvent) => void | Promise<void>;

  /** Fires when an entry expires during compile(). */
  onMemoryExpired?: (entry: MemoryEntry) => void | Promise<void>;
}

type TTLValue = number | { ms: number } | { turns: number };
// number = turns, e.g. 20 means "expire after 20 compile() calls"

interface MemoryEntry {
  key: string; value: string; description?: string;
  createdAt: number; updatedAt: number; updateCount: number;
  importance?: number; expiresAt?: number; expiresAtTurn?: number;
}

interface MemoryChangeEvent {
  type: 'set' | 'delete' | 'expire';
  key: string; value: string | null; oldValue: string | null;
}
```

## VFSConfig / VFSStorageAdapter

```typescript
interface VFSConfig {
  threshold: number;            // char limit before offload (ChefConfig.vfs default: 5000)
  storageDir?: string;          // default '.context_vfs' (FileSystemAdapter)
  uriScheme?: string;           // custom URI prefix
  adapter?: VFSStorageAdapter;  // custom storage (overrides storageDir)
  maxAge?: number;              // ms since createdAt before cleanup eligibility
  maxFiles?: number;            // entry-count cap
  maxBytes?: number;            // total UTF-8 byte cap
  onVFSEvicted?: (entry: VFSEntryMeta, reason: VFSEvictionReason) => void | Promise<void>;
  logger?: ChefLogger;
}

interface VFSStorageAdapter {
  write(filename: string, content: string): void | Promise<void>;
  read(filename: string): string | null | Promise<string | null>;
  /** Optional: surface the physical path in the truncation marker so the
   *  model can read the original with its existing file tool. */
  getPhysicalPath?(filename: string): string | null | Promise<string | null>;
}
```

## Skill module

```typescript
interface Skill {
  name: string;                 // unique within a registered set
  description: string;          // surfaces in formatSkillListing
  whenToUse?: string;           // guidance for LLM activation decisions
  instructions: string;         // markdown body (frontmatter stripped); injected on activation
  allowedTools?: string[];      // ANNOTATION ONLY — chef does NOT enforce; wire to
                                // pruner.setBlockedTools() yourself for hard restriction
  baseDir?: string;             // dir of the SKILL.md when loaded from disk
  metadata?: Record<string, unknown>; // unknown frontmatter keys, verbatim
}

loadSkill(filePath): Promise<Skill>;                       // throws on parse error
loadSkillsDir(dirPath): Promise<SkillLoadResult>;          // <dir>/<name>/SKILL.md, tolerant
// SkillLoadResult = { skills: Skill[]; errors: Array<{ path, message }> }
loadSkillsDirs(dirs, { precedence?: 'last-wins'|'first-wins', namespace? }): Promise<SkillLoadResult>;
formatSkillListing(skills, { maxChars?, format?: 'plain'|'xml', includeWhenToUse? }): string;
renderSkill(skill, options): Skill;                        // $ARGUMENTS / $0..$N / $name / ${VAR}; pure
```

On the chef:

| Method | Description |
|---|---|
| `registerSkills(skills): this` | Register a named set (replaces previous; defensive copies) |
| `getRegisteredSkills(): Skill[]` | Copy of the registered list |
| `activateSkill(skill \| name \| null): this` | Activate directly, by name (throws if unregistered), or clear |
| `getActiveSkill(): Skill \| undefined` | Currently active skill |

The active skill's `instructions` become a dedicated `role: 'system'` message between the system prompt and memory. `meta.activeSkillName` is set on the compiled payload. Snapshots persist `activeSkillName` + verbatim `skillInstructions` (the registry itself is NOT snapshotted — call `registerSkills` again before `restore` for name-based re-resolution).

SKILL.md frontmatter: `name` + `description` required; `when-to-use`/`whenToUse`, `allowed-tools`/`allowedTools` recognized; block scalars (`|`, `>`), inline arrays, and `- item` lists supported; unknown keys land on `metadata`.

## Message type

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _cache_breakpoint?: boolean;      // Anthropic prompt caching (stripped elsewhere)
  thinking?: ThinkingContent;       // { thinking, signature? } — Anthropic extended thinking
  redacted_thinking?: RedactedThinking; // { data } — echo verbatim
  attachments?: Attachment[];       // { mediaType, data, filename? } — provider-neutral media
  pinned?: boolean;                 // v4: survives compress() and compact() verbatim (turn-scoped)
  [key: string]: unknown;           // pass-through fields
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string /* JSON */ };
  /** v4: Gemini thought signature on this functionCall part. Gemini 3.x
   *  rejects current-turn calls without it (400). Round-trips through
   *  fromGemini/the Gemini target; immune to compact(['thinking']). */
  thoughtSignature?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags?: string[];        // Pruner-internal, stripped before the LLM
  deferLoading?: boolean; // v4: Anthropic Tool Search annotation, passed through verbatim
}
```

## ContextChef methods

### Context Building

| Method | Description |
|---|---|
| `setSystemPrompt(messages): this` | Set static system prompt (cached prefix) |
| `setHistory(messages): this` | Set conversation history |
| `setDynamicState(schema, data, { placement? }): this` | Inject Zod-validated state as XML (`'last_user'` default / `'system'`) |
| `withGuardrails(options \| null): this` | v4: options are STORED and applied at compile() — order-independent vs setDynamicState; replace semantics; `null` clears; persisted in snapshots. `GuardrailOptions = { enforceXML?: { outputTag }, prefill? }` |
| `clearHistory(): this` | Clear history and reset Janitor (incl. circuit breaker + anchor doc) |

### Tool Management

| Method | Description |
|---|---|
| `registerTools(tools): this` | Register flat tools (simple mode) |
| `registerNamespaces(groups): this` | Register Layer 1 namespace tools (KV-cache stable) |
| `registerToolkits(groups): this` | Register Layer 2 lazy-loadable toolkits |
| `getPruner(): Pruner` | Direct access to the pruner |
| `checkToolCall({ name }): ToolCallCheckResult` | v4 dispatch-time gate against the Pruner blocklist. Call per LLM tool call BEFORE invoking: `chef.checkToolCall({ name: call.function.name })`. Returns `{ allowed: true }` or `{ allowed: false, reason }` (surface `reason` back as the tool result). Missing/empty name is rejected. Emits `'pruner:tool-blocked'`. |

### Pruner methods (via `chef.getPruner()`)

| Method | Description |
|---|---|
| `pruneByTask(description): PrunerResult` | Filter tools by task relevance |
| `allowOnly(names): PrunerResult` | Keep only named tools |
| `pruneByTaskAndAllowlist(task, names): PrunerResult` | Combined filtering |
| `setBlockedTools(names): this` | Set the runtime blocklist consulted by `checkToolCall` |
| `getBlockedTools(): string[]` | Current blocklist |
| `getAllTools(): ToolDefinition[]` | All registered flat tools |
| `compile(): { tools, directoryXml }` | Compile namespace + lazy loading |
| `getDirectoryXml(): string` | Toolkit directory XML |
| `isNamespaceCall(toolCall): boolean` | Is this a namespace tool call? |
| `resolveNamespace(toolCall)` | Resolve namespace call to `{ group, toolName, args }` |
| `isToolkitLoader(toolCall): boolean` | Is this a `load_toolkit` call? |
| `extractToolkit(name): ToolDefinition[]` | Full schemas for a toolkit |
| `snapshotState()` / `restoreState(s)` | Used by chef.snapshot/restore |

```typescript
interface PrunerResult {
  tools: ToolDefinition[];  // filtered tools to pass to the LLM
  removed: string[];
  kept: number;
  total: number;
}
```

Note: Pruner's two-layer architecture (namespaces + toolkits) is deliberately two layers — do not nest deeper.

### Memory (via `chef.getMemory()`)

**Validated methods** (LLM-driven — respect `allowedKeys` + `onMemoryUpdate` veto):

| Method | Returns | Description |
|---|---|---|
| `createMemory(key, value, description?)` | `Promise<MemoryEntry \| null>` | null if vetoed/blocked |
| `updateMemory(key, value, description?)` | `Promise<MemoryEntry \| null>` | null if not found/vetoed |
| `deleteMemory(key)` | `Promise<boolean>` | false if not found/vetoed |

**Direct methods** (developer use — bypass validation hooks): `set(key, value, options?)`, `get(key)`, `getEntry(key)`, `getAll()`, `delete(key)`.

**Compile-path** (v4): `compileArtifacts()` performs the single store read per compile (sweep expired → selector once → XML + tool defs from the same read); `toXml(entries?)` and `getToolDefinitions(existingKeys?)` accept pre-fetched data.

### VFS / Offloading

| Method | Description |
|---|---|
| `offload(content, options?): string` | Sync truncation with VFS pointer (throws on async adapters) |
| `offloadAsync(content, options?): Promise<string>` | Async version |
| `resolveRecall(uri): Promise<string \| null>` | v4: full stored content behind a `context://` URI (offloaded output or archived span) |
| `getOffloader(): Offloader` | Advanced ops: `cleanup()/cleanupAsync()` (age/count/byte caps), `reconcileAsync()` (adopt orphans after restart), `resolve(uri)/resolveAsync(uri)` |

`OffloadOptions: { threshold?, headChars?, tailChars? }` (tailChars default 2000).

### Compilation

| Method | Description |
|---|---|
| `compile({ target: 'openai' }): Promise<OpenAIPayload>` | Chat Completions payload |
| `compile({ target: 'openai-responses' })` | v4: Responses API payload (`OpenAIResponsesPayload`) |
| `compile({ target: 'anthropic' }): Promise<AnthropicPayload>` | Messages API payload (+ `context_management`/`betas` under server strategy) |
| `compile({ target: 'gemini' }): Promise<GeminiPayload>` | Gemini payload |
| `compile({ target: adapterInstance })` | Any `ITargetAdapter` instance directly |
| `compile({ target: 'my-name' })` | Any name registered via `adapterRegistry.register()` |
| `compile()` | Falls back to `ChefConfig.defaultTarget`, then `'openai'` |
| `compile({ signal })` | Cooperative cancellation: checked at phase boundaries; forwarded to event handlers |
| `reportTokenUsage(count): this` | Feed API-reported token count (drives the no-tokenizer path) |

v4: concurrent `compile()` calls on one instance are serialized (queued); a failed compile doesn't poison the chain. Still: one chef per concurrent conversation is the canonical model (`SessionPool` helps).

### Snapshot & Restore

| Method | Description |
|---|---|
| `snapshot(label?): ChefSnapshot` | Full state: history, dynamic state, guardrail options, janitor (incl. anchor doc + breaker), memory, pruner, active skill name + instructions |
| `restore(snapshot): this` | Roll back everything. Skills re-resolve by name against the CURRENT registry; persisted instructions survive even with an empty registry. Pending background compressions are dropped. |

### Events

| Method | Description |
|---|---|
| `on(event, handler): this` | Subscribe (see ChefEvents above) |
| `off(event, handler): this` | Unsubscribe |

## Adapters

### Targets and the registry

Built-ins registered on import: `'openai'`, `'anthropic'`, `'gemini'`, `'openai-responses'`.

```typescript
import { adapterRegistry, getAdapter } from "@context-chef/core";

adapterRegistry.register('cohere', myAdapter);      // ITargetAdapter: { compile(messages): TargetPayload }
adapterRegistry.register('cohere', myAdapter, 'my-plugin'); // optional sourceId
adapterRegistry.unregister('cohere');
adapterRegistry.unregisterBySource('my-plugin');
adapterRegistry.list();                              // registered names
getAdapter('anthropic');                             // = adapterRegistry.get(); throws on unknown names
```

### Thinking preservation on non-Anthropic targets (v4)

The OpenAI and Gemini target adapters accept a constructor option `preserveThinkingAsText?: boolean` (default false): Anthropic-style `thinking` becomes a `<thinking>...</thinking>` text prefix instead of being dropped; `redacted_thinking` is NEVER textified (dropped with one warning).

**Caveat:** as of 4.0.0 the `OpenAIAdapter` / `GeminiAdapter` / `AnthropicAdapter` classes are internal — they are not exported from the package barrel (only the built-in registry entries, which use default options). Do not generate `import { OpenAIAdapter } ...` — it will not resolve. If the host needs this behavior today, wrap it in a custom `ITargetAdapter` (or keep thinking on the Anthropic target where it maps natively) and pass the instance as `compile({ target: instance })` or register it via `adapterRegistry.register()`.

### Input adapters (provider → IR)

```typescript
fromOpenAI(messages): ParsedMessages            // { system: Message[], history: HistoryMessage[] }
fromAnthropic(...): ParsedMessages              // v4: {type:'compaction'} blocks → pinned passthrough, re-emitted verbatim
fromGemini(...): ParsedMessages                 // v4: thought signatures round-trip (ToolCall.thoughtSignature)
fromOpenAIResponses(items, instructions?)       // v4: message/function_call/function_call_output (call_id joins,
                                                //     out-of-order safe), reasoning items with encrypted_content
                                                //     preserved byte-identically, attachments, boundary sanitization
```

### Provider adapter behavior

| Feature | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| System messages | Kept inline | Separated to `system` field | Separated to `systemInstruction` |
| Cache breakpoints | Stripped | `cache_control: { type: 'ephemeral' }` | Stripped |
| Prefill (trailing assistant) | Degraded to `[System Note]` in last user message | Native support | Degraded to `[System Note]` |
| Thinking blocks | Dropped, or `<thinking>` text with `preserveThinkingAsText` | Mapped to `ThinkingBlockParam` | Dropped, or `<thinking>` text with `preserveThinkingAsText` |
| Tool calls format | `tool_calls` array | `tool_use` content blocks | `functionCall` parts (+ `thoughtSignature` echo) |
| Internal IR fields (`pinned`, passthroughs) | Never leak into payloads | Compaction blocks re-emitted first, verbatim | Thought signatures re-emitted |

## Payload types

```typescript
interface OpenAIPayload  { messages: ChatCompletionMessageParam[]; tools?; meta?: CompileMeta }
interface AnthropicPayload {
  system?: TextBlockParam[]; messages: MessageParam[]; tools?; meta?: CompileMeta;
  context_management?: unknown;  // v4: set under contextManagement.strategy 'server'
  betas?: string[];              // v4: e.g. ['compact-2026-01-12'] — pass as anthropic-beta / SDK betas
}
interface GeminiPayload  { messages: Content[]; systemInstruction?: { parts: TextPart[] }; tools?; meta?: CompileMeta }
interface OpenAIResponsesPayload { instructions?: string; input: ResponseInputItem[]; tools?; meta?: CompileMeta }

interface CompileMeta {
  injectedMemoryKeys: string[];
  memoryExpiredKeys: string[];
  activeSkillName?: string;      // v4
}
```

## Memory tool schemas

When memory is configured, `compile()` auto-injects these tool definitions:

- **`create_memory`** — `{ key, value, description? }`; `key` becomes an enum when `allowedKeys` is configured.
- **`modify_memory`** — `{ action: 'update' | 'delete', key, value?, description? }`; only injected when entries exist; `key` is an enum of existing keys.

Intercept both in the agent loop and route to `chef.getMemory().createMemory(...)` / `updateMemory(...)` / `deleteMemory(...)`.

## Hook use cases

### `onBeforeCompile` — inject external context

Called after Janitor compression, before adapter formatting. Return a string to inject as `<implicit_context>` alongside dynamic state, or null to skip.

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const results = await vectorDB.search(ctx.dynamicStateXml);
    return results.length ? results.map(r => r.content).join("\n") : null;
  },
});

// BeforeCompileContext:
interface BeforeCompileContext {
  systemPrompt: readonly Message[];
  history: readonly Message[];      // post-compression
  dynamicState: readonly Message[];
  dynamicStateXml: string;          // useful as a search query
}
```

### `onBeforeCompress` — intervene before compression

Fires when the token budget is exceeded, BEFORE LLM compression. Return modified history to try a cheaper strategy first — the budget is re-evaluated on your result, and LLM compression only proceeds if still over.

```typescript
import { Janitor } from "@context-chef/core";
const compactJanitor = new Janitor({ contextWindow: Infinity });

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => summarize(msgs),
    toolResultStubThreshold: 5000, // trims big tool results inside the summarized span
    onBeforeCompress: (history, { currentTokens, limit }) => {
      // Zero-cost first pass: strip thinking blocks
      return compactJanitor.compact(history, { clear: ['thinking'] });
    },
  },
});
```

### `transformToolResult` — uniform tool-result rewrite (v4)

Runs at compile start, BEFORE compression; non-mutating.

```typescript
const chef = new ContextChef({
  vfs: { threshold: 5000 },
  transformToolResult: async (content, { toolName }) => {
    if (toolName === 'fetch_customer') return redactPII(content);
    return content.length > 5000 ? await chef.offloadAsync(content) : content;
  },
});
```

### `transformContext` — final message transform

Called after all assembly (system + skill + memory + history + dynamic state + guardrails), before adapter formatting.

```typescript
const chef = new ContextChef({
  transformContext: (messages) => messages.filter(m => m.content !== ''),
});
```

### `validateCompression` — trajectory-grounded summary gate (v4)

```typescript
janitor: {
  compressionModel: summarize,
  validateCompression: async (summary, { compressed, kept }) => {
    // e.g. require every pinned fact / active file path to appear in the summary
    return requiredFacts.every(f => summary.includes(f));
  },
}
```

### Memory hooks

```typescript
memory: {
  store: new VFSMemoryStore(".memory"),
  memoryPlacement: "before_history_tail",
  selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
  onMemoryUpdate: (key) => !key.startsWith("system_"),   // veto
  onMemoryChanged: (event) => console.log(`Memory ${event.type}: ${event.key}`),
  onMemoryExpired: (entry) => archiveService.save(entry.key, entry.value),
}
```

## Utilities

```typescript
estimate(text): number         // rough token estimate for a string
estimateObject(obj): number    // rough token estimate for any object (used internally for budgets)
objectToXml(obj, rootName?)    // object → XML (what setDynamicState uses under the hood)
ensureValidHistory(messages)   // drops orphan tool results / repairs pairing
Prompts                        // getCompactSummaryWrapper, getAnchoredCompactionInstruction,
                               // getArchiveCitation, formatCompactSummary, CONTEXT_COMPACTION_INSTRUCTION, ...
```

## Migrating from v3

These APIs were **removed** in v4 — replace on sight:

| Removed (v3) | v4 replacement |
|---|---|
| `TokenUtils` | `estimate` / `estimateObject` (exported directly) |
| `XmlGenerator` | `objectToXml` |
| `AdapterFactory` | `getAdapter` / `adapterRegistry` |
| `JanitorConfig.onBudgetExceeded` | `onBeforeCompress` (same signature) |

Behavior changes to flag when upgrading host code:
- Compression triggers at `contextWindow * 0.7` by default (`triggerRatio: 1` restores old behavior).
- Compression-model failure no longer truncates history with a placeholder — history is returned unchanged and counts toward the circuit breaker.
- `withGuardrails()` is stored and applied at compile() (pre-4.0: applied immediately and silently discarded by a later `setDynamicState`).
- Event handlers are error-isolated (pre-4.0: a throwing handler failed compile()).
