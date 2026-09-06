---
name: integrate
description: "Helps developers integrate the context-chef library into their TypeScript/JavaScript AI agent projects. Use this skill when the user wants to add context-chef to their project, set up context management for LLM calls, integrate history compression or tool management into an agent loop, or asks about wiring context-chef with OpenAI/Anthropic/Gemini. Also trigger when the user mentions 'context-chef', 'context compiler', 'context engineering', or asks how to manage LLM context, compress conversation history, prune tools, or add memory to their AI agent."
argument-hint: "[feature-focus]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# Integrate context-chef

Help the developer add [context-chef](https://github.com/MyPrototypeWhat/context-chef) — a context compiler for AI agents — into their existing project. The goal is to produce working, tailored integration code, not generic boilerplate.

The package is **`@context-chef/core`** (the unscoped `context-chef` name is dead). This skill targets **4.2**. Options marked **(deprecated)** below still work in 4.x and are removed in 5.0 — generate the replacement, not the alias. `MIGRATION-5.md` in the repo has the full list.

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
| Conversations get too long, model forgets things | History compression | Janitor + `overflow.strategy` |
| Compression must never lose policy/constraint text | `pinned: true` on messages | Message |
| Need exact details back after compression | `overflow: { archive: 'vfs' }` + the `context` tool's `view` | Overflow + Store |
| Model should save state before its window is cut | `overflow: { handoff: { budgetTokens } }` | Overflow |
| Model should decide when to start a fresh window | `new_context` + `chef.requestNewContext()` | Overflow |
| On Anthropic, want the provider to compact server-side | `overflow: { strategy: server(cfg, { fallback }) }` | Overflow |
| Too many tools, model hallucinates tool calls | Tool pruning / namespace architecture | Pruner |
| Need to block tools at runtime (permissions, sandboxing) | `setBlockedTools` + `checkToolCall` gate | Pruner |
| Need cross-session memory (user prefs, project rules) | Persistent KV memory | Memory |
| Model needs a scratch space it can read back later | `notes/` namespace via the `context` tool | Store |
| One place for memory, offloaded output and archives | `ChefConfig.store` — one `StorageBackend` | Store |
| Terminal output / API responses too large | Auto-truncation with VFS retrieval | Offloader |
| Mode/phase-scoped behavior ("planning mode") | Skill module | Skill |
| Need to rollback after failed tool calls | Snapshot & restore | Snapshot |
| Switching between OpenAI / Anthropic / Gemini | Multi-provider compilation | Adapters |
| Injecting RAG / external context before LLM calls | `chef.use('before-assemble', ...)` | Pipeline slots |

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
  defaultTarget: "anthropic",   // match their SDK; per-call target overrides this
  /* config based on their needs */
});

// 2. Per-turn: set context → compile → call LLM → feed usage back
chef
  .setSystemPrompt([...])
  .setHistory(conversationHistory)
  .setDynamicState(schema, state);
const payload = await chef.compile();   // or compile({ target: "..." })
```

### Configuration generation rules

Build the `ChefConfig` object based on which features they selected:

**History compression — the runner (Janitor):**
```typescript
janitor: {
  contextWindow: 200000,        // match their model's context window
  // Compression triggers at contextWindow * 0.7 by default ("pre-rot").
  // triggerRatio: 1 restores trigger-at-window.

  // Path A: if they have a tokenizer
  tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(JSON.stringify(m)).length, 0),
  preserveRatio: 0.8,
  // Path B: simpler — call chef.reportTokenUsage() after each LLM call
  preserveRecentMessages: 1,

  compressionModel: async (msgs) => summarizeWithCheapModel(msgs),
  toolResultStubThreshold: 5000,   // stub big tool outputs before summarization
}
```

**History compression — the policy (`overflow.strategy`):** the Janitor evaluates the budget, runs the circuit breaker and fires the events; *what leaves the window* is a strategy object. The default (built from the `janitor` options above) needs no `overflow` block at all. Reach for one when the situation calls for it:

```typescript
import { summarize, anchored, background, chain, reset, server } from "@context-chef/core";

overflow: {
  strategy: anchored({ compressionModel }),   // or summarize / reset / chain / background / server
  archive: 'vfs',                             // whatever a strategy evicts is stored
  handoff: { budgetTokens: 8000 },            // warn the model before its window is cut
}
```

| Situation | Strategy |
|---|---|
| Default — regenerate the summary from the evicted span | `summarize(opts)` |
| Long-running agent where re-summarization drifts | `anchored(opts)` — persistent anchor doc |
| Loop that can't block on a summarizer call | `background(summarize(opts))` |
| Cheap window turnover, keep only pinned | `reset()` — pair with `archive` |
| Escalate when the first declines or is still over budget | `chain(summarize(opts), reset())` |
| Anthropic compacts server-side | `server(cfg, { fallback: summarize(opts) })` |

**(deprecated)** spellings that still work: `janitor.compressionMode` → `summarize()` / `anchored()`; `janitor.compressionScheduling: 'background'` → `background()`; `janitor.archive` → `overflow.archive`; `contextManagement: { strategy: 'server', server }` → `server(server)`. Setting both warns once and the strategy wins.

Failure semantics worth telling the developer: a failed / rejected / non-shrinking compression leaves history **unchanged** and counts toward a circuit breaker (3 consecutive failures = compression disabled until success or `clearHistory()`).

**Tool management (Pruner):**
- < 20 tools → flat mode with `registerTools()` + `pruneByTask()`. `pruneByTask` returns filtered tools without mutating state, so override `payload.tools` with the result.
- 20+ tools → namespace + lazy-loading architecture (automatic via `compile()`).
- Runtime blocking (permissions, sandbox, rate limits) → `chef.getPruner().setBlockedTools(names)`, then gate every LLM tool call with `chef.checkToolCall({ name })` before dispatch and push `check.reason` back as the tool result.
- See `references/api-reference.md` for the two-layer tool architecture details.

**The context store:** one backend behind every namespace — `memory` (durable facts, auto-injected), `notes` (the model's scratch space, read on demand), `vfs` (offloaded tool output), `archive` (compacted spans).
```typescript
import { FileSystemBackend, InMemoryBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context-store"),  // or new InMemoryBackend() in dev
  memory: { defaultTTL: { turns: 20 } },
  vfs: { threshold: 5000 },
});
await chef.getStore().namespace("notes").put("plan.md", "# Plan\n");  // seed / inspect
```
`ChefConfig.store` fills in only what nothing else specifies. Custom persistence means implementing `StorageBackend`, **not** `MemoryStore` / `VFSStorageAdapter` — both **(deprecated)**, along with `InMemoryStore`, `VFSMemoryStore` and `FileSystemAdapter` (`InMemoryBackend` / `FileSystemBackend` replace them).

**Library-owned tools (`tools` mode):**
- `'legacy'` (default in 4.x): Memory's `create_memory` / `modify_memory`, and only when memory is configured.
- `'unified'`: one `context` tool over every namespace (`view` / `create` / `str_replace` / `insert` / `delete` / `rename` / `search` on `context://<ns>/<path>`), plus `new_context` when `overflow.handoff` is set. The two sets never co-exist, and `'unified'` also switches the prompt wording to match.

Prefer `tools: 'unified'` for new integrations. `'unified'` becomes the default in 5.0.

**Pipeline slots** — `chef.use(slot, handler)` / `chef.unuse(slot, handler)`, handlers run in registration order:

| Slot | Use for |
|---|---|
| `before-overflow` | veto overflow this compile (return `false`), observe the real budget |
| `after-overflow` | react to what was evicted |
| `before-assemble` | RAG / AST / MCP injection via `ctx.inject(text)` |
| `after-assemble` | rewrite the assembled sandwich (handlers chain) |
| `before-adapt` / `after-adapt` | observe the final IR / the compiled payload |

```typescript
chef.use("before-assemble", async (ctx) => {
  const results = await vectorDB.search(ctx.dynamicStateXml);
  if (results.length) ctx.inject(results.map(r => r.content).join("\n"));
});
```
`ChefConfig.onBeforeCompile` / `transformContext` are **(deprecated)** aliases that register on `before-assemble` / `after-assemble`. Generate `use()` for new code. In development, `pipelineChecks: true` reports (never throws on) dropped pinned messages, split tool pairs and rewritten prefix bytes.

### Agent loop integration

This is the most critical part. Find their existing agent loop and show exactly where context-chef calls go:

```typescript
// BEFORE the loop: initialize chef (once per conversation)
const chef = new ContextChef({ ... });

// INSIDE the loop, BEFORE each LLM call:
chef.setSystemPrompt([...]).setHistory(history).setDynamicState(schema, state);
const payload = await chef.compile({ target: "..." });
const response = await llm.call(payload);

// AFTER each LLM call:
chef.reportTokenUsage(response.usage.prompt_tokens);  // input_tokens on Anthropic

// IN the tool handling section:
for (const call of response.tool_calls ?? []) {
  const check = chef.checkToolCall({ name: call.function.name });
  if (!check.allowed) {
    history.push({ role: "tool", tool_call_id: call.id, content: check.reason });
    continue;
  }
  // One entry point for every library-owned tool: `context`, `new_context`, and
  // the legacy create_memory / modify_memory / recall_context. Mode-independent,
  // so it survives the 5.0 flip to tools: 'unified'.
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,   // JSON string or already-parsed object
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
    continue;
  }
  const result = await runMyTool(call);
  history.push({ role: "tool", tool_call_id: call.id, content: chef.offload(result) });
}
```

Also route `load_skill` to `chef.activateSkill(name)` if skills are enabled, and `chef.getPruner().isNamespaceCall()` if using namespace tools.

For provider-specific examples, read `references/provider-examples.md`.

## Step 5: Verify and explain

After generating the code:

1. Verify imports — `ContextChef`, `InMemoryBackend`, `FileSystemBackend`, `loadSkillsDir`, `getContextToolDefinition`, the overflow factories (`summarize` / `anchored` / `background` / `chain` / `reset` / `server`) all come from `"@context-chef/core"`. Flag any **(deprecated)** alias where a replacement exists.
2. Verify the compile target matches their SDK (`"openai"` for chat completions, `"openai-responses"` for the Responses API, `"anthropic"` for @anthropic-ai/sdk, `"gemini"` for @google/generative-ai).
3. Explain the "sandwich model" briefly: system prompt (cached, stable) → active skill → memory → compressed history → dynamic state (injected into the last user message for recency bias) → guardrails.
4. Point out `_cache_breakpoint: true` on system prompt messages — this enables Anthropic's prompt caching and is harmless on other providers.
5. Mention that compression triggers at 70% of `contextWindow` by default.
6. If they set `tools: 'unified'`, mention the payload carries `context` instead of the memory tools and the prompt wording changes with it — a one-time cache-prefix invalidation on the switch.

## Key API patterns to remember

- **Builder pattern**: all setter methods return `this` for chaining
- **compile() is async**: it triggers compression and memory sweeping; concurrent `compile()` calls on one instance are queued, but the canonical pattern is one chef per concurrent conversation (see `SessionPool`)
- **compile() returns SDK-ready payloads**: pass directly to the provider's SDK — for Anthropic it separates `system` from `messages` automatically
- **Target resolution**: `compile({ target })` → `ChefConfig.defaultTarget` → `'openai'`
- **reportTokenUsage()**: call after every LLM response to enable token-based compression
- **Dynamic state uses Zod schemas**: validated and converted to XML tags LLMs parse efficiently
- **Placement matters**: `'last_user'` (default) injects state into the last user message for recency bias; `'system'` places it as a standalone system message
- **One dispatcher for library tools**: `chef.ownsTool(name)` → `chef.handleTool(call)`, in every `tools` mode
- **Events** are error-isolated (`chef.on(...)`); **slot handlers are not** — they are composition points, and their errors propagate out of `compile()`

## Common mistakes to prevent

- Don't forget `reportTokenUsage()` — without it, compression won't trigger (unless using the tokenizer path)
- Don't mutate the compiled payload — it's provider-formatted and ready to use (overriding `payload.tools` with a pruned list is the sanctioned exception)
- Don't create a new `ContextChef` per turn — reuse it across the conversation, one instance per concurrent conversation
- Don't hand-branch on library tool names — `ownsTool` + `handleTool` is the one entry point, and it is what makes the 5.0 default flip a no-op
- Don't set both an `overflow.strategy` and the deprecated `janitor.compressionMode` / `compressionScheduling` / `archive` / `contextManagement` aliases
- Don't use `server()` without a `fallback` if the host also compiles for non-Anthropic targets — those targets get no compression at all
- Don't `compact({ clear: ['tool-result'] })` before LLM compression — use `toolResultStubThreshold` instead
- For Anthropic with extended thinking, pass `thinking` and `redacted_thinking` on assistant messages — context-chef maps them to the correct Anthropic format
- For Gemini 3.x, thought signatures on function calls (`ToolCall.thoughtSignature`) round-trip automatically — don't strip unknown fields from tool calls or Gemini rejects the next request (400)
- `checkToolCall` takes `{ name }` — for OpenAI-shaped calls that's `chef.checkToolCall({ name: call.function.name })`, not the raw call object

## Reference files

- For the complete API surface and configuration options, read [references/api-reference.md](references/api-reference.md)
- For full working examples per provider (OpenAI, Anthropic, Gemini), read [references/provider-examples.md](references/provider-examples.md)
