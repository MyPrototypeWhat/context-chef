# context-chef API Quick Reference (v4.2)

## Installation

```bash
npm install @context-chef/core zod
```

## Exports

All names below are verified against the 4.2 public barrel (`packages/core/src/index.ts`). Entries marked **(deprecated)** still work in 4.x and are removed in 5.0 — the "Deprecated in 4.2" table at the bottom lists the replacements.

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

  // Context store (4.2) — one substrate for memory / vfs / archive / notes
  Store,                 // namespace routing + context://<ns>/<path> addressing
  NamespaceView,         // one namespace of a Store (get/put/append/delete/list/search/uri)
  InMemoryBackend,       // ephemeral StorageBackend
  FileSystemBackend,     // on-disk StorageBackend, one root for every namespace
  fromMemoryStore,       // legacy MemoryStore  → StorageBackend  (= Store.fromMemoryStore)
  fromVfsAdapter,        // legacy VFSStorageAdapter → StorageBackend (= Store.fromVfsAdapter)
  StoreCapabilityError,  // thrown when a backend lacks an optional capability
  MEMORY_NAMESPACE, VFS_NAMESPACE, ARCHIVE_NAMESPACE, NOTES_NAMESPACE,

  // Memory stores — (deprecated), see the 4.2 table at the bottom
  InMemoryStore,         // (deprecated) → InMemoryBackend
  VFSMemoryStore,        // (deprecated) → FileSystemBackend
  FileSystemAdapter,     // (deprecated) → FileSystemBackend

  // Overflow — what leaves the window (4.2)
  summarize,             // regenerate the summary from the evicted span
  anchored,              // persistent anchor doc, merge only the newly evicted span
  server,                // Anthropic server-managed compaction, with a fallback
  reset,                 // keep pinned, evict the rest
  chain,                 // escalate when a strategy declines or is still over budget
  background,            // non-blocking wrapper with a staleness check
  resolveOverflowStrategy, // builds the strategy the deprecated janitor aliases describe
  isServerStrategy,
  renderSummaryMessage,  // the summary message a strategy result becomes
  renderHandoffNotice, validateHandoffConfig, HANDOFF_REMAINING_PLACEHOLDER,

  // Library-owned tools (4.2)
  getContextToolDefinition,   // the single `context` tool — static, frozen, cache-safe
  getNewContextToolDefinition,// `new_context` — no parameters
  dispatchContextTool,        // dispatcher for a host with no ContextChef
  isContextToolName, CONTEXT_TOOL_NAMES, CONTEXT_COMMANDS,
  resolveContextToolPolicy, canWrite, DEFAULT_WRITABLE_NAMESPACES,

  // Vocabulary (4.2) — the words the model reads, picked by `tools` mode
  resolveVocabulary, LEGACY_VOCABULARY, UNIFIED_VOCABULARY,

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
  getRecallToolDefinition, // (deprecated) recall_context tool def → use the `context` tool's `view`
  renderRecalledContent,   // archived span → readable transcript (what format: 'text' uses)

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
  Prompts,               // prompt constants + helpers. Legacy: getCompactSummaryWrapper,
                         // MEMORY_INSTRUCTION, getMemoryBlock, getVFSOffloadReminder.
                         // Unified (tools: 'unified'): CONTEXT_STORE_INSTRUCTION,
                         // CONTEXT_MEMORY_BLOCK_HEADER, getContextMemoryBlock,
                         // getContextOffloadReminder, getContextSummaryWrapper,
                         // CONTEXT_HANDOFF_NOTICE_TEMPLATE
  createJanitorPool,     // the Janitor-per-session pool the framework integrations use
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
  MemoryConfig, ChefMemoryConfig, MemoryEntry, MemorySetOptions, MemoryChangeEvent, TTLValue,
  MemoryPlacement, MemoryStore, MemoryStoreEntry, MemorySnapshot,   // MemoryStore: (deprecated)
  OffloadOptions, VFSConfig, VFSStorageAdapter, VFSResult, VFSEntryMeta,  // VFSStorageAdapter: (deprecated)
  VFSEvictionReason, VFSCleanupResult, CleanupOptions,
  StorageBackend, StoredEntry, StoredEntryMeta, ListedEntry, SearchHit,
  StoreOptions, NamespaceOptions, PutResult, EvictionPolicy, StoreCapability,
  OverflowStrategy, OverflowInput, OverflowResult, OverflowRunner, BudgetInfo,
  WindowLineage, HandoffConfig, SummarizeOptions, AnchoredOptions, ResetOptions,
  ServerOverflowStrategy, BackgroundOverflowStrategy, SplitMode,
  SlotName, SlotHandlers, BeforeAssembleContext, CompileContext, PhaseName, ToolsMode,
  ContextToolCall, ContextToolHost, ContextToolName, ContextToolPolicyConfig, ContextCommand,
  Vocabulary, VocabularyMode, SkillPlacement, Announcement, AnnouncementChannel,
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
  memory?: ChefMemoryConfig;            // MemoryConfig with `store` optional (4.2)

  /**
   * 4.2 — one storage substrate for every namespace: memory, vfs, archive, notes.
   * Fills in what nothing else specifies: an explicit memory.store wins for
   * memory, an explicit vfs.store / vfs.adapter / vfs.storageDir wins for the VFS.
   */
  store?: StorageBackend | Store;

  /**
   * 4.2 — which library-owned tools compile() emits.
   * - 'legacy' (default in 4.x): Memory's create_memory / modify_memory, and
   *   only when memory is configured.
   * - 'unified': one `context` tool over every namespace (+ new_context when
   *   overflow.handoff is set), emitted whether or not memory is configured.
   * The two sets never co-exist. The mode also picks the session's Vocabulary.
   * Becomes 'unified' in 5.0 — tool names are dispatch keys, so it cannot flip
   * in a minor.
   */
  tools?: ToolsMode;

  /** 4.2 — access policy for the `context` tool. Reading is always allowed. */
  contextTool?: { writable?: string[] };   // default ['memory', 'notes']

  /**
   * 4.2 — the overflow axis. `strategy` REPLACES janitor.compressionMode /
   * compressionScheduling and contextManagement; `archive` replaces
   * janitor.archive and applies to whatever any strategy evicts.
   */
  overflow?: {
    strategy?: OverflowStrategy;
    archive?: 'vfs' | CompressionArchiveConfig;
    handoff?: { budgetTokens: number; prompt?: string };  // {n_remaining} template
  };

  /** 4.1 — where the active skill's instructions land. Default 'after_system'. */
  skillPlacement?: 'after_system' | 'tail';

  /** 4.1 — audit Anthropic payloads for volatile content inside the cached prefix. */
  cacheAudit?: boolean;

  /**
   * 4.2 — dev-mode pipeline invariants: pinned survival + tool-pair integrity
   * after each after-assemble handler, pre-tail byte-identity after the tail
   * phase. Reported via logger.warn + the 'pipeline:invariant' event, never
   * thrown. Costs a snapshot + a serialization pass per compile. Default false.
   */
  pipelineChecks?: boolean;

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
   * (deprecated) Where history compression happens. 'server' builds
   * overflow.strategy = server(contextManagement.server, { fallback }); 'client'
   * is the default. Both fields are removed in 5.0.
   */
  contextManagement?: {
    strategy: 'client' | 'server';
    /** (deprecated) The first argument of server(). Default when omitted under
     *  'server': { edits: [{ type: 'compact_20260112' }] } */
    server?: unknown;
  };

  /** (deprecated) Registers on the `after-assemble` slot at construction. Use
   *  chef.use('after-assemble', fn). Removed in 5.0. */
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
   * (deprecated) Inject external context (RAG, AST, MCP) before compilation.
   * Return a string to inject as <implicit_context>, or null to skip.
   * Registers on the `before-assemble` slot at construction. Use
   * chef.use('before-assemble', (ctx) => ctx.inject(text)). Removed in 5.0.
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}
```

## Pipeline phases and slots (4.2)

`compile()` runs a fixed, ordered phase list; each phase lives in
`src/pipeline/phases/<name>.ts`:

```
start → transform-tool-results → handoff → overflow → inject → memory
      → skill → assemble → tail → adapt → audit → done
```

Slots are the public composition surface. `chef.use(slot, handler)` registers,
`chef.unuse(slot, handler)` removes one registration. Handlers run in
registration order and are awaited in sequence. Their errors are **not**
isolated — they propagate out of `compile()`, exactly like the config hooks they
generalize.

```typescript
interface SlotHandlers {
  'before-overflow': (ctx: { history: readonly Message[]; budget: BudgetInfo })
                     => void | false | Promise<void | false>;   // false = skip overflow this compile
  'after-overflow':  (ctx: { history: Message[]; result: OverflowResult | null }) => void | Promise<void>;
  'before-assemble': (ctx: BeforeCompileContext & { inject(text: string): void }) => void | Promise<void>;
  'after-assemble':  (messages: Message[]) => Message[] | Promise<Message[]>;   // handlers chain
  'before-adapt':    (messages: readonly Message[]) => void | Promise<void>;
  'after-adapt':     (payload: TargetPayload) => void | Promise<void>;
}
```

`ChefConfig.onBeforeCompile` → `before-assemble`; `ChefConfig.transformContext` →
`after-assemble`. Both register at construction, ahead of any later `use()` call,
and produce identical output. `transformToolResult` is per-message, not a slot,
and is not deprecated.

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
  'pipeline:invariant': { phase: PhaseName; message: string }; // 4.2, pipelineChecks only
  'memory:changed':     MemoryChangeEvent;
  'memory:expired':     MemoryEntry;
}
```

Intercept hooks (can modify data / veto) remain config callbacks: `onBeforeCompress` (JanitorConfig), `onMemoryUpdate` / `validateCompression` (MemoryConfig / JanitorConfig), `transformToolResult` (ChefConfig). `onBeforeCompile` / `transformContext` are **(deprecated)** — they now register on the `before-assemble` / `after-assemble` slots.

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

### Deprecated JanitorConfig fields (4.2)

`compressionMode`, `compressionScheduling` and `archive` describe the overflow
policy in the old vocabulary. They still build exactly the equivalent strategy
and are removed in 5.0:

| Deprecated | Replacement |
|---|---|
| `compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `compressionScheduling: 'background'` | `overflow.strategy: background(<strategy>)` |
| `archive` | `overflow.archive` |
| `JanitorSnapshot.anchorDoc` | `JanitorSnapshot.strategy` (opaque strategy state) |

The runner options stay on `janitor`: `contextWindow`, `tokenizer`,
`usagePreference`, `triggerRatio`, `logger`, `onCompress`, `onBeforeCompress`.
The summarizer tuning options (`compressionModel`, `compressionGuidelines`,
`customCompressionInstructions`, `minShrinkRatio`, `validateCompression`,
`preserveRecentMessages`, `preserveRatio`, `toolResultStubThreshold`) become
options of the default strategy — they are not deprecated, but an explicit
`overflow.strategy` supersedes them (setting both warns once).

## Overflow strategies (4.2)

```typescript
interface BudgetInfo { limit: number; current: number; trigger: number; remaining: number }

interface OverflowInput {
  history: Message[];               // post transform-tool-results
  budget: BudgetInfo;
  tokenizer: (m: Message[]) => number;
  pinned: readonly Message[];       // must survive verbatim (turn-scoped)
  window: WindowLineage;            // { first, previous?, current }
  forced?: boolean;                 // answering requestNewContext() / new_context
  signal?: AbortSignal;
}

interface OverflowResult {
  history: Message[];               // the new in-window history
  evicted: Message[];               // what left the window
  span?: Message[];                 // what the summary covers: evicted + re-inserted pinned
  summary?: string;                 // rendered summary text, if any
  meta: { strategy: string; windowId: string; changed: boolean; reason?: string };
}

interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  commit?(result: OverflowResult): void;   // only fires when a result lands
  pending?(): boolean;                     // a finished off-turn result is waiting to land
  attach?(runner: OverflowRunner): void;   // breaker + logger
  snapshot?(): unknown;
  restore?(state: unknown): void;
}
```

| Factory | What it does |
|---|---|
| `summarize(opts)` | LLM summary of the evicted span, regenerated each time |
| `anchored(opts)` | persistent anchor document; each compression merges only the newly evicted span. Anchor is keyed per window |
| `server(config, { fallback })` | Anthropic target → server-managed (`changed: false`, adapt attaches `context_management` + betas); every other target runs `fallback`, or declines with a reason when none is given |
| `reset(opts)` | keeps `pinned` and nothing else; everything else is evicted. Safe only with `archive` — documented, not enforced |
| `chain(...strategies)` | runs the next when the previous returned `changed: false` or is still over budget |
| `background(strategy)` | first over-budget compile returns unchanged and starts the job; a later compile swaps the result in if the compressed span is still a prefix of the current history |

The Janitor is the **runner**: budget evaluation, tokenizer / usage, circuit
breaker, `compress:*` events, archive, `onCompress` / `onBeforeCompress`, durable
compaction. It calls `strategy.apply()`. Failures of whatever strategy is
installed count toward the same 3-strike breaker.

**Window lineage**: the runner allocates a new window id on every overflow that
returns `changed: true`, at commit time — a stale background result never
advances it. `CompileMeta.windowId` is the window the payload belongs to;
lineage rides `JanitorSnapshot` / `ChefSnapshot` and restarts on `clearHistory()`.

**Handoff budget**: `overflow.handoff = { budgetTokens, prompt? }` reserves
headroom above the trigger. When `budget.remaining <= budgetTokens` and no notice
has been issued for the current window, one compile carries the rendered prompt
(`{n_remaining}` placeholder) through the tail channel. Never persisted, absent
from `getAnnouncements()`, skipped on server-managed compiles. Validated at
construction (positive budget, non-empty prompt, ≤ 2000 bytes).

**`new_context`**: `getNewContextToolDefinition()` is a static, parameterless
tool; dispatching it through `chef.handleTool` calls `chef.requestNewContext()`,
which makes the next compile apply the strategy regardless of budget. A
`before-overflow` veto and an open circuit breaker still win. The request is
consumed by one compile whether or not the window actually changed.

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
// 4.2 — one tool, one dispatcher
const chef = new ContextChef({ tools: 'unified', overflow: { archive: 'vfs' } });

for (const call of response.tool_calls ?? []) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: 'tool', tool_call_id: call.id, content });
    continue;
  }
  // ... the host's own tools
}
```

`chef.resolveRecall(uri, { format? })` is still the programmatic path and covers
both offloaded tool outputs (`chef.offload`) and archived compressed spans
(`overflow.archive`); `format: 'text'` renders an archived span as a readable
transcript instead of the stored `{ version, messages }` JSON.

`getRecallToolDefinition()` / the `recall_context` tool are **(deprecated)** —
the `context` tool's `view` on a `context://vfs/…` or `context://archive/…` path
does the same job and reaches every other namespace too. `handleTool` still
dispatches `recall_context` for hosts that already emit it.

## Context store (4.2)

One substrate for everything that lives outside the window: addressed content
plus metadata, in named namespaces, reachable as `context://<ns>/<path>`.

| Namespace | Holds | Auto-injected? |
|---|---|---|
| `memory` | durable facts worth carrying between conversations | yes, every compile |
| `notes` | the model's own working scratch space | no — read on demand |
| `vfs` | tool output too large to keep inline (`chef.offload`) | no |
| `archive` | spans of this conversation that were compacted away | no |

```typescript
interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}

interface StorageBackend {
  read(ns: string, path: string): StoredEntry | null | Promise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): void | Promise<void>;
  delete(ns: string, path: string): boolean | Promise<boolean>;
  list(ns: string, prefix?: string): ListedEntry[] | Promise<ListedEntry[]>;
  // Optional, capability-queried — a missing one throws StoreCapabilityError
  // only where it is actually required:
  readAll?(ns: string, prefix?: string): StoredEntries | Promise<StoredEntries>; // Map<string, StoredEntry> (backend order) | Record
  append?(ns: string, path: string, content: string): void | Promise<void>;
  search?(ns: string, query: string): SearchHit[] | Promise<SearchHit[]>;
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
  getPhysicalPath?(ns: string, path: string): string | null | Promise<string | null>;
}

class Store {
  constructor(backend: StorageBackend, options?: StoreOptions);
  namespace(ns: string, options?: NamespaceOptions): NamespaceView;
  static uri(ns: string, path: string): string;                       // context://<ns>/<path>
  static parseUri(uri: string): { ns: string; path: string } | null;
  static from(input: Store | StorageBackend, options?: StoreOptions): Store;
  static fromMemoryStore(legacy: MemoryStore): StorageBackend;        // (deprecated shim)
  static fromVfsAdapter(legacy: VFSStorageAdapter): StorageBackend;   // (deprecated shim)
}
```

`NamespaceView`: `get` / `put(path, content, meta)` / `put(content, meta)` →
auto-id / `append` / `delete` / `list` / `entries` / `search` / `uri` / `parseUri`.
Per-namespace eviction (`maxAge` / `maxFiles` / `maxBytes`, the old `VFSConfig`
caps) is a `Store` option now.

Built-in backends: `InMemoryBackend`, `FileSystemBackend(rootDir)`. Wiring:

```typescript
import { FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context-store"),  // memory + vfs + archive + notes
  memory: {},
});
await chef.getStore().namespace("notes").put("plan.md", "# Plan\n");
```

`ChefConfig.store` fills in only what nothing else specifies — an explicit
`memory.store`, `vfs.store`, `vfs.adapter` or `vfs.storageDir` still wins.
Legacy `MemoryStore` / `VFSStorageAdapter` implementations keep working through
the `from*` shims; both interfaces (and `InMemoryStore`, `VFSMemoryStore`,
`FileSystemAdapter`) are **(deprecated)**.

## The `context` tool (4.2)

`getContextToolDefinition()` returns one frozen, reference-stable definition —
`memory_20250818`-shaped, with exactly one enum (`command`), so no live state can
enter the cached prefix.

```typescript
{
  name: 'context',
  parameters: {
    command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename' | 'search',
    path: string,        // context://<ns>/<path> — the context:// prefix is optional;
                         // a trailing slash (or a bare namespace) is the directory
    file_text?: string;  // create
    old_str?, new_str?: string;   // str_replace — old_str must occur exactly once
    insert_line?: number; insert_text?: string;  // insert — 0-based line
    new_path?: string;   // rename, same namespace
    query?: string;      // search, scoped by `path`
    description?: string;// create under memory/ — what the entry is for
  }
}
```

Dispatch behavior per namespace:

- `memory/` routes through the Memory module, so `allowedKeys`, the
  `onMemoryUpdate` veto, `onMemoryChanged`, TTL and `updateCount` all apply.
  `create` on an existing key is an error; `rename` is create + delete.
- `notes/` goes straight to `store.namespace('notes')`: line-numbered `view`,
  single-occurrence `str_replace`, 0-based `insert`, and `search` with a
  list+get fallback when the backend has no `search` capability.
- `vfs/` and `archive/` are view-only by default and render through the recall
  path.

Access control is `ChefConfig.contextTool.writable` (default
`['memory', 'notes']`), enforced at dispatch, never in the store — your own code
writes wherever it likes. Model-facing mistakes come back as `Error: …` text the
model can read and correct; programmer errors throw.

```typescript
chef.ownsTool(name): boolean            // context, new_context, and the legacy trio
chef.handleTool(call): Promise<string>  // { name, arguments: string | object }
chef.getStore(): Store
```

Both are independent of `ChefConfig.tools`: the mode decides what `compile()`
**emits**, not what the dispatcher understands. Routing through them today is the
whole migration for 5.0, where `'unified'` becomes the default.

## MemoryConfig

```typescript
type MemoryPlacement = 'after_system' | 'before_history_tail';

interface MemoryConfig {
  /** 4.2: a Store, a raw StorageBackend (Memory owns its `memory` namespace),
   *  or a legacy MemoryStore (deprecated, wrapped with Store.fromMemoryStore).
   *  Optional on ChefConfig.memory — a shared ChefConfig.store supplies it. */
  store: MemoryStore | StorageBackend | Store;
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
  storageDir?: string;          // default '.context_vfs'
  uriScheme?: string;           // custom URI prefix
  store?: Store | StorageBackend;  // 4.2 — takes precedence over adapter/storageDir
  adapter?: VFSStorageAdapter;  // (deprecated) wrapped with Store.fromVfsAdapter
  maxAge?: number;              // ms since createdAt before cleanup eligibility
  maxFiles?: number;            // entry-count cap
  maxBytes?: number;            // total UTF-8 byte cap
  onVFSEvicted?: (entry: VFSEntryMeta, reason: VFSEvictionReason) => void | Promise<void>;
  logger?: ChefLogger;
}

// (deprecated) — implement StorageBackend instead (see "Context store" above)
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
| `clearHistory(): this` | Clear history and reset Janitor (circuit breaker, strategy state, window lineage). Announcements survive |
| `use(slot, handler): this` | 4.2: register a pipeline slot handler (see "Pipeline phases and slots") |
| `unuse(slot, handler): this` | 4.2: remove one registration of `handler` on `slot` |
| `announce(id, content, { channel? }): this` | 4.1: standing capability statement, rendered until retracted |
| `retractAnnouncement(id): boolean` / `getAnnouncements()` | 4.1 |

### Tool Management

| Method | Description |
|---|---|
| `registerTools(tools): this` | Register flat tools (simple mode) |
| `registerNamespaces(groups): this` | Register Layer 1 namespace tools (KV-cache stable) |
| `registerToolkits(groups): this` | Register Layer 2 lazy-loadable toolkits |
| `getPruner(): Pruner` | Direct access to the pruner |
| `checkToolCall({ name }): ToolCallCheckResult` | v4 dispatch-time gate against the Pruner blocklist. Call per LLM tool call BEFORE invoking: `chef.checkToolCall({ name: call.function.name })`. Returns `{ allowed: true }` or `{ allowed: false, reason }` (surface `reason` back as the tool result). Missing/empty name is rejected. Emits `'pruner:tool-blocked'`. |
| `ownsTool(name): boolean` | 4.2: is this a library-owned tool (`context`, `new_context`, `create_memory`, `modify_memory`, `recall_context`)? Independent of `tools` mode |
| `handleTool(call): Promise<string>` | 4.2: run one library tool call and return the text to hand back as the tool result. `arguments` may be a JSON string or a parsed object. Throws only for an unowned name |

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

**Direct methods** (developer use — bypass validation hooks): `set(key, value, options?)`, `get(key)`, `getEntry(key)`, `getAll()`, `delete(key)`. `getAll()` is one bulk read and preserves the store's own key order, which is the order entries reach the `<memory>` block — same as 4.1.

**Compile-path** (v4): `compileArtifacts()` performs the single store read per compile (sweep expired → selector once → XML + tool defs from the same read); `toXml(entries?)` and `getToolDefinitions(existingKeys?)` accept pre-fetched data.

### VFS / Offloading

| Method | Description |
|---|---|
| `getStore(): Store` | 4.2: the context store every namespace is addressed through |
| `requestNewContext(): this` | 4.2: next compile applies the overflow strategy regardless of budget (consumed by one compile) |
| `offload(content, options?): string` | Sync truncation with VFS pointer (throws on async adapters) |
| `offloadAsync(content, options?): Promise<string>` | Async version |
| `resolveRecall(uri, { format? }): Promise<string \| null>` | Full stored content behind a `context://vfs/` URI (offloaded output or archived span). 4.2: `format: 'text'` renders an archived span as a readable transcript |
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
| `snapshot(label?): ChefSnapshot` | Full state: history, dynamic state, guardrail options, janitor (incl. anchor doc + breaker), memory, pruner, active skill name + instructions, and `handoffNoticedWindow` (the window the handoff notice was already issued for) |
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
  windowId?: string;             // 4.2: the window this payload belongs to
}
```

## Library-owned tool schemas

What `compile()` puts in `payload.tools` depends on `ChefConfig.tools`.

**`tools: 'legacy'`** (default in 4.x) — only when memory is configured:

- **`create_memory`** — `{ key, value, description? }`; `key` becomes an enum when `allowedKeys` is configured.
- **`modify_memory`** — `{ action: 'update' | 'delete', key, value?, description? }`; static since 4.1 (no enum of live keys — the visible key list rides the injected memory block instead).

**`tools: 'unified'`** — always, memory or not:

- **`context`** — the seven-command tool over `context://<ns>/<path>` (see "The `context` tool" above).
- **`new_context`** — no parameters; emitted only when `overflow.handoff` is set.

Route both sets the same way: `if (chef.ownsTool(name)) await chef.handleTool(call)`.
`Memory.getToolDefinitions()` is **(deprecated)** — a `memory/` write through the
`context` tool runs the same validation, veto and TTL path.

## Hook use cases

### `onBeforeCompile` — inject external context (deprecated → `before-assemble`)

Called after Janitor compression, before adapter formatting. Return a string to inject as `<implicit_context>` alongside dynamic state, or null to skip.

```typescript
// 4.2 — the slot form. Any number of handlers, each may inject.
chef.use("before-assemble", async (ctx) => {
  const results = await vectorDB.search(ctx.dynamicStateXml);
  if (results.length) ctx.inject(results.map(r => r.content).join("\n"));
});

// (deprecated) the config form, registered on the same slot at construction:
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const results = await vectorDB.search(ctx.dynamicStateXml);
    return results.length ? results.map(r => r.content).join("\n") : null;
  },
});

// BeforeCompileContext (a `before-assemble` handler also gets `inject(text)`):
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
    compressionModel: async (msgs) => summarizeWithCheapModel(msgs),
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

### `transformContext` — final message transform (deprecated → `after-assemble`)

Called after all assembly (system + skill + memory + history + dynamic state + guardrails), before adapter formatting.

```typescript
// 4.2 — the slot form. Handlers chain: each receives the previous result.
chef.use("after-assemble", (messages) => messages.filter(m => m.content !== ''));

// (deprecated) the config form, registered on the same slot at construction:
const chef = new ContextChef({
  transformContext: (messages) => messages.filter(m => m.content !== ''),
});
```

### `validateCompression` — trajectory-grounded summary gate (v4)

```typescript
janitor: {
  compressionModel: summarizeWithCheapModel,
  validateCompression: async (summary, { compressed, kept }) => {
    // e.g. require every pinned fact / active file path to appear in the summary
    return requiredFacts.every(f => summary.includes(f));
  },
}
```

### Memory hooks

```typescript
memory: {
  // store is optional — a shared ChefConfig.store (e.g. new FileSystemBackend('.context-store'))
  // supplies it. An explicit one still wins.
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
                               // 4.2 unified set (tools: 'unified'): CONTEXT_STORE_INSTRUCTION,
                               // CONTEXT_MEMORY_BLOCK_HEADER, getContextMemoryBlock,
                               // getContextOffloadReminder, getContextSummaryWrapper,
                               // CONTEXT_HANDOFF_NOTICE_TEMPLATE
createTokenizerAdapter(encode) // any (text) => tokens encoder → a correct JanitorConfig.tokenizer
resolveVocabulary(mode)        // 4.2: LEGACY_VOCABULARY | UNIFIED_VOCABULARY
```

## Deprecated in 4.2 (removed in 5.0)

Everything here still works in 4.x. Generate the replacement in new code; see
`MIGRATION-5.md` in the repo for the full story and the 5.0 flip list.

| Deprecated | Replacement |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(<strategy>)` |
| `janitor.archive` | `overflow.archive` |
| `contextManagement.strategy` / `.server` | `overflow.strategy: server(config, { fallback })` |
| `JanitorSnapshot.anchorDoc` | `JanitorSnapshot.strategy` |
| `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', (ctx) => ctx.inject(text))` |
| `ChefConfig.transformContext` | `chef.use('after-assemble', (messages) => messages)` |
| `MemoryStore` (and `memory.store` taking one) | `StorageBackend` / `Store` |
| `VFSStorageAdapter` (and `vfs.adapter`) | `StorageBackend` as `vfs.store`, or one `ChefConfig.store` |
| `InMemoryStore` | `InMemoryBackend` |
| `VFSMemoryStore` / `FileSystemAdapter` | `FileSystemBackend` |
| `Memory.getToolDefinitions()` | `tools: 'unified'` — `compile()` emits the `context` tool |
| `create_memory` / `modify_memory` calls | the `context` tool via `chef.handleTool(call)` |
| `getRecallToolDefinition()` / `recall_context` | the `context` tool's `view` |
| middleware `truncate.storage` | `truncate.store` |

**The one default that flips in 5.0**: `ChefConfig.tools` goes to `'unified'`, so
`payload.tools` carries `context` where it used to carry the memory trio (and
carries it even with no memory configured). Tool names are dispatch keys, so a
loop branching on `'create_memory'` stops matching. Routing through
`chef.ownsTool` / `chef.handleTool` today makes the flip a no-op.

## Migrating from v3 (removed APIs)

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
