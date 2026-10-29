# context-chef API Quick Reference (4.3)

## Installation

```bash
npm install @context-chef/core zod
```

Entries marked **(deprecated)** still work in 4.x and are removed in 5.0. See the table at the bottom, and `MIGRATION-5.md` in the repo.

## Exports

```typescript
import {
  ContextChef,          // Main class

  // Modules (standalone use)
  Janitor,              // compact() + compress() + snapshot/restore
  Memory, Offloader, Pruner, Guardrail, Assembler,

  // Context store (4.2) — one substrate for memory / vfs / archive / notes
  Store, NamespaceView,
  InMemoryBackend,      // ephemeral StorageBackend
  FileSystemBackend,    // on-disk StorageBackend, one root for every namespace
  MEMORY_NAMESPACE, NOTES_NAMESPACE, VFS_NAMESPACE, ARCHIVE_NAMESPACE,
  InMemoryStore,        // (deprecated) → InMemoryBackend
  VFSMemoryStore,       // (deprecated) → FileSystemBackend
  FileSystemAdapter,    // (deprecated) → FileSystemBackend

  // Overflow (4.2) — what leaves the window
  summarize, anchored, server, reset, chain, background,
  onDemandCompaction,   // 4.3: Anthropic-signed compaction; needs appendOnly
  renderSummaryMessage, renderHandoffNotice, validateHandoffConfig,

  // Append-only prefix (4.3)
  checkPrefixContinuity,      // first place a payload stops repeating the previous one
  anthropicCompactionMessage, // the history message that replays a signed compaction block
  createPrefixSessionPool,    // appendOnly sessions for framework integrations

  // Library-owned tools (4.2)
  getContextToolDefinition,      // the single `context` tool — static, frozen, cache-safe
  getNewContextToolDefinition,   // `new_context` — no parameters
  dispatchContextTool,           // dispatcher for a host with no ContextChef
  getRecallToolDefinition,       // (deprecated) → the `context` tool's `view`

  // Skills
  loadSkill, loadSkillsDir, loadSkillsDirs, renderSkill, formatSkillListing,

  // Adapters
  getAdapter, adapterRegistry,
  fromOpenAI, fromAnthropic, fromGemini, fromOpenAIResponses,

  // Compression primitives
  summarizeHistory,     // stateless summarization primitive
  planCompaction, compactHistory,  // durable compaction for caller-owned stores
  compactMessages, flattenForCompression, groupIntoTurns,

  // Utilities
  estimate, estimateObject,   // heuristic token estimates
  objectToXml,                // what setDynamicState uses
  ensureValidHistory,         // drops orphan tool results
  createTokenizerAdapter,     // (text) => tokens encoder → JanitorConfig.tokenizer
  SessionPool,                // keyed chef instances for multi-session hosts
  Prompts,
} from "@context-chef/core";
```

## ChefConfig

```typescript
interface ChefConfig {
  janitor?: JanitorConfig;
  memory?: ChefMemoryConfig;          // MemoryConfig with `store` optional
  pruner?: { strategy?: 'union' | 'intersection' };
  vfs?: Partial<VFSConfig>;

  /** 4.2 — one storage substrate for memory / vfs / archive / notes. Fills in
   *  what nothing else specifies (an explicit memory.store or vfs.store wins). */
  store?: StorageBackend | Store;

  /** 4.2 — which library-owned tools compile() emits.
   *  'legacy' (default in 4.x): create_memory / modify_memory, memory only.
   *  'unified': one `context` tool (+ new_context when overflow.handoff is set),
   *  emitted whether or not memory is configured. Becomes the default in 5.0. */
  tools?: 'legacy' | 'unified';

  /** 4.2 — access policy for the `context` tool. Reading is always allowed. */
  contextTool?: { writable?: string[] };     // default ['memory', 'notes']

  /** 4.2 — the overflow axis. */
  overflow?: {
    strategy?: OverflowStrategy;             // summarize / anchored / server / reset / chain / background
    archive?: 'vfs' | { store(serialized: string, meta: { messageCount: number }): string | Promise<string> };
    handoff?: { budgetTokens: number; prompt?: string };   // {n_remaining} template
  };

  /** 4.1 — where the active skill's instructions land. Default 'after_system'. */
  skillPlacement?: 'after_system' | 'tail';
  /** 4.1 — audit Anthropic payloads for volatile content in the cached prefix. */
  cacheAudit?: boolean;
  /** 4.2 — dev-mode pipeline invariants; reported, never thrown. Default false.
   *  4.3: with appendOnly, also checks each payload repeats the one sent before it. */
  pipelineChecks?: boolean;

  /** 4.3 — keep what was sent as the prefix of the next payload. Injections become
   *  events appended once; a compaction lands once; every rewrite is a checkpoint
   *  reported through `prefix:break` and `meta.prefix`. `true` = `{}`. Off by default
   *  (off, it changes nothing). Changes defaults only: unset skillPlacement → 'tail',
   *  unset memoryPlacement → 'before_history_tail', unset guardrail prefillMode →
   *  'instruction' on targets without native prefill. A chef created per request must
   *  save snapshot() after each compile and after the request's tool calls, and restore
   *  it on the next request, or every request is a `ledger` checkpoint. With memory in a
   *  shared store, restore { ...saved, modules: { ...saved.modules, memory: null } }.
   *  Either way, set the system prompt, tools and state after restore(), which replaces
   *  them with the saved ones. */
  appendOnly?: boolean | { clearAt?: boolean };   // AppendOnlyConfig; clearAt: Anthropic turn-scoped reminders

  defaultTarget?: TargetProvider | ITargetAdapter;   // options.target → this → 'openai'
  logger?: ChefLogger;                               // { warn(message, ...args): void }

  /** Uniform tool-result rewrite, applied to every role:'tool' message at the
   *  START of compile() — before compression. Not deprecated (per-message, not a slot). */
  transformToolResult?: (
    content: string,
    info: { toolName: string | null; toolCallId: string | null },
  ) => string | Promise<string>;

  /** (deprecated) registers on the `before-assemble` slot → chef.use(...) */
  onBeforeCompile?: (ctx: BeforeCompileContext) => string | null | Promise<string | null>;
  /** (deprecated) registers on the `after-assemble` slot → chef.use(...) */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  /** (deprecated) → overflow.strategy: server(contextManagement.server, { fallback }) */
  contextManagement?: { strategy: 'client' | 'server'; server?: unknown };
}
```

## JanitorConfig

The Janitor is the **runner**: budget evaluation, tokenizer / usage, circuit breaker, `compress:*` events, archive, durable compaction. It calls `strategy.apply()`.

```typescript
interface JanitorConfig {
  contextWindow: number;                       // Required. Model's context window in tokens
  triggerRatio?: number;                       // default 0.7 — compress at 70% ("pre-rot")
  tokenizer?: (msgs: Message[]) => number;     // enables the tokenizer path
  preserveRatio?: number;                      // tokenizer path, default 0.8 of the effective budget
  preserveRecentMessages?: number;             // reportTokenUsage path, counts TURNS
  usagePreference?: 'max' | 'feedFirst' | 'tokenizerFirst';

  // Summarizer tuning — options of the default strategy. An explicit
  // overflow.strategy supersedes them (setting both warns once).
  compressionModel?: (msgs: Message[]) => Promise<string>;
  compressionGuidelines?: string[];
  customCompressionInstructions?: string;
  minShrinkRatio?: number;                     // default 0.5 on spans >= 2000 chars
  validateCompression?: (summary: string, info: { compressed: Message[]; kept: Message[] }) => boolean | Promise<boolean>;
  toolResultStubThreshold?: number;

  onCompress?: (summaryMessage: Message, truncatedCount: number, details: CompressionDetails) => void | Promise<void>;
  // CompressionDetails = { compressedMessages: Message[]; replacement?: Message[] }
  // replacement (4.3, appendOnly only): what to write back, in order, in place of the
  // first truncatedCount messages to persist the compaction. Counts exclude the chef's events.
  // Slicing by the count assumes every earlier replacement was written back; after a missed
  // write-back (or when persisting starts mid-conversation) keep the full history instead.
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
  logger?: ChefLogger;

  strategy?: OverflowStrategy;                 // 4.2, standalone Janitor
  compressionMode?: 'rewrite' | 'incremental-anchored';   // (deprecated)
  compressionScheduling?: 'blocking' | 'background';      // (deprecated)
  archive?: 'vfs' | CompressionArchiveConfig;             // (deprecated) → overflow.archive
}
```

Failure semantics: a model throw, a shrink-guard trip or a `validateCompression` rejection leaves history **unchanged** and increments the circuit breaker (3 strikes → `compress()` no-ops until a success or `clearHistory()`).

## Overflow strategies (4.2)

```typescript
interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  commit?(result: OverflowResult): void;   // fires only when a result lands
  pending?(): boolean;                     // a finished off-turn result is waiting to land
  discard?(): void;                        // 4.3: drop that result unlanded, counting nothing
  attach?(runner: OverflowRunner): void;
  snapshot?(): unknown;
  restore?(state: unknown): void;
  readonly signed?: true;                  // 4.3: the provider signs what it returns (onDemandCompaction)
}
// OverflowInput  = { history, budget, tokenizer, pinned, window, forced?, signal?,
//                    pendingOnly?,        // 4.3: called only to land a finished result
//                    appendOnly?, midToolTurn?, collapse?, pastLimit?, wire? }   // 4.3, appendOnly
// OverflowResult = { history, evicted, span, summary?,
//                    meta: { strategy, windowId, changed, reason?, partial?, signed? } }
// OverflowWire (4.3) = { target, history, renderPrefix(end) }: the window as it was sent
// Both are required. `evicted` left the window; `span` is what the summary covers
// (evicted + re-inserted pinned turns); a no-op result declares both empty. onCompress,
// the archive payload and the citation count all read `span`.
```

| Factory | What it does |
|---|---|
| `summarize(opts)` | LLM summary of the evicted span, regenerated each time |
| `anchored(opts)` | persistent anchor document; merges only the newly evicted span. Keyed per window |
| `server(config, { fallback })` | Anthropic → server-managed (payload carries `context_management` + `betas`); other targets run `fallback` |
| `reset(opts)` | keeps `pinned` and nothing else. Safe only with `archive` |
| `chain(...s)` | escalates when a strategy returned `changed: false` or is still over budget |
| `background(s)` | first over-budget compile returns unchanged, a later one swaps the finished result in if the span is still a prefix |
| `onDemandCompaction({ compact, keepRecentTurns?, instructions?, fallback? })` | 4.3, `appendOnly` on Anthropic: the request already answered goes back with `compaction: { type: 'summarize' }` (beta `compact-2026-09-04`) and the signed block replaces it; kept turns keep their thinking. `compact(request, signal)` sends `OnDemandCompactionRequest = { payload, compaction, betas }` and returns `{ stop_reason, content }`. Give a `fallback`: it runs wherever nothing can be signed. Compose as `onDemandCompaction({ fallback })`, not `chain()`. Warns with `server()` |

`archive` is strategy-agnostic: the span a strategy compressed is stored (pinned turns it re-inserted included) and the URI is cited in the summary. `handoff` reserves headroom above the trigger and delivers one tail notice per window telling the model to write state into `memory/` / `notes/` first. `getNewContextToolDefinition()` + `chef.requestNewContext()` let the model close a window deliberately.

## Pipeline slots (4.2)

`chef.use(slot, handler)` / `chef.unuse(slot, handler)`. Handlers run in registration order, awaited in sequence, errors **not** isolated.

```typescript
'before-overflow': ({ history, budget }) => void | false   // false = skip overflow this compile
'after-overflow':  ({ history, result }) => void           // result null when skipped
'before-assemble': (ctx) => void                           // ctx.inject(text) → <implicit_context>
'after-assemble':  (messages) => Message[]                 // handlers chain
'before-adapt':    (messages) => void
'after-adapt':     (payload) => void
```

## Context store (4.2)

| Namespace | Holds | Auto-injected? |
|---|---|---|
| `memory` | durable facts across conversations | yes, every compile |
| `notes` | the model's own scratch space | no — read on demand |
| `vfs` | tool output too large to keep inline | no |
| `archive` | compacted spans of this conversation | no |

```typescript
interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}

interface StorageBackend {
  read(ns, path): StoredEntry | null | Promise<StoredEntry | null>;
  write(ns, path, entry): void | Promise<void>;
  delete(ns, path): boolean | Promise<boolean>;
  list(ns, prefix?): ListedEntry[] | Promise<ListedEntry[]>;
  // Optional, capability-queried:
  readAll?(ns, prefix?): StoredEntries;   // Map<string, StoredEntry>, backend key order
  append?(ns, path, content); search?(ns, query);
  snapshot?(ns); restore?(ns, data); getPhysicalPath?(ns, path);
}
```

`Store.namespace(ns)` → `NamespaceView`: `get` / `put(path, content, meta)` / `put(content, meta)` → auto-id / `append` / `delete` / `list` / `entries` / `search` / `uri`. `Store.uri(ns, path)` builds `context://<ns>/<path>`; `Store.parseUri` splits one. Per-namespace eviction (`maxAge` / `maxFiles` / `maxBytes`) is a `Store` option.

## The `context` tool (4.2)

```typescript
{
  name: 'context',
  parameters: {
    command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename' | 'search',
    path: string,          // context://<ns>/<path>; the prefix is optional, a trailing slash is a directory
    file_text?, old_str?, new_str?, insert_line?, insert_text?, new_path?, query?, description?
  }
}
```

- `memory/` routes through the Memory module (`allowedKeys`, `onMemoryUpdate` veto, `onMemoryChanged`, TTL, `updateCount` all apply).
- `notes/` goes straight to the store: line-numbered `view`, single-occurrence `str_replace`, 0-based `insert`, `search` with a list+get fallback.
- `vfs/` and `archive/` are view-only by default and render through the recall path.

Model-facing mistakes come back as `Error: …` text; programmer errors throw.

```typescript
chef.ownsTool(name): boolean            // context, new_context, and the legacy trio
chef.handleTool(call): Promise<string>  // { name, arguments: string | object }
chef.getStore(): Store
```

Both are independent of `tools` mode — the mode decides what `compile()` emits, not what the dispatcher understands.

## MemoryConfig

```typescript
interface MemoryConfig {
  /** A Store, a raw StorageBackend, or a legacy MemoryStore (deprecated).
   *  Optional on ChefConfig.memory — a shared ChefConfig.store supplies it. */
  store: MemoryStore | StorageBackend | Store;
  defaultTTL?: TTLValue;                  // bare number = turns
  allowedKeys?: string[];
  memoryPlacement?: 'after_system' | 'before_history_tail';  // default 'after_system'
  selector?: (entries: MemoryEntry[]) => MemoryEntry[];      // runs once per compile
  onMemoryUpdate?: (key: string, value: string | null, oldValue: string | null) => boolean | Promise<boolean>;
  onMemoryChanged?: (event: MemoryChangeEvent) => void | Promise<void>;
  onMemoryExpired?: (entry: MemoryEntry) => void | Promise<void>;
}

type TTLValue = number | { ms: number } | { turns: number };   // bare number = turns
```

`memoryPlacement: 'before_history_tail'` keeps the volatile `<memory>` block out of the top-level system parameter on Anthropic/Gemini, so cache breakpoints earlier in the stream survive memory mutations.

## Message type

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  pinned?: boolean;                 // survives compression verbatim (turn-scoped)
  attachments?: Attachment[];       // provider-neutral media IR
  _cache_breakpoint?: boolean;      // Anthropic prompt caching
  _positional?: boolean;            // 4.1: a system message that stays in place
  thinking?: ThinkingContent;
  redacted_thinking?: RedactedThinking;
  _clear_at?: 'next_user_message';  // 4.3: turn-scoped positional system message (Anthropic)
  _chef_event?: true;               // 4.3: set by the chef on its appendOnly events, never by you
}
```

## ContextChef methods

### Context building

| Method | Description |
|---|---|
| `setSystemPrompt(messages): this` | Static system prompt (cached prefix) |
| `setHistory(messages): this` | Conversation history |
| `setDynamicState(schema, data, { placement? }): this` | Zod-validated state as XML (`'last_user'` default / `'system'`) |
| `withGuardrails(options \| null): this` | Stored and applied at compile(); replace semantics; `null` clears. Options: `enforceXML?: { outputTag }`, `prefill?`, `prefillMode?: 'native' \| 'instruction'` (default `'native'`: trailing assistant message; `'instruction'`: no trailing assistant message on any target, the prefill travels as an instruction, delivered per `placement` — see the adapter table below), `placement?: 'system' \| 'last_user'` |
| `clearHistory(): this` | Clear history, reset Janitor (breaker, strategy state, window lineage). Announcements survive |
| `use(slot, handler)` / `unuse(slot, handler)` | 4.2: pipeline slots |
| `announce(id, content, { channel? })` / `retractAnnouncement(id)` / `getAnnouncements()` | 4.1: standing capability statements |

### Tools

| Method | Description |
|---|---|
| `registerTools(tools): this` | Flat tools (simple mode) |
| `registerNamespaces(groups): this` | Layer 1 namespace tools (cache-stable) |
| `registerToolkits(groups): this` | Layer 2 lazy-loadable toolkits |
| `checkToolCall({ name }): ToolCallCheckResult` | Dispatch-time gate against the Pruner blocklist. `{ allowed: false, reason }` → push `reason` back as the tool result |
| `ownsTool(name): boolean` | 4.2: is this a library-owned tool? |
| `handleTool(call): Promise<string>` | 4.2: run it, return the tool-result text |
| `getPruner(): Pruner` | `pruneByTask` / `allowOnly` / `setBlockedTools` / `compile` / `isNamespaceCall` / `resolveNamespace` / `isToolkitLoader` / `extractToolkit` |

### Memory / store / VFS

| Method | Description |
|---|---|
| `getMemory(): Memory` | `createMemory` / `updateMemory` / `deleteMemory` / `set` / `get` |
| `getStore(): Store` | 4.2: the context store every namespace is addressed through |
| `offload(content, options?)` / `offloadAsync(...)` | Truncate with a `context://vfs/` pointer. `{ threshold?, headChars?, tailChars? }` |
| `resolveRecall(uri, { format? })` | Full stored content; `format: 'text'` renders an archived span as a transcript |
| `getOffloader(): Offloader` | `cleanup()` / `reconcileAsync()` / `resolve(uri)` |

### Skills, compilation, snapshots

| Method | Description |
|---|---|
| `registerSkills(skills)` / `activateSkill(name \| skill \| null)` / `getActiveSkill()` | Skill module |
| `compile({ target })` | `'openai'` / `'openai-responses'` / `'anthropic'` / `'gemini'` / a registered name / an adapter instance |
| `reportTokenUsage(count): this` | Feed the API-reported token count |
| `requestNewContext(): this` | 4.2: next compile applies the overflow strategy regardless of budget |
| `snapshot(label?)` / `restore(snapshot)` | Full state capture and rollback. 4.3: with `appendOnly` the snapshot carries `prefixLedger` and `modelMemoryWrites` |
| `on(event, handler)` / `off(event, handler)` | `compile:start` / `compile:done` / `compress:start` / `compress:end` / `compress` / `offload:created` / `pruner:tool-blocked` / `pipeline:invariant` / `memory:changed` / `memory:expired` / `prefix:break` (4.3: `{ reason, at, signed, strippedThinking, windowId? }`). Error-isolated |

## Payload types

```typescript
OpenAIPayload           { messages, tools?, meta? }
AnthropicPayload        { system?, messages, tools?, meta?, context_management?, betas? }
GeminiPayload           { messages, systemInstruction?, tools?, meta? }
OpenAIResponsesPayload  { instructions?, input, tools?, meta? }

CompileMeta { injectedMemoryKeys: string[]; memoryExpiredKeys: string[];
              activeSkillName?: string; windowId?: string;
              prefix?: PrefixMeta }   // 4.3, appendOnly only

PrefixMeta { stable: number;          // window messages identical to the previous payload's
             break?: { reason: 'compaction' | 'history' | 'system' | 'tools' | 'ledger';
                       at: number; signed: boolean; strippedThinking: number } }
```

`AnthropicPayload.betas` also carries `mid-conversation-system-clear-at-2026-08-21` when a message is turn-scoped, and `compact-2026-09-04` when `appendOnly` replays a signed on-demand compaction block.

## Provider adapter behavior

| Feature | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| System messages | Kept inline | Separated to `system` (except `_positional`) | Separated to `systemInstruction` |
| Cache breakpoints | Stripped | `cache_control: { type: 'ephemeral' }` | Stripped |
| Prefill (trailing assistant) | Degraded to an instruction in the last user message | Native; models that reject it (Sonnet 4.6 / 5 / 5.5, Haiku 5.5) need `prefillMode: 'instruction'` | Degraded to `[System Note]` |
| Thinking blocks | Dropped, or `<thinking>` text with `preserveThinkingAsText` | Mapped to `ThinkingBlockParam`; not sent without a signature | Dropped, or `<thinking>` text |
| Tool calls format | `tool_calls` array | `tool_use` content blocks | `functionCall` parts (+ `thoughtSignature` echo) |

History parsed with `fromAnthropic` is replayed to the Anthropic target byte-for-byte while unmodified (origin kept in `Message._anthropic_origin`): Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 sign each thinking block over every earlier turn, and accounts created on or after 2026-08-31 get a 400 when one differs. A modified message is rebuilt from IR fields; the original's `cache_control` markers give way to the chef's breakpoints. 4.3: `fromAnthropic(messages, system, { keepPositionalSystem: true })` keeps mid-conversation system messages in place (`FromAnthropicOptions`); under `appendOnly`, a message whose thinking a checkpoint stripped keeps its other blocks verbatim. A custom adapter that turns a prefill into an instruction sets `ITargetAdapter.nativePrefill = false`. `auditAnthropicCachePlacement(payload, { appendOnly })` (`CacheAuditOptions`) audits only the system prompt under appendOnly.

## Append-only prefix (4.3)

`appendOnly` is opt-in and changes nothing when off. Guide: https://myprototypewhat.github.io/context-chef/guide/append-only

```typescript
const chef = new ContextChef({
  appendOnly: true,
  janitor: { contextWindow: 200_000 },
  overflow: {
    strategy: onDemandCompaction({
      compact: ({ payload, compaction, betas }, signal) =>
        client.beta.messages.create({ ...payload, model, max_tokens, thinking, compaction, betas }, { signal }),
      fallback: summarize({ compressionModel }),
    }),
  },
});
chef.on('prefix:break', ({ reason, at, strippedThinking }) => { /* a checkpoint */ });
```

| Name | What it is |
|---|---|
| `AppendOnlyConfig` | `{ clearAt?: boolean }` — Anthropic: system-channel sources become turn-scoped reminders |
| `PrefixMeta` / `PrefixBreakReason` | `CompileMeta.prefix` and its `break.reason` |
| `ChefEvents['prefix:break']` | a checkpoint this compile applied |
| `ChefSnapshot.prefixLedger` (`PrefixLedgerSnapshot`) / `modelMemoryWrites` | a chef created per request saves its snapshot after each compile and after the request's tool calls, and restores it on the next request; with memory in a shared store, without its memory part: `chef.restore({ ...saved, modules: { ...saved.modules, memory: null } })`. Register skills before `restore()`; set the system prompt, tools and state after it |
| `onDemandCompaction` + `OnDemandCompactionOptions` / `OnDemandCompactionRequest` / `OnDemandCompactor` | signed compaction (table above) |
| `anthropicCompactionMessage(block)` / `AnthropicCompactionBlock` | the history message that replays a signed compaction block |
| `OverflowWire`, `OverflowStrategy.discard?()`, `OverflowInput.{pendingOnly, appendOnly, midToolTurn, collapse, pastLimit, wire}` | for custom strategies (see above) |
| `CompressionDetails.replacement` | what to write back to persist a compaction |
| `createPrefixSessionPool`, `PrefixSession` (type), `PrefixSessionBreak`, `PrefixSessionCall`, `PrefixSessionPoolConfig`, `PrefixSessionWindow`, `SignedThinking` | the session helper both framework integrations build on |

Integrations: `@context-chef/ai-sdk-middleware` and `@context-chef/tanstack-ai` take `appendOnly?: boolean | { clearAt?: boolean }` (`clearAt` ignored there) and `onPrefixBreak?: (event: PrefixBreakEvent) => void`, where `PrefixBreakEvent` adds `sessionId`. Pass a `sessionId` (AI SDK `providerOptions.contextChef.sessionId`) or `threadId` (TanStack) per conversation, and create the middleware once. Their durable helpers (`compactModelMessages` / `planCompactionModelMessages`, `compactTanStackMessages` / `planCompactionTanStackMessages`) take `keptReasoning?: 'keep' | 'strip'` (`KeptReasoningOptions`).

## Deprecated in 4.2 (removed in 5.0)

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
| `MemoryStore` / `VFSStorageAdapter` (and `vfs.adapter`) | `StorageBackend` / `Store` |
| `InMemoryStore` | `InMemoryBackend` |
| `VFSMemoryStore` / `FileSystemAdapter` | `FileSystemBackend` |
| `Memory.getToolDefinitions()` | `tools: 'unified'` — `compile()` emits the `context` tool |
| `create_memory` / `modify_memory` calls | the `context` tool via `chef.handleTool(call)` |
| `getRecallToolDefinition()` / `recall_context` | the `context` tool's `view` |

**The one default that flips in 5.0**: `ChefConfig.tools` goes to `'unified'`, so `payload.tools` carries `context` where it used to carry the memory trio (and carries it even with no memory configured). Tool names are dispatch keys, so a loop branching on `'create_memory'` stops matching. Routing through `chef.ownsTool` / `chef.handleTool` today makes the flip a no-op.

Also removed in v4 (replace on sight): `TokenUtils` → `estimate` / `estimateObject`; `XmlGenerator` → `objectToXml`; `AdapterFactory` → `getAdapter` / `adapterRegistry`; `JanitorConfig.onBudgetExceeded` → `onBeforeCompress`.
