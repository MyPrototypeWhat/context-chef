# ContextChef

Context compiler for TypeScript/JavaScript AI agents.

ContextChef solves the most common context engineering problems in AI agent development: conversations too long for the model to remember, too many tools causing hallucinations, having to rewrite prompts when switching providers, and state drift in long-running tasks. It doesn't take over your control flow — it just compiles your state into an optimal payload before each LLM call.

[中文文档](./README.zh-CN.md)

## Features

- **Conversations too long?** — Automatically compress history, preserve recent memory, delegate old messages to a small model for summarization
- **Too many tools?** — Dynamically prune the tool list per task, or use a two-layer architecture (stable namespaces + on-demand loading) to eliminate tool hallucinations
- **Switching providers?** — Same prompt architecture compiles to OpenAI / Anthropic / Gemini with automatic prefill, cache, and tool call format adaptation
- **Long tasks drifting?** — Zod schema-based state injection forces the model to stay aligned with the current task on every call
- **Terminal output too large?** — Auto-truncate and offload to VFS, keeping error lines + a `context://` URI pointer for on-demand retrieval
- **Can't remember across sessions?** — Core Memory lets the model persist key information (project rules, user preferences) that auto-injects on the next session
- **Need to rollback?** — Snapshot & Restore captures and rolls back full context state for branching and exploration
- **Need external context?** — `onBeforeCompile` hook lets you inject RAG results, AST snippets, or MCP queries before compilation

## Installation

```bash
npm install context-chef zod
```

## Quick Start

```typescript
import { ContextChef } from "context-chef";
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
  .setTopLayer([
    {
      role: "system",
      content: "You are an expert coder.",
      _cache_breakpoint: true,
    },
  ])
  .useRollingHistory(conversationHistory)
  .setDynamicState(TaskSchema, {
    activeFile: "auth.ts",
    todo: ["Fix login bug"],
  })
  .withGovernance({
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
  memoryStore?: MemoryStore,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>,
});
```

### Context Building

#### `chef.setTopLayer(messages): this`

Sets the static system prompt layer. Cached prefix — should rarely change.

```typescript
chef.setTopLayer([
  {
    role: "system",
    content: "You are an expert coder.",
    _cache_breakpoint: true,
  },
]);
```

`_cache_breakpoint: true` tells the Anthropic adapter to inject `cache_control: { type: 'ephemeral' }`.

#### `chef.useRollingHistory(messages): this`

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

#### `chef.withGovernance(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGovernance({
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

#### Path 2: feedTokenUsage (simple, no tokenizer needed)

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
chef.feedTokenUsage(response.usage.prompt_tokens);
```

> **Note:** Without a `compressionModel`, old messages are discarded with no summary. A console warning is printed at construction time if neither `tokenizer` nor `compressionModel` is provided.

#### `JanitorConfig`

| Option                   | Type                                        | Default    | Description                                                                                  |
| ------------------------ | ------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `contextWindow`          | `number`                                    | _required_ | Model's context window size (tokens). Compression triggers when usage exceeds this.          |
| `tokenizer`              | `(msgs: Message[]) => number`               | —          | Enables the tokenizer path for precise per-message token calculation.                        |
| `preserveRatio`          | `number`                                    | `0.8`      | [Tokenizer path] Ratio of `contextWindow` to preserve for recent messages.                   |
| `preserveRecentMessages` | `number`                                    | `1`        | [feedTokenUsage path] Number of recent messages to keep when compressing.                    |
| `compressionModel`       | `(msgs: Message[]) => Promise<string>`      | —          | Async hook to summarize old messages via a low-cost LLM.                                     |
| `onCompress`             | `(summary, count) => void`                  | —          | Fires after compression with the summary message and truncated count.                        |
| `onBudgetExceeded`       | `(history, tokenInfo) => Message[] \| null` | —          | Fires before compression. Return modified history to intervene, or null to proceed normally. |

#### `chef.feedTokenUsage(tokenCount): this`

Feed the API-reported token count. On the next `compile()`, if this value exceeds `contextWindow`, compression is triggered. In the tokenizer path, the higher of the local calculation and the fed value is used.

```typescript
const response = await openai.chat.completions.create({ ... });
chef.feedTokenUsage(response.usage.prompt_tokens);
```

#### `onBudgetExceeded` hook

Fires when the token budget is exceeded, **before** automatic compression. Return a modified `Message[]` to replace the history (e.g., offload tool results to VFS), or return `null` to let default compression proceed.

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBudgetExceeded: (history, { currentTokens, limit }) => {
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

#### `chef.clearRollingHistory(): this`

Explicitly clear history and reset Janitor state when switching topics or completing sub-tasks.

---

### Large Output Offloading (Pointer / VFS)

```typescript
// Offload if content exceeds threshold; preserves last 20 lines by default
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: original content if small, or truncated with context://vfs/ URI

// Customize tail lines preserved (0 = no tail, like a static document)
const safeDoc = chef.offload(largeFileContent, { tailLines: 0 });

// Override threshold per call
const safeOutput = chef.offload(content, { threshold: 2000, tailLines: 50 });
```

Register a tool for the LLM to read full content when needed:

```typescript
// In your tool handler:
import { Pointer } from "context-chef";
const pointer = new Pointer({ storageDir: ".context_vfs" });
const fullContent = pointer.resolve(uri);
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

const { tools, removed } = chef.tools().pruneByTask("Read the auth.ts file");
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
const { tools, directoryXml } = chef.tools().compile();
// directoryXml: inject into system prompt so LLM knows available toolkits
```

**Agent Loop integration:**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.tools().isNamespaceCall(toolCall)) {
    // Route namespace call to real tool
    const { toolName, args } = chef.tools().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.tools().isToolkitLoader(toolCall)) {
    // LLM requested a toolkit — expand and re-call
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.tools().extractToolkit(parsed.toolkit_name);
    // Merge newTools into the next LLM request
  }
}
```

---

### Core Memory

Persistent key-value memory that survives across sessions. The LLM writes memories via XML tags in its output.

```typescript
import { InMemoryStore, VFSMemoryStore } from "context-chef";

const chef = new ContextChef({
  memoryStore: new InMemoryStore(), // ephemeral (testing)
  // memoryStore: new VFSMemoryStore(dir),   // persistent (production)
});

// After each LLM response, extract and apply memory updates
await chef.memory().extractAndApply(assistantResponse);
// Parses: <update_core_memory key="project_rules">Use TypeScript strict mode</update_core_memory>
// Parses: <delete_core_memory key="outdated_rule" />

// Direct read/write
await chef.memory().set("persona", "You are a senior engineer");
const value = await chef.memory().get("persona");

// Memory is auto-injected as <core_memory> XML between topLayer and history on compile()
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

### `onBeforeCompile` Hook

Inject external context (RAG, AST snippets, MCP queries) right before compilation without modifying the message array.

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.rawDynamicXml);
    return snippets.map((s) => s.content).join("\n");
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```

---

### Target Adapters

| Feature                      | OpenAI                      | Anthropic                              | Gemini                                     |
| ---------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions            | Messages API                           | generateContent                            |
| Cache breakpoints            | Stripped                    | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support                         | Degraded to `[System Note]`                |
| `thinking` field             | Stripped                    | Mapped to `ThinkingBlockParam`         | Stripped                                   |
| Tool calls                   | `tool_calls` array          | `tool_use` blocks                      | `functionCall` parts                       |

Adapters are selected automatically by `compile({ target })`. You can also use them standalone:

```typescript
import { getAdapter } from "context-chef";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```
