# ContextChef

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/core Downloads](https://img.shields.io/npm/dm/@context-chef/core.svg?label=%40context-chef%2Fcore%20downloads)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/ai-sdk-middleware Downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg?label=%40context-chef%2Fai-sdk-middleware%20downloads)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![@context-chef/tanstack-ai Downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg?label=%40context-chef%2Ftanstack-ai%20downloads)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/core.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="./ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

Context compiler for TypeScript/JavaScript AI agents.

ContextChef solves the most common context engineering problems in AI agent development: conversations too long for the model to remember, too many tools causing hallucinations, having to rewrite prompts when switching providers, and state drift in long-running tasks. It doesn't take over your control flow — it just compiles your state into an optimal payload before each LLM call.

[中文文档](./README.zh-CN.md)

## Packages

| Package | Description |
|---|---|
| [`@context-chef/core`](./packages/core) | Core context compiler — history compression, tool pruning, memory, VFS offloading, multi-provider adapters |
| [`@context-chef/ai-sdk-middleware`](./packages/ai-sdk-middleware) | [Vercel AI SDK](https://sdk.vercel.ai) middleware — drop-in context engineering with zero code changes |
| [`@context-chef/tanstack-ai`](./packages/tanstack-ai) | [TanStack AI](https://tanstack.com/ai) middleware — compression, truncation, and dynamic state via `ChatMiddleware` |

### Zero-config AI SDK integration

If you use the Vercel AI SDK, you can get transparent history compression and tool result truncation with just 2 lines:

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000 },
});

// Everything below stays exactly the same
const result = await generateText({ model, messages, tools });
```

See the [`@context-chef/ai-sdk-middleware` README](./packages/ai-sdk-middleware/README.md) for full documentation.

### TanStack AI middleware

If you use TanStack AI, drop in the middleware for transparent context management:

```typescript
import { contextChefMiddleware } from '@context-chef/tanstack-ai';
import { chat } from '@tanstack/ai';
import { openaiText } from '@tanstack/ai-openai';

const stream = chat({
  adapter: openaiText('gpt-4o'),
  messages,
  middleware: [
    contextChefMiddleware({
      contextWindow: 128_000,
      compress: { adapter: openaiText('gpt-4o-mini') },
      truncate: { threshold: 5000 },
    }),
  ],
});
```

See the [`@context-chef/tanstack-ai` README](./packages/tanstack-ai/README.md) for full documentation.

### Full control with `@context-chef/core`

For direct control over the compilation pipeline — dynamic state injection, tool namespaces, memory, snapshot/restore — use the core library directly:

## Blog Series

1. [Why "Compile" Your Context](https://myprototypewhat.cn/context-chef-1-why-compile-context-en)
2. [Janitor — Separating Trigger Logic from Compression Policy](https://myprototypewhat.cn/context-chef-2-janitor-en)
3. [Pruner — Decoupling Tool Registration from Routing](https://myprototypewhat.cn/context-chef-3-pruner-en)
4. [Offloader/VFS — Relocate Information, Don't Destroy It](https://myprototypewhat.cn/context-chef-4-offloader-vfs-en)
5. [Core Memory — Zero-Cost Reads, Structured Writes](https://myprototypewhat.cn/context-chef-5-core-memory-en)
6. [Snapshot & Restore — Capture Everything That Determines the Next Compile](https://myprototypewhat.cn/context-chef-6-snapshot-en)
7. [The Provider Adapter Layer — Let Differences Stop at Compile Time](https://myprototypewhat.cn/context-chef-7-adapters-en)
8. [Five Extension Points in the Compile Pipeline](https://myprototypewhat.cn/context-chef-8-hooks-en)

## Features

- **Conversations too long?** — Automatically compress history, preserve recent memory, delegate old messages to a small model for summarization
- **Too many tools?** — Dynamically prune the tool list per task, or use a two-layer architecture (stable namespaces + on-demand loading) to eliminate tool hallucinations
- **Switching providers?** — Same prompt architecture compiles to OpenAI / Anthropic / Gemini with automatic prefill, cache, and tool call format adaptation
- **Long tasks drifting?** — Zod schema-based state injection forces the model to stay aligned with the current task on every call
- **Terminal output too large?** — Auto-truncate and offload to VFS, keeping error lines + a `context://` URI pointer for on-demand retrieval
- **Can't remember across sessions?** — Memory lets the model persist key information (project rules, user preferences) via tool calls, auto-injected on the next session
- **Need to rollback?** — Snapshot & Restore captures and rolls back full context state for branching and exploration
- **Need external context?** — `onBeforeCompile` hook lets you inject RAG results, AST snippets, or MCP queries before compilation
- **Need observability?** — Unified event system (`chef.on('compress', ...)`) for logging, metrics, and debugging across all internal modules

## Installation

```bash
npm install @context-chef/core zod
```

## Quick Start

```typescript
import { ContextChef } from "@context-chef/core";
import { z } from "zod";

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

const payload = await chef
  .setSystemPrompt([
    {
      role: "system",
      content: "You are an expert coder.",
      _cache_breakpoint: true,
    },
  ])
  .setHistory(conversationHistory)
  .setDynamicState(TaskSchema, {
    activeFile: "auth.ts",
    todo: ["Fix login bug"],
  })
  .withGuardrails({
    enforceXML: { outputTag: "response" },
    prefill: "<thinking>\n1.",
  })
  .compile({ target: "anthropic" });

const response = await anthropic.messages.create(payload);
```

---

## API Reference

### `new ContextChef(config?)`

```typescript
const chef = new ContextChef({
  vfs?: { threshold?: number, storageDir?: string },
  janitor?: JanitorConfig,
  pruner?: { strategy?: 'union' | 'intersection' },
  memory?: MemoryConfig,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>,
});
```

### Context Building

#### `chef.setSystemPrompt(messages): this`

Sets the static system prompt layer. Cached prefix — should rarely change.

```typescript
chef.setSystemPrompt([
  {
    role: "system",
    content: "You are an expert coder.",
    _cache_breakpoint: true,
  },
]);
```

`_cache_breakpoint: true` tells the Anthropic adapter to inject `cache_control: { type: 'ephemeral' }`.

#### `chef.setHistory(messages): this`

Sets the conversation history. Janitor compresses automatically on `compile()`.

#### `chef.setDynamicState(schema, data, options?): this`

Injects Zod-validated state as XML into the context.

```typescript
const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

chef.setDynamicState(TaskSchema, { activeFile: "auth.ts", todo: ["Fix bug"] });
// placement defaults to 'last_user' (injected into the last user message)
// use { placement: 'system' } for a standalone system message
```

#### `chef.withGuardrails(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
});
```

#### `chef.compile(options?): Promise<TargetPayload>`

Compiles everything into a provider-ready payload. Triggers Janitor compression. Registered tools are auto-included.

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

---

### History Compression (Janitor)

Janitor provides two compression paths. Choose the one that fits your setup:

#### Path 1: Tokenizer (precise control)

Provide your own token counting function for precise per-message calculation. Janitor preserves recent messages that fit within `contextWindow × preserveRatio` and compresses the rest.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8, // keep 80% of contextWindow for recent messages (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count) => {
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

#### Path 2: reportTokenUsage (simple, no tokenizer needed)

Most LLM APIs return token usage in their response. Feed that value back — when it exceeds `contextWindow`, Janitor compresses everything except the last N messages.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    preserveRecentMessages: 1,       // keep last 1 message on compression (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

> **Note:** Without a `compressionModel`, old messages are discarded with no summary. A console warning is printed at construction time if neither `tokenizer` nor `compressionModel` is provided.

#### `JanitorConfig`

| Option                          | Type                                        | Default    | Description                                                                                  |
| ------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `contextWindow`                 | `number`                                    | _required_ | Model's context window size (tokens). Compression triggers when usage exceeds this.          |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —          | Enables the tokenizer path for precise per-message token calculation.                        |
| `preserveRatio`                 | `number`                                    | `0.8`      | [Tokenizer path] Ratio of `contextWindow` to preserve for recent messages.                   |
| `preserveRecentMessages`        | `number`                                    | `1`        | [reportTokenUsage path] Number of recent turns to keep when compressing.                     |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —          | Async hook to summarize old messages via a low-cost LLM.                                     |
| `customCompressionInstructions` | `string`                                    | —          | Additional focused instructions appended to the default compression prompt (additive, not replacement). |
| `onCompress`                    | `(summary, count) => void`                  | —          | Fires after compression with the summary message and truncated count.                        |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —          | Fires before LLM compression. Return modified history to intervene, or null to proceed normally. |

**Compression output contract.** Janitor's default prompt instructs the compression model to produce an `<analysis>` scratchpad (stripped from the final output) followed by a structured `<summary>` block with 5 domain-agnostic sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Raw output is piped through `Prompts.formatCompactSummary` before injection. See the [core package README](./packages/core) for the full contract and `customCompressionInstructions` usage.

**Circuit breaker.** If `compressionModel` throws three times in a row, `compress()` becomes a no-op until the next successful compression or an explicit `janitor.reset()` / `chef.clearHistory()`. The failure counter is preserved by `chef.snapshot()` / `chef.restore()`.

#### `chef.reportTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds `contextWindow`, compression is triggered. In the tokenizer path, the higher of the local calculation and the fed value is used.

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

#### `onBeforeCompress` hook

Fires when the token budget is exceeded, **before** LLM compression. Return a modified `Message[]` to replace the history, or return `null` to let default compression proceed.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBeforeCompress: (history, { currentTokens, limit }) => {
      // Example: offload large tool results to VFS before compression
      return history.map((msg) =>
        msg.role === "tool" && msg.content.length > 5000
          ? { ...msg, content: pointer.offload(msg.content).content }
          : msg,
      );
    },
  },
});
```

#### Mechanical Compaction (`compact`)

Strip content from history at zero LLM cost. Use proactively in your agent loop to keep context lean.

```typescript
// Clear all tool results and thinking blocks
history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

// Keep the 5 most recent tool results, clear the rest (min: 1)
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// Combine: clear old tool results + all thinking
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }, 'thinking'],
});
```

#### `ensureValidHistory(history)`

Standalone utility that sanitizes message history to satisfy LLM API invariants (tool pair completeness, message alternation). Use when loading history from a database or after manual modifications.

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

#### `chef.clearHistory(): this`

Explicitly clear history and reset Janitor state when switching topics or completing sub-tasks.

---

### Large Output Offloading (Offloader / VFS)

```typescript
// Offload if content exceeds threshold; preserves last 2000 chars by default
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: original content if small, or truncated with context://vfs/ URI

// Preserve head (first 500 chars) + tail (last 1000 chars), snapped to line boundaries
const safeOutput = chef.offload(content, { headChars: 500, tailChars: 1000 });

// No preview content — just truncation notice + URI
const safeDoc = chef.offload(largeFileContent, { headChars: 0, tailChars: 0 });

// Override threshold per call
const safeOutput2 = chef.offload(content, { threshold: 2000, tailChars: 500 });
```

Register a tool for the LLM to read full content when needed:

```typescript
// In your tool handler:
import { Offloader } from "@context-chef/core";
const offloader = new Offloader({ storageDir: ".context_vfs" });
const fullContent = offloader.resolve(uri);
```

---

### Tool Management (Pruner)

#### Flat Mode

```typescript
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "run_bash", description: "Run a command", tags: ["shell"] },
  {
    name: "get_time",
    description: "Get timestamp" /* no tags = always kept */,
  },
]);

const { tools, removed } = chef.getPruner().pruneByTask("Read the auth.ts file");
// tools: [read_file, get_time]
```

Also supports `allowOnly(names)` and `pruneByTaskAndAllowlist(task, names)`.

#### Namespace + Lazy Loading (Two-Layer Architecture)

**Layer 1 — Namespaces**: Core tools grouped into stable tool definitions. The tool list never changes across turns.

**Layer 2 — Lazy Loading**: Long-tail tools registered as a lightweight XML directory. The LLM loads full schemas on demand via `load_toolkit`.

```typescript
// Layer 1: Stable namespace tools
chef.registerNamespaces([
  {
    name: "file_ops",
    description: "File system operations",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { path: { type: "string" } },
      },
      {
        name: "write_file",
        description: "Write to a file",
        parameters: { path: { type: "string" }, content: { type: "string" } },
      },
    ],
  },
  {
    name: "terminal",
    description: "Shell command execution",
    tools: [
      {
        name: "run_bash",
        description: "Execute a command",
        parameters: { command: { type: "string" } },
      },
    ],
  },
]);

// Layer 2: On-demand toolkits
chef.registerToolkits([
  {
    name: "Weather",
    description: "Weather forecast APIs",
    tools: [
      /* ... */
    ],
  },
  {
    name: "Database",
    description: "SQL query and schema inspection",
    tools: [
      /* ... */
    ],
  },
]);

// Compile — tools: [file_ops, terminal, load_toolkit] (always stable)
const { tools, directoryXml } = chef.getPruner().compile();
// directoryXml: inject into system prompt so LLM knows available toolkits
```

**Agent Loop integration:**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.getPruner().isNamespaceCall(toolCall)) {
    // Route namespace call to real tool
    const { toolName, args } = chef.getPruner().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.getPruner().isToolkitLoader(toolCall)) {
    // LLM requested a toolkit — expand and re-call
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.getPruner().extractToolkit(parsed.toolkit_name);
    // Merge newTools into the next LLM request
  }
}
```

---

### Memory

Persistent key-value memory that survives across sessions. Memory is modified via tool calls (`create_memory` / `modify_memory`), which are auto-injected into the payload on `compile()`.

```typescript
import { InMemoryStore, VFSMemoryStore } from "@context-chef/core";

const chef = new ContextChef({
  memory: {
    store: new InMemoryStore(), // ephemeral (testing)
    // store: new VFSMemoryStore(dir),   // persistent (production)
  },
});

// In your agent loop, intercept memory tool calls:
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") {
      await chef.getMemory().updateMemory(key, value, description);
    } else {
      await chef.getMemory().deleteMemory(key);
    }
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");

// On compile():
// - Memory tools (create_memory, modify_memory) are auto-injected into payload.tools
// - Existing memories are injected as <memory> XML between systemPrompt and history
```

---

### Snapshot & Restore

Capture and rollback full context state for branching or error recovery.

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

---

### Lifecycle Events

Unified event system for observability across all internal modules. Subscribe via `chef.on()`, unsubscribe via `chef.off()`.

```typescript
// Log when history gets compressed
chef.on('compress', ({ summary, truncatedCount }) => {
  console.log(`Compressed ${truncatedCount} messages`);
});

// Track compile metrics
chef.on('compile:done', ({ payload }) => {
  metrics.track('compile', { messageCount: payload.messages.length });
});

// Monitor memory changes
chef.on('memory:changed', ({ type, key, value }) => {
  console.log(`Memory ${type}: ${key}`);
});
```

#### Available Events

| Event | Payload | Description |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | Emitted at the start of `compile()` |
| `compile:done` | `{ payload }` | Emitted after `compile()` produces the final payload |
| `compress` | `{ summary, truncatedCount }` | Emitted after Janitor compresses history |
| `memory:changed` | `{ type, key, value, oldValue }` | Emitted after any memory mutation (set, delete, expire) |
| `memory:expired` | `MemoryEntry` | Emitted when a memory entry expires during `compile()` |

Events are **observation-only** — they don't affect control flow. Intercept hooks (`onBeforeCompress`, `onMemoryUpdate`, `onBeforeCompile`, `transformContext`) remain as config callbacks.

Events coexist with existing config callbacks: if you provide `onCompress` in `JanitorConfig`, it fires first, then the `compress` event is emitted.

---

### `onBeforeCompile` Hook

Inject external context (RAG, AST snippets, MCP queries) right before compilation without modifying the message array.

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.dynamicStateXml);
    return snippets.map((s) => s.content).join("\n");
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```

---

### Input Adapters (Provider → IR)

Convert OpenAI / Anthropic / Gemini native messages to ContextChef IR, automatically separating system and history:

```typescript
import { fromOpenAI, fromAnthropic, fromGemini } from "@context-chef/core";

// OpenAI
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);

// Anthropic (system is a separate top-level parameter)
const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
chef.setSystemPrompt(system).setHistory(history);

// Gemini (systemInstruction is a separate top-level parameter)
const { system, history } = fromGemini(geminiContents, systemInstruction);
chef.setSystemPrompt(system).setHistory(history);
```

Multimodal content (images, files) is automatically converted to IR `attachments`:

| Provider Format | IR Field |
|---|---|
| OpenAI `image_url` / `file` | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document` | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` converts `attachments` back to the corresponding provider format. During compression, Janitor guides the compression model to describe image content.

---

### Target Adapters

| Feature                      | OpenAI                      | Anthropic                              | Gemini                                     |
| ---------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions            | Messages API                           | generateContent                            |
| Cache breakpoints            | Stripped                    | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support                         | Degraded to `[System Note]`                |
| `thinking` field             | Stripped                    | Mapped to `ThinkingBlockParam`         | Stripped                                   |
| Tool calls                   | `tool_calls` array          | `tool_use` blocks                      | `functionCall` parts                       |
| `attachments`                | `image_url` / `file` content parts | `image` / `document` blocks   | `inlineData` / `fileData` parts            |

Adapters are selected automatically by `compile({ target })`. You can also use them standalone:

```typescript
import { getAdapter } from "@context-chef/core";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

---

## Skills

ContextChef provides [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills) that help you integrate the library into your project interactively. Each skill analyzes your existing codebase and generates tailored integration code.

| Skill | Description |
|---|---|
| `context-chef-core` | Integrate `@context-chef/core` — full control over compilation pipeline, multi-provider support |
| `context-chef-middleware` | Integrate `@context-chef/ai-sdk-middleware` — drop-in AI SDK middleware, zero code changes |
| `context-chef-tanstack` | Integrate `@context-chef/tanstack-ai` — TanStack AI ChatMiddleware with compression and state injection |

### Install

Install only what you need:

```bash
# Core library (OpenAI / Anthropic / Gemini direct SDK usage)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK middleware (Vercel AI SDK v6+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# TanStack AI middleware (TanStack AI v0.10+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-tanstack

# All
npx skills add MyPrototypeWhat/context-chef
```

### Use

Open [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) in your project and type:

```
/context-chef-core
# or
/context-chef-middleware
```

Claude will:

1. **Detect your setup** — LLM SDK, package manager, TypeScript vs JavaScript
2. **Ask about your needs** — history compression, tool management, truncation, memory, etc.
3. **Generate integration code** — tailored to your project structure and existing agent loop
4. **Explain the architecture** — processing pipeline, cache breakpoints, dynamic state placement
