# ContextChef architecture v5 — the five-axis model

> Status: **contract** for the 4.2 → 5.0 refactor. Every phase below is implemented
> against this document. If code and this document disagree, fix one of them in the
> same PR — never let them drift.

## 0. First principles

ContextChef compiles unbounded information into a bounded window. Every feature
the library has, or will have, sits on exactly one of five axes:

| Axis | Question | Owner after v5 |
|---|---|---|
| **① Selection** | What goes into the window | `OverflowStrategy` (history), `Pruner` (tools), `Memory.selector` |
| **② Placement** | Where in the window it goes | `Assembler`, sandwich layout, tail channel, cache-stable prefix |
| **③ Persistence** | Where it lives when it is out of the window | one `StorageBackend` + one `Store` |
| **④ Retrieval** | How the model reaches outside the window | one `context` tool (+ `new_context`) via `chef.handleTool` |
| **⑤ Adaptation** | Provider wire format | adapters (unchanged) |

Overflow is not a feature; it is *information moving from ① to ③, recoverable via ④*.
`summarize` / `anchored` / `reset` are ① policies. `archive` / `notes` / `memory` are
③ namespaces. `recall` / `notes.read` / `view` are ④ handles.

Non-negotiables that hold in every phase:

1. **Mechanism, not policy.** No combination of user choices is rejected. Silent-failure
   classes (prefix rewritten, pinned dropped, tool pair split) are *reported* through
   the existing audit/event channels, never blocked.
2. **Prefix byte-stability** (the 4.1 guarantee) is preserved: every library-owned tool
   schema is static; volatile content only ever enters through the tail channel.
3. **Zero forced migration in 4.x.** Every renamed option keeps a deprecated alias that
   maps onto the new shape. Aliases are removed in 5.0 only.
4. **Golden payloads.** A fixture suite captured in Phase 0 must produce byte-identical
   payloads under default (legacy) configuration through Phase 5.

## 1. Phase plan and dependency order

```
Phase 0  cleanup + golden fixtures        (no behavior change)
Phase 1  pipeline as explicit phases      (no public API change; hooks → slots with aliases)
Phase 4a StorageBackend + Store           (parallel with Phase 1; additive)
Phase 2  OverflowStrategy                 (depends on 1)
Phase 3  handoff budget · new_context · window lineage   (depends on 2)
Phase 4b unified `context` tool + handleTool + tools mode (depends on 3, 4a)
Phase 4c vocabulary alignment: prompts · audit markers · inline XML · middleware · docs
Phase 5  README/docs restructure · changesets · MIGRATION-5 · TODO
```

Each phase is one commit on `claude/architecture-v5`, verified (typecheck · lint ·
full test suite · build) before the next starts. One adversarial review at the end.

## 2. Phase 0 — delete before build

Scope = the "v4 Review Follow-ups" section of `TODO.md`, plus dead-code removal in the
four files about to be restructured (`chef.ts`, `modules/janitor/index.ts`,
`modules/memory/index.ts`, `modules/offloader/index.ts`):

- Hoist the duplicated compress-without-persistence warn machinery, `createJanitor`
  assembly and redacted-thinking warn-once out of `ai-sdk-middleware` and
  `tanstack-ai` into a shared core helper (`src/integrations/` or similar); dedupe the
  `<thinking>` textifier shared by the OpenAI and Gemini adapters.
- Simplifications listed in TODO (BackgroundCompressionJob derivable fields,
  `_summarize` failure-path repetition, tanstack adapter derivable projections,
  `detectServerContextManagement` clearOnly analysis).
- Altitude: move `computeAnthropicBetas` and the default server-edits config from
  `chef.ts` into the Anthropic adapter layer; promote `_anthropic_compaction`,
  `_gemini_thought_signature`, `_openai_reasoning` from index-signature passthroughs
  to typed optional `Message` fields; give `resolveRecall` a formatted rendering option.
- Remove unused exports/imports/props/debug logs in the four target files.
- **Golden fixtures**: add `packages/core/tests/golden/` with ~8 representative
  configurations (default; memory after_system; memory before_history_tail + selector;
  dynamic state both placements; guardrail both placements; anchored + archive;
  server strategy; skill tail + announcements) compiled against all three targets, the
  payloads serialized with `Assembler.stringifyPayload` and committed as `.json`. A test
  asserts equality. This is the byte-stability guard for every later phase.

Deliverable: cleaner code, identical behavior, golden suite green.

## 3. Phase 1 — pipeline as explicit phases

`ContextChef._compileInner` becomes a fixed, ordered list of phases. Each phase is a
named function with a declared contract; the orchestrator runs them in order and
fires slot handlers at the boundaries.

```ts
type PhaseName =
  | 'start'                 // compile:start event, abort check
  | 'transform-tool-results'// transformToolResult over tool messages (pre-overflow)
  | 'overflow'              // Janitor budget check + strategy (Phase 2 plugs in here)
  | 'inject'                // onBeforeCompile → implicit context
  | 'memory'                // Memory.compileArtifacts → sandwich parts
  | 'skill'                 // active skill instructions (after_system | tail)
  | 'assemble'              // sandwich assembly (system layers + history + placements)
  | 'tail'                  // tail stitch + announcements + positional system
  | 'adapt'                 // target adapter + tools + server-managed payload
  | 'audit'                 // cacheAudit (Anthropic) + dev invariants
  | 'done';                 // compile:done event

interface CompileContext {           // mutable, flows through phases
  readonly options: CompileOptions;
  readonly target: ResolvedTarget;   // adapter, isAnthropicTarget, serverManaged
  history: Message[];
  systemLayers: Message[];
  tailParts: string[];
  messages: Message[];               // after 'assemble'
  payload?: TargetPayload;           // after 'adapt'
  meta: CompileMeta;
  window: WindowLineage;             // Phase 3 fills; Phase 1 stubs { first, current }
}
```

Slots are the public composition surface. Handlers run in registration order.

```ts
type SlotName =
  | 'before-overflow' | 'after-overflow'
  | 'before-assemble' | 'after-assemble'
  | 'before-adapt'    | 'after-adapt';

interface SlotHandlers {
  'before-overflow': (ctx: { history: readonly Message[]; budget: BudgetInfo })
                     => void | false | Promise<void | false>;   // false = skip overflow this compile
  'after-overflow':  (ctx: { history: Message[]; result: OverflowResult | null }) => void | Promise<void>;
  'before-assemble': (ctx: BeforeCompileContext & { inject(text: string): void }) => void | Promise<void>;
  'after-assemble':  (messages: Message[]) => Message[] | Promise<Message[]>;
  'before-adapt':    (messages: readonly Message[]) => void | Promise<void>;
  'after-adapt':     (payload: TargetPayload) => void | Promise<void>;
}

chef.use<S extends SlotName>(slot: S, handler: SlotHandlers[S]): this;
chef.unuse<S extends SlotName>(slot: S, handler: SlotHandlers[S]): this;
```

Legacy hooks become registrations at construction — same code path, no second idiom:

| Legacy (kept, deprecated JSDoc) | Registers as |
|---|---|
| `ChefConfig.transformToolResult` | phase `transform-tool-results` (per-message; not a slot) |
| `JanitorConfig.onBeforeCompress` | `before-overflow` — the slot itself ships in Phase 1; the Janitor-side alias migrates in Phase 2 (Janitor is Phase 2's file) |
| `ChefConfig.onBeforeCompile` | `before-assemble` (`inject` = the returned string) |
| `ChefConfig.transformContext` | `after-assemble` |
| events `compile:*`, `compress:*`, `offload:*`, `pruner:*` | unchanged (read-only) |

Dev invariants (`ChefConfig.pipelineChecks?: boolean`, default false): after
`after-assemble` handlers, verify pinned messages still present and tool pairs intact;
after `tail`, verify nothing before the tail insertion point changed vs. the
pre-`tail` snapshot. Violations go to `logger.warn` + a `pipeline:invariant` event.
Never throw.

Deliverable: golden suite byte-identical; `_compileInner` ≤ 150 lines of orchestration;
each phase in `src/pipeline/phases/<name>.ts`.

## 4. Phase 2 — `OverflowStrategy`

```ts
interface BudgetInfo { limit: number; current: number; trigger: number; remaining: number }

interface OverflowInput {
  history: Message[];                 // post transform-tool-results
  budget: BudgetInfo;
  tokenizer: (m: Message[]) => number;
  pinned: readonly Message[];         // must survive verbatim (turn-scoped)
  window: WindowLineage;
  signal?: AbortSignal;
}

interface OverflowResult {
  history: Message[];                 // the new in-window history
  evicted: Message[];                 // what left the window (archive input)
  summary?: string;                   // rendered summary text, if the strategy produced one
  meta: { strategy: string; windowId: string; changed: boolean; reason?: string };
}

interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  snapshot?(): unknown;               // stateful strategies (anchored, background)
  restore?(state: unknown): void;
}
```

Built-ins (each a factory in `src/overflow/`):

| Factory | Replaces | Notes |
|---|---|---|
| `summarize(opts)` | `compressionMode: 'rewrite'` | current LLM summary path; `opts` = compressionModel, guidelines, customCompressionInstructions, minShrinkRatio, validateCompression, preserveRecentMessages, preserveRatio, toolResultStubThreshold |
| `anchored(opts)` | `compressionMode: 'incremental-anchored'` | same opts + anchor document; anchor keyed by window id (Phase 3) |
| `server(config, { fallback? })` | `contextManagement.strategy: 'server'` | Anthropic target → server-managed (`changed: false`, adapt attaches `context_management` + betas); other targets → `fallback` if given, else `changed: false, reason`. The alias builds `server(cfg, { fallback: <default client strategy> })` to preserve v4 behavior |
| `reset(opts)` | new | keeps `pinned` + nothing else from history; everything else → `evicted`; `summary` = window-lineage stub. Safe only with `archive` — documented, not enforced |
| `chain(...s)` | new | runs the next strategy when the previous returned `changed: false` or is still over budget |
| `background(s)` | `compressionScheduling: 'background'` | wraps a strategy in the existing BackgroundCompressionJob semantics (content-equivalence staleness) |

`archive` becomes strategy-agnostic: after any strategy, `evicted` is archived when
`overflow.archive` is set. It is no longer a summarize-internal concern. In 4.x the
archive keeps writing into the `vfs` namespace so `context://vfs/...` URIs stay
byte-identical (golden fixture); the dedicated `archive/` namespace is a 5.0 switch.

Janitor stays as the **runner**: budget evaluation, tokenizer/usage, circuit breaker,
`compress:*` events, durable `planCompaction`/`compactHistory` — it calls
`strategy.apply`. Circuit breaker counts failures of whatever strategy is installed.

Config and aliases:

```ts
ChefConfig.overflow?: {
  strategy?: OverflowStrategy;          // default summarize(<janitor aliases>)
  archive?: 'vfs' | CompressionArchiveConfig;
  handoff?: HandoffConfig;              // Phase 3
}
```

| Deprecated alias | Maps to |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy = summarize(...)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy = anchored(...)` |
| `janitor.compressionScheduling: 'background'` | wrap in `background()` |
| `janitor.archive` | `overflow.archive` |
| `contextManagement.strategy: 'server'` + `.server` | `overflow.strategy = server(config)` |
| `janitor.{compressionModel, compressionGuidelines, customCompressionInstructions, minShrinkRatio, validateCompression, preserveRecentMessages, preserveRatio, toolResultStubThreshold}` | options of the default strategy |

`janitor.{contextWindow, tokenizer, usagePreference, triggerRatio, logger, onCompress, onBeforeCompress}` stay on Janitor (runner concerns).

No combination is validated. `reset()` without `archive` is allowed and documented.

Deliverable: golden suite byte-identical under aliases; strategies unit-tested in
isolation; `chain([summarize(), reset()])` covered.

## 5. Phase 3 — handoff budget · `new_context` · window lineage

**Handoff budget** (strategy-agnostic, lives in the pipeline before `overflow`):

```ts
interface HandoffConfig {
  budgetTokens: number;      // reserved above the trigger; > 0
  prompt?: string;           // template with {n_remaining}; ≤ 2000 bytes; default in Prompts
}
```

When `budget.remaining <= handoff.budgetTokens` and no notice has been issued for the
current window, inject the rendered prompt once through the tail channel (same
mechanism as announcements, `channel: 'auto'`). Reset the once-per-window flag when the
window id changes. `validate()` at construction (positive budget, non-empty prompt,
byte cap). This is the model's chance to persist state into `notes/`/`memory/` before
the library evicts mechanically.

**`new_context` tool**: `getNewContextToolDefinition()` (static, no parameters).
`chef.requestNewContext()` sets a flag; the next compile forces the `overflow` phase
regardless of budget. Dispatch through `chef.handleTool` (Phase 4b); Phase 3 ships the
definition + the method.

**Window lineage**: `WindowLineage = { first: string; previous?: string; current: string }`.
The runner allocates a new id on every overflow that returns `changed: true`.
`OverflowResult.meta.windowId` records it; `reset()`'s summary stub renders the
lineage; `anchored()` keys its anchor document by window id; `CompileMeta.windowId`
exposes it; it survives snapshot/restore. The legacy summary wrapper text is NOT
changed in 4.x (it would break the anchored golden fixture) — a
`Context window: <current> (previous: <previous>)` line in summaries is part of the
unified vocabulary and lands with Phase 4c.

Deliverable: handoff notice appears exactly once per window in tests; `new_context`
forces overflow; lineage round-trips through snapshot.

## 6. Phase 4a — one `StorageBackend`, one `Store`

Persistence collapses to a single substrate: addressed content with metadata.

```ts
interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}

interface StorageBackend {
  read(ns: string, path: string): StoredEntry | null | Promise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): void | Promise<void>;
  delete(ns: string, path: string): boolean | Promise<boolean>;
  list(ns: string, prefix?: string): ListedEntry[] | Promise<ListedEntry[]>;   // { path, meta }
  search?(ns: string, query: string): SearchHit[] | Promise<SearchHit[]>;     // optional capability
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
}

class Store {
  constructor(backend: StorageBackend, options?: { eviction?: Partial<Record<string, EvictionPolicy>> });
  namespace(ns: string): NamespaceView;   // get / put(path, content, meta) / put(content, meta) → auto id / append / delete / list / search / uri
  static uri(ns: string, path: string): string;            // `context://<ns>/<path>`
  static parseUri(uri: string): { ns: string; path: string } | null;
  static fromMemoryStore(legacy: MemoryStore): StorageBackend;   // ns 'memory'; MemoryStoreEntry ↔ meta 1:1
  static fromVfsAdapter(legacy: VFSStorageAdapter): StorageBackend; // ns 'vfs' | 'archive'
}
```

Built-in backends: `InMemoryBackend`, `FileSystemBackend` (today's `FileSystemAdapter`).
Namespaces: `memory` (Memory: TTL sweep + selector stay in the module — they were never
store features), `notes` (Phase 4b), `vfs` (Offloader), `archive` (overflow). Eviction
policies (maxAge / maxFiles / maxBytes, today on `VFSConfig`) become per-namespace
options on `Store`.

`ChefConfig.store?: StorageBackend | Store` routes memory/vfs/archive through one
backend (this `ChefConfig` wiring lands in Phase 4b — `chef.ts` is contended in 4a's
time slot; 4a delivers module-level acceptance on `Memory` / `Offloader`). Legacy `memory.store` and `vfs.storage` are still accepted and wrapped with the
`from*` adapters. `VFSMemoryStore` becomes a deprecated alias (it *is* `memory/` on the
VFS backend). Public APIs of `Memory` and `Offloader` do not change.

Deliverable: one backend implementation serves memory + vfs + archive in a test;
legacy stores keep every existing test green; capability errors for missing `search`.

## 7. Phase 4b — one model-facing tool

```ts
// getContextToolDefinition() — static, cache-safe, memory_20250818-shaped
{
  name: 'context',
  parameters: {
    command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename' | 'search',
    path: string,            // context://<ns>/<path> or <ns>/<path>
    // command-specific: content, old_str, new_str, insert_line, new_path, query
  }
}
```

- `recall_context(uri)` ≡ `view`; `create_memory` ≡ `create` into `memory/`;
  `modify_memory` ≡ `str_replace`/`delete` in `memory/`; FileMemory ≡ `notes/`.
- Access control lives here, not in the store: default policy = write to `memory/` and
  `notes/`, read anywhere; configurable via `ChefConfig.contextTool?.writable: string[]`.
- `chef.ownsTool(name): boolean` and `chef.handleTool(call: { name: string; arguments: unknown }): Promise<string>`
  dispatch `context`, `new_context`, and the legacy trio. One entry point for every
  library-owned tool.
- `ChefConfig.tools?: 'legacy' | 'unified'`, default `'legacy'` in 4.x. Under `unified`,
  `payload.tools` carries `context` (+ `new_context` when handoff is configured) and
  **not** the legacy trio; the two sets never co-exist in one payload.

Tool names are dispatch keys in user code, so the default cannot flip in a minor.

## 8. Phase 4c — vocabulary alignment

The model must see one vocabulary. Under `tools: 'unified'`:

- `Prompts.CONTEXT_STORE_INSTRUCTION` replaces `MEMORY_INSTRUCTION`: namespaces,
  addressing, which namespaces are auto-shown (`memory/`) vs on-demand.
- The injected memory block keeps its structure; header and key guidance are reworded
  around `context://memory/<key>`. `cacheAudit`'s `VOLATILE_MARKERS` gains the new
  header (both legacy and unified markers are present).
- Offload truncation placeholder and the summary wrapper's archive citation use the
  `context://` wording consistently.
- Inline `<update_core_memory>` / `<delete_core_memory>` tags keep working (deprecated),
  writing to `memory/`.
- `ai-sdk-middleware` and `tanstack-ai` pass through `tools`, `store`, `overflow`;
  any auto-dispatch routes via `chef.handleTool`.
- README (en/zh), core README, docs-site (en/zh): Memory, VFS, archive and FileMemory
  sections merge into one "Context store" chapter.
- Rename sweep per CLAUDE.md "No Semantic Search": direct references, type references,
  string literals (tool names, header text, `context://` spellings), dynamic imports,
  barrel re-exports, tests/mocks — across all three packages and docs.

## 9. Phase 5 — documentation, release, 5.0 plan

- README/docs restructured around the five axes (map, not list).
- Changesets: core `minor` (4.2.0) with one section per phase; `ai-sdk-middleware` /
  `tanstack-ai` `minor` if touched.
- `MIGRATION-5.md` skeleton: everything deprecated in 4.2 and what replaces it.
- `TODO.md`: remove completed follow-ups; add the 5.0 removal list.
- Every deprecated alias carries `@deprecated` JSDoc pointing at its replacement.

**5.0.0** (later, separate): `tools` default → `unified`; remove legacy tools, prompt
constants, `MemoryStore` / `VFSStorageAdapter` / `VFSMemoryStore` aliases, and the
Janitor overflow aliases.

## 10. Rules for implementing agents

- Read this document fully before touching code. Implement **only** your phase.
- Re-read every file before editing it; never batch more than 3 edits to one file
  without a verification read.
- Public API stays source-compatible in 4.x. New surface is additive.
- Run from repo root before committing: `pnpm --filter @context-chef/core build`,
  `pnpm -r --if-present run typecheck`, `pnpm lint`, `pnpm -r --if-present run test`.
  The golden suite must be green.
- One commit per phase: `refactor(v5): phase N — <title>`. No attribution lines.
- Do not edit this document except to correct a factual mismatch found while
  implementing; if you do, say so in the commit body.
