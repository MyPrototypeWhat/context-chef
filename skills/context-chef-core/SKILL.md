---
name: context-chef-core
description: "Helps developers integrate @context-chef/core v4 into their TypeScript/JavaScript AI agent projects. Use this skill when the user wants to add context-chef to their project, set up context management for LLM calls, integrate history compression or tool management into an agent loop, or asks about wiring context-chef with OpenAI/Anthropic/Gemini. Also trigger when the user mentions 'context-chef', 'context compiler', 'context engineering', or asks how to manage LLM context, compress conversation history, prune or gate tools, load agent skills, or add memory to their AI agent."
argument-hint: "[feature-focus]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# Integrate @context-chef/core (v4.2)

Help the developer add [@context-chef/core](https://github.com/MyPrototypeWhat/context-chef) — a context compiler for AI agents — into their existing project. The goal is to produce working, tailored integration code, not generic boilerplate.

This skill targets **v4.2**. If the project has an older `@context-chef/core` in package.json, apply the migration table at the bottom of `references/api-reference.md` first. Options marked **(deprecated)** below still work in 4.x and are removed in 5.0 — see `MIGRATION-5.md` in the repo; generate the replacement, not the alias.

## Step 1: Analyze the developer's project

Before asking questions, silently inspect the project to understand what they already have:

```
1. package.json → detect LLM SDK (openai, @anthropic-ai/sdk, @google/generative-ai)
   → also detect ai / @ai-sdk/* (Vercel AI SDK) or @tanstack/ai: recommend the
     dedicated middleware packages (@context-chef/ai-sdk-middleware,
     @context-chef/tanstack-ai) instead of hand-wiring core
2. Lock file → detect package manager (pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm, bun.lockb → bun)
3. tsconfig.json → TypeScript or JavaScript?
4. Existing agent loop code → look for patterns like:
   - openai.chat.completions.create   → target 'openai'
   - openai.responses.create          → target 'openai-responses'
   - anthropic.messages.create        → target 'anthropic'
   - model.generateContent            → target 'gemini'
   - Any while/for loop that calls an LLM repeatedly
```

Use Glob + Grep to find these. Search in `src/`, `lib/`, `app/`, and root-level files. This context shapes everything you generate — the provider target, the import style, the loop structure.

## Step 2: Ask about their needs

Based on what you found, present a brief summary of their setup and ask which context-chef features they need. Frame the question around their pain points, not abstract module names:

| Pain point | context-chef feature | Where |
|---|---|---|
| Conversations get too long, model forgets things | History compression (client-side) | Janitor |
| On Anthropic, want the provider to compact server-side | `overflow: { strategy: server(cfg, { fallback }) }` | ChefConfig |
| Compression must never lose policy/constraint text | `pinned: true` on messages | Message |
| Need exact details back after compression | `overflow: { archive: 'vfs' }` + the `context` tool's `view` | Overflow + Store |
| Model should decide when to start a fresh window | `new_context` tool + `chef.requestNewContext()` | Overflow |
| Model should save state before its window is cut | `overflow: { handoff: { budgetTokens } }` | Overflow |
| Too many tools, model hallucinates tool calls | Tool pruning / namespace architecture | Pruner |
| Need to block tools at runtime (permissions, sandboxing) | `setBlockedTools` + `checkToolCall` gate | Pruner + ContextChef |
| Mode/phase-scoped behavior ("planning mode", "review mode") | Skill module (`registerSkills` / `activateSkill`) | Skill |
| Need cross-session memory (user prefs, project rules) | Persistent KV memory | Memory |
| Terminal output / API responses too large | Auto-truncation with VFS retrieval, `transformToolResult` | Offloader |
| Need to rollback after failed tool calls | Snapshot & restore | Snapshot |
| Switching between OpenAI / Anthropic / Gemini | Multi-provider compilation, `defaultTarget` | Adapters |
| Custom or niche provider | `adapterRegistry.register()` | Adapters |
| Injecting RAG / external context before LLM calls | `chef.use('before-assemble', ...)` slot | Pipeline |
| Model needs a scratch space it can read back later | `notes/` namespace via the `context` tool | Store |
| One place for memory, offloaded output and archives | `ChefConfig.store` — one `StorageBackend` | Store |
| Want cheaper compression before LLM summarization | `onBeforeCompress` + `compact()` | Janitor |
| Own the message store, want compaction to persist | Durable compaction (`compactHistory`) | Janitor |

If the developer is unsure, recommend starting with: **history compression + multi-provider compilation** — these solve the most common problems with minimal setup.

## Step 3: Install

Generate the install command using their detected package manager:

```
npm install @context-chef/core zod
pnpm add @context-chef/core zod
yarn add @context-chef/core zod
bun add @context-chef/core zod
```

`zod` is required for dynamic state injection (the schema-validated XML state that prevents model drift).

## Step 4: Generate integration code

Generate code that fits their existing project structure. The core pattern is always:

```typescript
import { ContextChef } from "@context-chef/core";
import { z } from "zod";

// 1. Initialize once (per conversation/session — not per turn)
const chef = new ContextChef({
  defaultTarget: "anthropic", // match their SDK; per-call target overrides this
  /* config based on their needs */
});

// 2. Per-turn: set context → compile → call LLM → feed usage back
chef
  .setSystemPrompt([...])
  .setHistory(conversationHistory)
  .setDynamicState(schema, state);
const payload = await chef.compile(); // or compile({ target: "..." })
```

### Configuration generation rules

Build the `ChefConfig` object based on which features they selected:

**History compression (Janitor):**
```typescript
janitor: {
  contextWindow: 200000, // match their model's context window
  // v4: compression triggers at contextWindow * 0.7 by default ("pre-rot").
  // Only set triggerRatio if they explicitly want a different point;
  // triggerRatio: 1 restores the old trigger-at-window behavior.

  // Path A: if they have a tokenizer
  tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(JSON.stringify(m)).length, 0),
  preserveRatio: 0.8,
  // Path B: simpler — call chef.reportTokenUsage() after each LLM call
  preserveRecentMessages: 1,

  // Always recommend a compression model (a cheap model that summarizes old messages)
  compressionModel: async (msgs) => summarizeWithCheapModel(msgs),
  // Big tool outputs waste summarizer tokens — stub them before summarization
  toolResultStubThreshold: 5000,
}
```

**Overflow strategy (4.2)** — the Janitor above is the *runner* (budget, circuit breaker, events, `onCompress` / `onBeforeCompress`); *what leaves the window* is an `OverflowStrategy` on `ChefConfig.overflow`. Reach for one only when the host's situation calls for it — the default (`summarize()` built from the `janitor` options above) needs no `overflow` block at all:

```typescript
import { summarize, anchored, background, chain, reset, server } from "@context-chef/core";

overflow: {
  strategy: anchored({ compressionModel }),  // or summarize(...) / reset() / server(...)
  archive: 'vfs',                            // strategy-agnostic: whatever is evicted is stored
}
```

| Situation | Strategy |
|---|---|
| Default — regenerate the summary from the evicted span | `summarize(opts)` |
| Long-running agent where repeated re-summarization drifts | `anchored(opts)` — persistent anchor doc, each compression merges only the newly evicted span |
| Latency-sensitive loop that can't block on a summarizer call | `background(summarize(opts))` — first over-budget compile returns unchanged, a later compile swaps the finished summary in |
| Cheap window turnover; keep only pinned messages | `reset()` — pair with `archive` or the evicted span is gone |
| Escalate when the first strategy declines or is still over budget | `chain(summarize(opts), reset())` |
| Anthropic should compact server-side | `server(cfg, { fallback: summarize(opts) })` — server-managed on Anthropic, fallback everywhere else |

The old spellings still work and are **(deprecated)**: `janitor.compressionMode: 'rewrite' \| 'incremental-anchored'` → `summarize()` / `anchored()`; `janitor.compressionScheduling: 'background'` → `background()`; `janitor.archive` → `overflow.archive`; `contextManagement: { strategy: 'server', server }` → `server(server)`. Setting both warns once and the strategy wins.

Other options to layer on only when needed:

- Details must stay retrievable after compression → `overflow: { archive: 'vfs' }`; the summary cites a `context://` URI the model reads back with the `context` tool's `view` (or `chef.resolveRecall(uri)`).
- Domain-specific facts must survive summarization (ticket IDs, file paths) → `compressionGuidelines: ['Preserve all file paths verbatim.', ...]`.
- Summaries must be quality-checked → `validateCompression: (summary, { compressed, kept }) => boolean` (return false to reject; history stays unchanged).
- Messages that must never be summarized away (safety policy, standing task rules) → set `pinned: true` on those history messages. Pinning is turn-scoped and also protects them from `compact()`.
- The model should get a warning before its window is cut → `overflow: { handoff: { budgetTokens: 8000 } }`. When headroom drops into that band, one compile carries a notice in its tail telling the model to write anything worth keeping into `memory/` / `notes/`. Once per window, never persisted.
- The model should be able to close a window itself → register `getNewContextToolDefinition()` (auto-emitted under `tools: 'unified'` when `handoff` is set) and dispatch it through `chef.handleTool`, which calls `chef.requestNewContext()`.

Failure semantics worth telling the developer: a failed/rejected/non-shrinking compression leaves history **unchanged** (no placeholder truncation) and counts toward a circuit breaker (3 consecutive failures = compression disabled until success or `clearHistory()`).

**Server-side compaction (Anthropic only):** if the host is on `@anthropic-ai/sdk` and wants the provider to compact:
```typescript
import { server, summarize } from "@context-chef/core";

const chef = new ContextChef({
  overflow: {
    strategy: server(
      { edits: [{ type: "compact_20260112" }] },   // provider-shaped, passed through verbatim
      { fallback: summarize({ compressionModel }) }, // used on non-Anthropic targets
    ),
  },
});
const payload = await chef.compile({ target: "anthropic" });
await anthropic.beta.messages.create({
  ...payload, // includes context_management + betas
  model, max_tokens,
  betas: payload.betas, // e.g. ['compact-2026-01-12']
});
```
Client LLM compression is skipped entirely on the Anthropic target; every other module (pruner, memory, VFS, skills, mechanical `compact()`) still works. Compaction blocks the API returns round-trip through `fromAnthropic` automatically (they come back pinned). `contextManagement: { strategy: 'server' }` is the **(deprecated)** spelling of exactly this.

**Tool management (Pruner):**
- If they have < 20 tools → use flat mode with `registerTools()` + `pruneByTask()`
  - **Important**: `pruneByTask()` returns filtered tools but doesn't modify internal state. `compile()` always includes ALL registered tools. The developer must manually override `payload.tools` with the pruned result:
    ```typescript
    const pruned = chef.getPruner().pruneByTask("read a file");
    const payload = await chef.compile({ target: "anthropic" });
    payload.tools = pruned.tools; // override with filtered tools
    ```
- If they have 20+ tools → recommend namespace + lazy loading architecture (automatic via `compile()`)
- If they need **runtime blocking** (permissions, rate limits, sandbox): `chef.getPruner().setBlockedTools(names)` then gate every LLM tool call before dispatch:
  ```typescript
  for (const call of response.tool_calls ?? []) {
    const check = chef.checkToolCall({ name: call.function.name });
    if (!check.allowed) {
      history.push({ role: "tool", tool_call_id: call.id, content: check.reason });
      continue;
    }
    // ... dispatch the tool
  }
  ```
- If the host is on Anthropic Tool Search: mark tools `deferLoading: true` (passed through verbatim)
- See `references/api-reference.md` for the two-layer tool architecture details

**Skills (phase/mode-scoped behavior):**
```typescript
import { loadSkillsDir } from "@context-chef/core";

const { skills, errors } = await loadSkillsDir("./skills"); // <dir>/<name>/SKILL.md
chef.registerSkills(skills);
chef.activateSkill("planning"); // or a Skill object, or null to deactivate
```
The active skill's instructions become a dedicated system message between the system prompt and memory (`skillPlacement: 'after_system'`, the default). Set `skillPlacement: 'tail'` when the agent switches skills often — the instructions then lead the tail stitch instead of the cacheable prefix, so a switch no longer invalidates the cached prefix, at the cost of re-sending the instruction tokens uncached every request. For LLM-driven skill selection, expose a `load_skill` tool whose description is `formatSkillListing(skills)` and call `chef.activateSkill(name)` in the dispatch loop. `renderSkill(skill, { args })` substitutes `$ARGUMENTS`/`$0..$N` placeholders. Note: `allowedTools` on a skill is annotation only — wire it to `setBlockedTools` yourself if enforcement is needed.

**Memory:**
```typescript
memory: {
  defaultTTL: { turns: 20 },
  // If the host uses prompt caching on Anthropic/Gemini, keep volatile memory
  // text out of the top-level system parameter so cache breakpoints survive
  // memory mutations:
  memoryPlacement: "before_history_tail", // default: 'after_system'
}
```
`memory.store` is optional in 4.2 — a shared `ChefConfig.store` (below) fills it in. `store: new InMemoryStore()` / `new VFSMemoryStore(dir)` still work and are **(deprecated)**: `InMemoryBackend` / `FileSystemBackend` replace them.

**The context store (4.2)** — one backend behind every namespace: `memory` (Memory), `vfs` (offloaded tool output), `archive` (compressed spans), `notes` (the model's own scratch space).
```typescript
import { FileSystemBackend, InMemoryBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context-store"), // or new InMemoryBackend() in dev
  memory: {},
});
await chef.getStore().namespace("notes").put("plan.md", "# Plan\n"); // seed / inspect
```
`ChefConfig.store` fills in only what nothing else specifies — an explicit `memory.store` or `vfs.store` / `vfs.adapter` / `vfs.storageDir` still wins. Custom persistence means implementing `StorageBackend` (`read` / `write` / `delete` / `list`, with `readAll` / `append` / `search` / `snapshot` / `restore` / `getPhysicalPath` optional and capability-queried), **not** `MemoryStore` or `VFSStorageAdapter` — both **(deprecated)**.

**VFS Offloader:**
```typescript
vfs: {
  threshold: 5000,  // characters; truncate content longer than this
  // store: <StorageBackend>  — or let ChefConfig.store supply it
}
```
For uniform handling of large/sensitive tool results without per-tool if/else in the loop, add `transformToolResult` (runs at compile start, BEFORE compression):
```typescript
transformToolResult: async (content, { toolName }) =>
  content.length > 5000 ? await chef.offloadAsync(content) : content,
```

**Pipeline slots — recommend based on their use case:**

`compile()` runs a fixed phase list, and `chef.use(slot, handler)` / `chef.unuse(slot, handler)` hang handlers off the boundaries. Handlers run in registration order and are awaited in sequence; their errors are NOT isolated (they propagate out of `compile()`).

| Slot | Signature | Use for |
|---|---|---|
| `before-overflow` | `({ history, budget }) => void \| false` | veto overflow for this compile (return `false`), observe the real budget |
| `after-overflow` | `({ history, result }) => void` | react to what was evicted (`result` is null when the phase was skipped) |
| `before-assemble` | `(ctx) => void`, `ctx.inject(text)` | RAG / AST / MCP injection into `<implicit_context>` |
| `after-assemble` | `(messages) => Message[]` | rewrite the assembled sandwich; handlers chain |
| `before-adapt` | `(messages) => void` | observe the final IR before the target adapter |
| `after-adapt` | `(payload) => void` | observe the compiled payload |

If they need RAG/AST/MCP injection:
```typescript
chef.use("before-assemble", async (ctx) => {
  // ctx.dynamicStateXml contains the serialized task state — useful as a search query
  const results = await vectorDB.search(ctx.dynamicStateXml);
  if (results.length) ctx.inject(results.map(r => r.content).join("\n"));
});
```
`ChefConfig.onBeforeCompile` and `ChefConfig.transformContext` are **(deprecated)** aliases that register on `before-assemble` / `after-assemble` at construction — same code path, same output. Generate `use()` for new code.

For development, `pipelineChecks: true` verifies after every `after-assemble` handler that pinned messages survived and tool pairs are intact, and after the tail phase that nothing ahead of the insertion point changed. Violations go to `logger.warn` + a `'pipeline:invariant'` event and never throw. Keep it off in production (it costs a snapshot + a serialization pass per compile).

If they want to try cheaper compression before LLM summarization, recommend the `onBeforeCompress` + `compact()` pattern:
```typescript
import { Janitor } from "@context-chef/core";
const compactJanitor = new Janitor({ contextWindow: Infinity });

// In ChefConfig:
janitor: {
  contextWindow: 200000,
  compressionModel: async (msgs) => summarizeWithCheapModel(msgs),
  onBeforeCompress: (history) => {
    // First pass: mechanically strip thinking blocks (zero LLM cost)
    return compactJanitor.compact(history, { clear: ['thinking'] });
    // If still over budget, Janitor's LLM compression proceeds automatically
  },
}
```
(Do NOT clear `tool-result` here when LLM compression follows — the summarizer would see empty tool results. Use `toolResultStubThreshold` for that instead.)

**Durable compaction — when the host owns the message store** (DB-backed chat, persistence layer) and wants compaction to actually shrink stored history rather than only the in-flight payload:
```typescript
import { compactHistory } from "@context-chef/core";

const newHistory = await compactHistory(storedMessages, summarizeWithCheapModel, {
  keepRecentTurns: 6,
  toolResultStubThreshold: 5000,
});
if (newHistory !== storedMessages) await db.replaceMessages(newHistory);
```
`planCompaction` is the plan-only variant (`{ system, toSummarize, toKeep }`, turn-safe split); `summarizeHistory` is the raw summarization primitive. The `compress` callback must role-flatten tool messages — use the exported `flattenForCompression` helper.

**Library-owned tools (`tools` mode) — 4.2:**

`ChefConfig.tools` decides which library tools `compile()` puts in `payload.tools`:

- `'legacy'` (default in 4.x): Memory's `create_memory` / `modify_memory`, and only when memory is configured. `recall_context` / `new_context` stay opt-in via `registerTools`.
- `'unified'`: one `context` tool covering every namespace, plus `new_context` when `overflow.handoff` is set. The legacy trio is never co-emitted.

```typescript
const chef = new ContextChef({
  tools: "unified",
  contextTool: { writable: ["memory", "notes"] }, // default; narrow to ['notes'] for read-only memory
  store: new FileSystemBackend(".context-store"),
  memory: {},
});
```

The `context` tool is `memory_20250818`-shaped — `view` / `create` / `str_replace` / `insert` / `delete` / `rename` / `search` over `context://<ns>/<path>` — and is static and frozen, so it is safe inside a cached prefix. `'unified'` also switches the session's vocabulary: the memory instruction, memory block, offload truncation marker, summary wrapper and handoff notice are all rewritten in `context://` wording, so the prompt never names a tool the payload does not carry.

Dispatch every library tool through the single entry point, whichever mode is set:

```typescript
for (const call of response.tool_calls ?? []) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,  // JSON string or already-parsed object
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
    continue;
  }
  // ... the host's own tools
}
```

`ownsTool` / `handleTool` understand `context`, `new_context` AND the legacy trio regardless of the mode, so this dispatch works before and after a mode flip — which is the whole migration for 5.0, where `'unified'` becomes the default. Model-facing mistakes (unknown path, missing argument, write to a read-only namespace, a vetoed memory write) come back as `Error: …` text; only an unowned tool name throws.

Tell the developer: prefer `tools: 'unified'` for new integrations. Keep `'legacy'` only when their loop already branches on the old tool names and they are not ready to change it.

### Agent loop integration

This is the most critical part. Find their existing agent loop and show exactly where context-chef calls go. The pattern is:

```typescript
// BEFORE the loop: initialize chef (once per conversation)
const chef = new ContextChef({ ... });

// INSIDE the loop, BEFORE each LLM call:
chef.setSystemPrompt([...]).setHistory(history).setDynamicState(schema, state);
const payload = await chef.compile({ target: "..." });
const response = await llm.call(payload);

// AFTER each LLM call:
chef.reportTokenUsage(response.usage.prompt_tokens); // or input_tokens for Anthropic

// IN the tool handling section:
// - Gate every call first: chef.checkToolCall({ name: call.function.name })
// - Route library tools through chef.ownsTool(name) → chef.handleTool(call)
//   (covers `context`, `new_context`, create_memory, modify_memory, recall_context)
// - Handle load_skill via chef.activateSkill(name) if skills are enabled
// - Use chef.offload() / transformToolResult for large tool results if VFS is enabled
// - Use chef.getPruner().isNamespaceCall() if using namespace tools
```

For provider-specific examples, read `references/provider-examples.md`.

## Step 5: Verify and explain

After generating the code:

1. Verify imports are correct — `ContextChef`, `InMemoryBackend`, `FileSystemBackend`, `loadSkillsDir`, `getContextToolDefinition`, the overflow factories (`summarize` / `anchored` / `background` / `chain` / `reset` / `server`) all come from `"@context-chef/core"`. Verify no removed v3 APIs are referenced, and no **(deprecated)** 4.x alias where the replacement exists (see both tables in `references/api-reference.md`).
2. Verify the compile target matches their SDK (`"openai"` for chat completions, `"openai-responses"` for the Responses API, `"anthropic"` for @anthropic-ai/sdk, `"gemini"` for @google/generative-ai)
3. Explain the "sandwich model" briefly: system prompt (cached, stable) → active skill → memory → compressed history → dynamic state (injected into last user message for recency bias) → guardrails
4. Point out the `_cache_breakpoint: true` flag on system prompt messages — this enables Anthropic's prompt caching and is harmless on other providers
5. Mention that compression triggers at 70% of `contextWindow` by default — earlier than pre-4.0 users may expect
6. If they set `tools: 'unified'`, mention the payload carries `context` instead of the memory tools and the prompt wording changes with it — a one-time cache-prefix invalidation on the switch

## Key API patterns to remember

- **Builder pattern**: All setter methods return `this` for chaining
- **compile() is async**: It triggers Janitor compression and memory sweeping; concurrent compile() calls on one instance are queued, but the canonical pattern is one chef per concurrent caller (e.g. per session — see `SessionPool`)
- **compile() returns SDK-ready payloads**: Pass directly to the provider's SDK — for Anthropic, it separates `system` from `messages` automatically
- **Target resolution**: `compile({ target })` → `ChefConfig.defaultTarget` → `'openai'`. Target accepts built-in names, any name registered via `adapterRegistry.register()`, or an `ITargetAdapter` instance directly
- **reportTokenUsage()**: Call after every LLM response to enable token-based compression
- **Dynamic state uses Zod schemas**: The state is validated and converted to XML tags that LLMs parse efficiently
- **Placement matters**: `'last_user'` (default) injects state into the last user message for recency bias; `'system'` places it as a standalone system message
- **withGuardrails() is stored, not immediate** (v4): options apply at compile() and are order-independent vs `setDynamicState`; each call replaces the previous; `withGuardrails(null)` clears
- **Events**: `chef.on('compress' | 'compress:start' | 'compress:end' | 'compile:start' | 'compile:done' | 'offload:created' | 'pruner:tool-blocked' | 'pipeline:invariant' | 'memory:changed' | 'memory:expired', handler)` for observability; handlers are error-isolated (a throwing handler logs and compile continues). Slot handlers registered with `use()` are NOT error-isolated — they are composition points, not observers
- **One dispatcher for library tools**: `chef.ownsTool(name)` → `chef.handleTool(call)` covers `context`, `new_context` and the legacy memory/recall tools in every `tools` mode

## Common mistakes to prevent

- Don't forget to call `reportTokenUsage()` — without it, history compression won't trigger (unless using the tokenizer path)
- Don't mutate the compiled payload — it's provider-formatted and ready to use (overriding `payload.tools` with a pruned list is the sanctioned exception)
- Don't create a new `ContextChef` instance per turn — reuse it across the conversation; but DO use one instance per concurrent conversation
- Don't configure both an `overflow.strategy` and the deprecated `janitor.compressionMode` / `compressionScheduling` / `archive` / `contextManagement` aliases — the strategy wins and the conflict warns once
- Don't use `server()` without a `fallback` if the host also compiles for non-Anthropic targets — those targets then get no compression at all
- Don't `compact({ clear: ['tool-result'] })` before LLM compression — use `toolResultStubThreshold` instead so the split windows stay coherent
- Don't hand-branch on library tool names — `chef.ownsTool(name)` + `chef.handleTool(call)` is the one entry point, and it is what makes the 5.0 `tools: 'unified'` default a no-op
- When using Memory, remember the library-owned tools are auto-injected and the LLM WILL call them: `create_memory` / `modify_memory` under `'legacy'`, `context` under `'unified'`
- For Anthropic with extended thinking, pass `thinking` and `redacted_thinking` fields on assistant messages — context-chef maps them to the correct Anthropic format. On OpenAI/Gemini targets thinking is dropped by default (see the thinking-preservation caveat in `references/api-reference.md` before promising otherwise)
- For Gemini 3.x, thought signatures on function calls (`ToolCall.thoughtSignature`) round-trip automatically through `fromGemini`/the Gemini target — don't strip unknown fields from tool calls or Gemini will reject the next request (400)
- `checkToolCall` takes `{ name }` — for OpenAI-shaped calls that's `chef.checkToolCall({ name: call.function.name })`, not the raw call object

## Reference files

- For the complete API surface and configuration options (including the v3 → v4 migration table), read [references/api-reference.md](references/api-reference.md)
- For full working examples per provider (OpenAI, Anthropic, Gemini), read [references/provider-examples.md](references/provider-examples.md)
