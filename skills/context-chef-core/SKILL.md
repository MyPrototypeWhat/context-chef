---
name: context-chef-core
description: "Helps developers integrate @context-chef/core into their TypeScript/JavaScript AI agent projects. Use this skill when the user wants to add context-chef to their project, set up context management for LLM calls, integrate history compression or tool management into an agent loop, or asks about wiring context-chef with OpenAI/Anthropic/Gemini. Also trigger when the user mentions 'context-chef', 'context compiler', 'context engineering', or asks how to manage LLM context, compress conversation history, prune tools, or add memory to their AI agent."
argument-hint: "[feature-focus]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# Integrate @context-chef/core

Help the developer add [@context-chef/core](https://github.com/MyPrototypeWhat/context-chef) — a context compiler for AI agents — into their existing project. The goal is to produce working, tailored integration code, not generic boilerplate.

## Step 1: Analyze the developer's project

Before asking questions, silently inspect the project to understand what they already have:

```
1. package.json → detect LLM SDK (openai, @anthropic-ai/sdk, @google/generative-ai)
2. Lock file → detect package manager (pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm, bun.lockb → bun)
3. tsconfig.json → TypeScript or JavaScript?
4. Existing agent loop code → look for patterns like:
   - openai.chat.completions.create
   - anthropic.messages.create
   - model.generateContent
   - Any while/for loop that calls an LLM repeatedly
```

Use Glob + Grep to find these. Search in `src/`, `lib/`, `app/`, and root-level files. This context shapes everything you generate — the provider target, the import style, the loop structure.

## Step 2: Ask about their needs

Based on what you found, present a brief summary of their setup and ask which context-chef features they need. Frame the question around their pain points, not abstract module names:

| Pain point | context-chef feature | Module |
|---|---|---|
| Conversations get too long, model forgets things | History compression | Janitor |
| Too many tools, model hallucinates tool calls | Tool pruning / namespace architecture | Pruner |
| Need cross-session memory (user prefs, project rules) | Persistent KV memory | Memory |
| Terminal output / API responses too large | Auto-truncation with VFS retrieval | Offloader |
| Need to rollback after failed tool calls | Snapshot & restore | Snapshot |
| Switching between OpenAI / Anthropic / Gemini | Multi-provider compilation | Adapters |
| Injecting RAG / external context before LLM calls | onBeforeCompile hook | Hook |
| Want cheaper compression before LLM summarization | Mechanical compaction (compact) | Janitor |

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

// 1. Initialize once
const chef = new ContextChef({ /* config based on their needs */ });

// 2. Per-turn: set context → compile → call LLM → feed usage back
chef
  .setSystemPrompt([...])
  .setHistory(conversationHistory)
  .setDynamicState(schema, state)
  .compile({ target: "anthropic" | "openai" | "gemini" });
```

### Configuration generation rules

Build the `ChefConfig` object based on which features they selected:

**History compression (Janitor):**
```typescript
janitor: {
  contextWindow: 128000, // match their model's context window
  // Path A: if they have a tokenizer
  tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
  preserveRatio: 0.8,
  // Path B: simpler, use reportTokenUsage() after each LLM call
  preserveRecentMessages: 1,
  // Always recommend a compression model
  compressionModel: async (msgs) => {
    // call a cheap model (gpt-4o-mini, haiku, etc.) to summarize old messages
  },
}
```

**Tool management (Pruner):**
- If they have < 20 tools → use flat mode with `registerTools()` + `pruneByTask()`
  - **Important**: `pruneByTask()` returns filtered tools but doesn't modify internal state. `compile()` always includes ALL registered tools. The developer must manually override `payload.tools` with the pruned result:
    ```typescript
    const pruned = chef.getPruner().pruneByTask("read a file");
    const payload = await chef.compile({ target: "anthropic" });
    payload.tools = pruned.tools; // override with filtered tools
    ```
- If they have 20+ tools → recommend namespace + lazy loading architecture (automatic via `compile()`)
- See `references/api-reference.md` for the two-layer tool architecture details

**Memory:**
```typescript
memory: {
  store: new InMemoryStore(),     // for development
  // store: new VFSMemoryStore(dir), // for production persistence
  defaultTTL: { turns: 20 },
}
```

**VFS Offloader:**
```typescript
vfs: {
  threshold: 5000,  // characters; truncate content longer than this
}
```

**Hooks — recommend based on their use case:**

If they need RAG/AST/MCP injection, add `onBeforeCompile`:
```typescript
onBeforeCompile: async (ctx) => {
  // ctx.dynamicStateXml contains the serialized task state — useful as a search query
  const results = await vectorDB.search(ctx.dynamicStateXml);
  return results.map(r => r.content).join("\n");
  // Injected as <implicit_context> alongside dynamic state. Return null to skip.
},
```

If they want to try cheaper compression before LLM summarization, recommend the `onBudgetExceeded` + `compact()` pattern:
```typescript
import { Janitor } from "@context-chef/core";
const compactJanitor = new Janitor({ contextWindow: Infinity });

// In ChefConfig:
janitor: {
  contextWindow: 200000,
  compressionModel: async (msgs) => summarize(msgs),
  onBudgetExceeded: (history) => {
    // First pass: mechanically strip tool results (zero LLM cost)
    return compactJanitor.compact(history, { clear: ['tool-result'] });
    // If still over budget, Janitor's LLM compression proceeds automatically
  },
}
```

If they need to transform the final message array (e.g. normalize formats, inject metadata), add `transformContext`:
```typescript
transformContext: (messages) => {
  // Called after assembly, before adapter formatting
  // Full message array: system + memory + history + dynamic state
  return messages;
},
```

### Agent loop integration

This is the most critical part. Find their existing agent loop and show exactly where context-chef calls go. The pattern is:

```typescript
// BEFORE the loop: initialize chef
const chef = new ContextChef({ ... });

// INSIDE the loop, BEFORE each LLM call:
chef.setSystemPrompt([...]).setHistory(history).setDynamicState(schema, state);
const payload = await chef.compile({ target: "..." });
const response = await llm.call(payload);

// AFTER each LLM call:
chef.reportTokenUsage(response.usage.prompt_tokens); // or input_tokens for Anthropic

// IN the tool handling section:
// - Handle memory tool calls (create_memory, modify_memory) if memory is enabled
// - Use chef.offload() for large tool results if VFS is enabled
// - Use chef.getPruner().isNamespaceCall() if using namespace tools
```

For provider-specific examples, read `references/provider-examples.md`.

## Step 5: Verify and explain

After generating the code:

1. Verify imports are correct — `ContextChef`, `InMemoryStore`, `VFSMemoryStore` all come from `"@context-chef/core"`
2. Verify the compile target matches their SDK (`"openai"` for openai, `"anthropic"` for @anthropic-ai/sdk, `"gemini"` for @google/generative-ai)
3. Explain the "sandwich model" briefly: system prompt (cached, stable) → memory → compressed history → dynamic state (injected into last user message for recency bias)
4. Point out the `_cache_breakpoint: true` flag on system prompt messages — this enables Anthropic's prompt caching and is harmless on other providers

## Key API patterns to remember

- **Builder pattern**: All setter methods return `this` for chaining
- **compile() is async**: It triggers Janitor compression and memory sweeping
- **compile() returns SDK-ready payloads**: Pass directly to the provider's SDK — for Anthropic, it separates `system` from `messages` automatically
- **reportTokenUsage()**: Call after every LLM response to enable token-based compression
- **Dynamic state uses Zod schemas**: The state is validated and converted to XML tags that LLMs parse efficiently
- **Placement matters**: `'last_user'` (default) injects state into the last user message for recency bias; `'system'` places it as a standalone system message

## Common mistakes to prevent

- Don't forget to call `reportTokenUsage()` — without it, history compression won't trigger (unless using the tokenizer path)
- Don't mutate the compiled payload — it's provider-formatted and ready to use
- Don't create a new `ContextChef` instance per turn — reuse it across the conversation
- When using Memory, intercept `create_memory` and `modify_memory` tool calls in the agent loop — these are auto-injected tools the LLM will call
- For Anthropic with extended thinking, pass `thinking` and `redacted_thinking` fields on assistant messages — context-chef maps them to the correct Anthropic format

## Reference files

- For the complete API surface and configuration options, read [references/api-reference.md](references/api-reference.md)
- For full working examples per provider (OpenAI, Anthropic, Gemini), read [references/provider-examples.md](references/provider-examples.md)
