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
npm install context-engineer zod
```

## Quick Start

```typescript
import { ContextChef } from 'context-engineer';
import { z } from 'zod';

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

const chef = new ContextChef({
  janitor: {
    maxHistoryTokens: 20000,
    preserveRecentTokens: 10000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

const payload = await chef
  .setTopLayer([{ role: 'system', content: 'You are an expert coder.', _cache_breakpoint: true }])
  .useRollingHistory(conversationHistory)
  .setDynamicState(TaskSchema, { activeFile: 'auth.ts', todo: ['Fix login bug'] })
  .withGovernance({ enforceXML: { outputTag: 'response' }, prefill: '<thinking>\n1.' })
  .compile({ target: 'anthropic' });

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
  { role: 'system', content: 'You are an expert coder.', _cache_breakpoint: true },
]);
```

`_cache_breakpoint: true` tells the Anthropic adapter to inject `cache_control: { type: 'ephemeral' }`.

#### `chef.useRollingHistory(messages): this`

Sets the conversation history. Janitor compresses automatically on `compile()`.

#### `chef.setDynamicState(schema, data, options?): this`

Injects Zod-validated state as XML into the context.

```typescript
const TaskSchema = z.object({ activeFile: z.string(), todo: z.array(z.string()) });

chef.setDynamicState(TaskSchema, { activeFile: 'auth.ts', todo: ['Fix bug'] });
// placement defaults to 'last_user' (injected into the last user message)
// use { placement: 'system' } for a standalone system message
```

#### `chef.withGovernance(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGovernance({
  enforceXML: { outputTag: 'final_code' }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: '<thinking>\n1.',               // trailing assistant message (auto-degraded for OpenAI/Gemini)
});
```

#### `chef.compile(options?): Promise<TargetPayload>`

Compiles everything into a provider-ready payload. Triggers Janitor compression. Registered tools are auto-included.

```typescript
const payload = await chef.compile({ target: 'openai' });    // OpenAIPayload
const payload = await chef.compile({ target: 'anthropic' }); // AnthropicPayload
const payload = await chef.compile({ target: 'gemini' });    // GeminiPayload
```

---

### History Compression (Janitor)

```typescript
const chef = new ContextChef({
  janitor: {
    maxHistoryTokens: 20000,          // trigger compression above this
    preserveRecentTokens: 10000,      // keep recent messages intact (default: 70%)
    tokenizer: (msgs) => countTokens(msgs), // optional: plug in tiktoken for precision
    compressionModel: async (msgs) => callGpt4oMini(msgs), // LLM summarizer
    onCompress: async (summary, count) => {
      // persist compressed state to DB
      await db.replaceOldMessages(sessionId, summary, count);
    },
  },
});
```

#### `chef.feedTokenUsage(tokenCount): this`

Feed the API-reported token count for more accurate compression triggers.

```typescript
const response = await openai.chat.completions.create({ ... });
chef.feedTokenUsage(response.usage.prompt_tokens);
```

#### `chef.clearRollingHistory(): this`

Explicitly clear history when switching topics or completing sub-tasks.

---

### Large Output Offloading (Pointer / VFS)

```typescript
// truncate + offload if content exceeds threshold
const safeLog = chef.processLargeOutput(rawTerminalOutput, 'log');
history.push({ role: 'tool', content: safeLog, tool_call_id: 'call_123' });
// safeLog: original content if small, or truncated with context://vfs/ URI
```

Register a tool for the LLM to read full content when needed:

```typescript
// In your tool handler:
import { Pointer } from 'context-engineer';
const pointer = new Pointer({ storageDir: '.context_vfs' });
const fullContent = pointer.resolve(uri);
```

---

### Tool Management (Pruner)

#### Flat Mode

```typescript
chef.registerTools([
  { name: 'read_file', description: 'Read a file', tags: ['file', 'read'] },
  { name: 'run_bash', description: 'Run a command', tags: ['shell'] },
  { name: 'get_time', description: 'Get timestamp' /* no tags = always kept */ },
]);

const { tools, removed } = chef.tools().pruneByTask('Read the auth.ts file');
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
    name: 'file_ops',
    description: 'File system operations',
    tools: [
      { name: 'read_file', description: 'Read a file', parameters: { path: { type: 'string' } } },
      { name: 'write_file', description: 'Write to a file', parameters: { path: { type: 'string' }, content: { type: 'string' } } },
    ],
  },
  {
    name: 'terminal',
    description: 'Shell command execution',
    tools: [
      { name: 'run_bash', description: 'Execute a command', parameters: { command: { type: 'string' } } },
    ],
  },
]);

// Layer 2: On-demand toolkits
chef.registerToolkits([
  { name: 'Weather', description: 'Weather forecast APIs', tools: [/* ... */] },
  { name: 'Database', description: 'SQL query and schema inspection', tools: [/* ... */] },
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
import { InMemoryStore, VFSMemoryStore } from 'context-engineer';

const chef = new ContextChef({
  memoryStore: new InMemoryStore(),          // ephemeral (testing)
  // memoryStore: new VFSMemoryStore(dir),   // persistent (production)
});

// After each LLM response, extract and apply memory updates
await chef.memory().extractAndApply(assistantResponse);
// Parses: <update_core_memory key="project_rules">Use TypeScript strict mode</update_core_memory>
// Parses: <delete_core_memory key="outdated_rule" />

// Direct read/write
await chef.memory().set('persona', 'You are a senior engineer');
const value = await chef.memory().get('persona');

// Memory is auto-injected as <core_memory> XML between topLayer and history on compile()
```

---

### Snapshot & Restore

Capture and rollback full context state for branching or error recovery.

```typescript
const snap = chef.snapshot('before risky tool call');

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
    return snippets.map(s => s.content).join('\n');
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```

---

### Target Adapters

| Feature | OpenAI | Anthropic | Gemini |
| ------- | ------ | --------- | ------ |
| Format | Chat Completions | Messages API | generateContent |
| Cache breakpoints | Stripped | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support | Degraded to `[System Note]` |
| `thinking` field | Stripped | Mapped to `ThinkingBlockParam` | Stripped |
| Tool calls | `tool_calls` array | `tool_use` blocks | `functionCall` parts |

Adapters are selected automatically by `compile({ target })`. You can also use them standalone:

```typescript
import { getAdapter } from 'context-engineer';
const adapter = getAdapter('gemini');
const payload = adapter.compile(messages);
```
