# context-chef API Quick Reference

## Installation

```bash
npm install context-chef zod
```

## Exports

```typescript
import {
  ContextChef,          // Main class
  Janitor,              // Standalone janitor (compact, compression)
  Pruner,               // Standalone pruner (rarely needed)
  Offloader,            // Standalone offloader for VFS resolve
  InMemoryStore,        // Ephemeral memory store (testing)
  VFSMemoryStore,       // Persistent memory store (production)
  FileSystemAdapter,    // Default VFS storage adapter
  getAdapter,           // Standalone adapter factory
  TokenUtils,           // Token counting utilities
  XmlGenerator,         // XML generation utilities
} from "@context-chef/core";

// Types
import type {
  Message, ToolDefinition, ToolCall,
  CompileOptions, CompileMeta, TargetProvider,
  OpenAIPayload, AnthropicPayload, GeminiPayload, TargetPayload,
  CompactOptions, ClearTarget,
  MemoryEntry, MemorySetOptions, MemoryChangeEvent, TTLValue,
  OffloadOptions, VFSConfig, VFSStorageAdapter,
  BeforeCompileContext, ChefSnapshot, ChefConfig,
  GuardrailOptions, DynamicStatePlacement,
} from "@context-chef/core";
```

## ChefConfig

```typescript
interface ChefConfig {
  vfs?: {
    threshold?: number;           // Character limit before truncation (default: 5000)
    storageDir?: string;          // Directory for VFS files (default: .context_vfs)
    uriScheme?: string;           // Custom URI prefix (default: 'context://vfs/')
    adapter?: VFSStorageAdapter;  // Custom storage adapter (overrides storageDir)
  };
  janitor?: JanitorConfig;
  pruner?: {
    strategy?: 'union' | 'intersection'; // Tool filtering strategy
  };
  memory?: MemoryConfig;

  /** Transform the full message array after assembly, before adapter formatting. */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;

  /**
   * Inject external context (RAG, AST, MCP) before compilation.
   * Return a string to inject as <implicit_context>, or null to skip.
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}
```

## JanitorConfig

```typescript
interface JanitorConfig {
  contextWindow: number;  // Required. Model's context window in tokens

  // --- Tokenizer path (precise control) ---
  tokenizer?: (msgs: Message[]) => number;
  preserveRatio?: number;           // Ratio to preserve (default: 0.8)

  // --- reportTokenUsage path (simple) ---
  preserveRecentMessages?: number;  // Messages to keep (default: 1)

  // --- Compression ---
  compressionModel?: (msgs: Message[]) => Promise<string>;

  // --- Hooks ---
  /** Fires AFTER compression with the summary Message and truncated count. */
  onCompress?: (summaryMessage: Message, truncatedCount: number) => void | Promise<void>;

  /**
   * Fires BEFORE compression when budget is exceeded.
   * Return modified Message[] to intervene (e.g. compact tool results first),
   * or null to let default compression proceed.
   */
  onBudgetExceeded?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
}
```

## MemoryConfig

```typescript
interface MemoryConfig {
  store: MemoryStore;                       // InMemoryStore or VFSMemoryStore
  defaultTTL?: TTLValue;                    // Default time-to-live for entries
  allowedKeys?: string[];                   // Whitelist of allowed memory keys

  /** Filter/sort/truncate entries before injection into system prompt. */
  selector?: (entries: MemoryEntry[]) => MemoryEntry[];

  /** Veto hook — return false to block the write. Called before create/update/delete. */
  onMemoryUpdate?: (key: string, value: string | null, oldValue: string | null) => boolean | Promise<boolean>;

  /** Notification — fires after any memory change (set, delete, expire). */
  onMemoryChanged?: (event: MemoryChangeEvent) => void | Promise<void>;

  /** Fires when an entry expires during compile(). Receives the full MemoryEntry. */
  onMemoryExpired?: (entry: MemoryEntry) => void | Promise<void>;
}

type TTLValue = number | { ms: number } | { turns: number };
// number = turns, e.g. 20 means "expire after 20 compile() calls"

interface MemoryEntry {
  key: string;
  value: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  importance?: number;
  expiresAt?: number;       // ms-based expiry
  expiresAtTurn?: number;   // turn-based expiry
}

interface MemoryChangeEvent {
  type: 'set' | 'delete' | 'expire';
  key: string;
  value: string | null;
  oldValue: string | null;
}
```

## VFSStorageAdapter

Custom adapter for storing offloaded content (e.g. S3, Redis, cloud storage):

```typescript
interface VFSStorageAdapter {
  write(filename: string, content: string): void | Promise<void>;
  read(filename: string): string | null | Promise<string | null>;
}
```

## Message Type

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _cache_breakpoint?: boolean;     // Enables Anthropic prompt caching
  thinking?: ThinkingContent;       // Extended thinking (Anthropic)
  redacted_thinking?: RedactedThinking;
  [key: string]: unknown;          // Pass-through fields
}
```

## ContextChef Methods

### Context Building

| Method | Description |
|---|---|
| `setSystemPrompt(messages): this` | Set static system prompt (cached prefix) |
| `setHistory(messages): this` | Set conversation history |
| `setDynamicState(schema, data, options?): this` | Inject Zod-validated state as XML |
| `withGuardrails(options): this` | Apply output format constraints + prefill |
| `clearHistory(): this` | Clear history and reset Janitor |

### Tool Management

| Method | Description |
|---|---|
| `registerTools(tools): this` | Register flat tools (simple mode) |
| `registerNamespaces(groups): this` | Register Layer 1 namespace tools (KV-cache stable) |
| `registerToolkits(groups): this` | Register Layer 2 lazy-loadable toolkits |
| `getPruner(): Pruner` | Direct access to pruner for filtering |

### Pruner Methods (via `chef.getPruner()`)

| Method | Description |
|---|---|
| `pruneByTask(description): PrunerResult` | Filter tools by task relevance |
| `allowOnly(names): PrunerResult` | Keep only named tools |
| `pruneByTaskAndAllowlist(task, names): PrunerResult` | Combined filtering |
| `compile(): { tools, directoryXml }` | Compile namespace + lazy loading |
| `isNamespaceCall(toolCall): boolean` | Check if a call targets a namespace tool |
| `resolveNamespace(toolCall): { group, toolName, args }` | Resolve namespace call to real tool |
| `isToolkitLoader(toolCall): boolean` | Check if it's a load_toolkit call |
| `extractToolkit(name): ToolDefinition[]` | Get full schemas for a toolkit |

```typescript
interface PrunerResult {
  tools: ToolDefinition[];  // Filtered tools to pass to LLM
  removed: string[];        // Names of tools that were filtered out
  kept: number;             // Number of tools kept
  total: number;            // Total number of registered tools
}
```

### Memory (via `chef.getMemory()`)

**Validated methods** (for LLM-driven operations — respect `allowedKeys` + `onMemoryUpdate` veto):

| Method | Returns | Description |
|---|---|---|
| `createMemory(key, value, description?)` | `Promise<MemoryEntry \| null>` | Create entry. Returns null if vetoed/blocked |
| `updateMemory(key, value, description?)` | `Promise<MemoryEntry \| null>` | Update existing. Returns null if not found/vetoed |
| `deleteMemory(key)` | `Promise<boolean>` | Delete entry. Returns false if not found/vetoed |

**Direct methods** (for developer use — bypass validation hooks):

| Method | Returns | Description |
|---|---|---|
| `set(key, value, options?)` | `Promise<void>` | Direct set with optional TTL, importance, description |
| `get(key)` | `Promise<string \| null>` | Get value by key |
| `getEntry(key)` | `Promise<MemoryEntry \| null>` | Get full entry with metadata |
| `getAll()` | `Promise<MemoryEntry[]>` | Get all entries |
| `delete(key)` | `Promise<boolean>` | Direct delete |

### VFS / Offloading (via `chef`)

| Method | Description |
|---|---|
| `offload(content, options?): string` | Sync truncation with VFS pointer |
| `offloadAsync(content, options?): Promise<string>` | Async version |

OffloadOptions: `{ headChars?, tailChars?, threshold? }`

**Standalone Offloader** (for retrieving offloaded content):

```typescript
import { Offloader } from "@context-chef/core";
const offloader = new Offloader({ storageDir: ".context_vfs" });

// Retrieve full content from a context://vfs/ URI
const fullContent = offloader.resolve(uri);           // sync
const fullContent = await offloader.resolveAsync(uri); // async
```

### Compilation

| Method | Description |
|---|---|
| `compile({ target: 'openai' }): Promise<OpenAIPayload>` | Compile for OpenAI |
| `compile({ target: 'anthropic' }): Promise<AnthropicPayload>` | Compile for Anthropic |
| `compile({ target: 'gemini' }): Promise<GeminiPayload>` | Compile for Gemini |
| `reportTokenUsage(count): this` | Feed API-reported token count |

### Snapshot & Restore

| Method | Description |
|---|---|
| `snapshot(label?): ChefSnapshot` | Capture full state (history, dynamic state, janitor, memory, pruner) |
| `restore(snapshot): this` | Roll back to snapshot (all state including memory entries and TTLs) |

### History Compaction (Janitor)

`compact()` is a method on the `Janitor` class — zero LLM cost, pure mechanical stripping.
Use it standalone or inside the `onBudgetExceeded` hook.

```typescript
import { Janitor } from "@context-chef/core";

const janitor = new Janitor({ contextWindow: Infinity });

// Strip tool results — replace content with "[Tool result cleared]"
const compacted = janitor.compact(history, { clear: ['tool-result'] });

// Strip thinking/redacted_thinking blocks from assistant messages
const compacted = janitor.compact(history, { clear: ['thinking'] });

// Both
const compacted = janitor.compact(history, { clear: ['tool-result', 'thinking'] });
```

**Common pattern — use compact() as a first pass inside `onBudgetExceeded`:**

```typescript
const compactJanitor = new Janitor({ contextWindow: Infinity });

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => summarize(msgs),
    onBudgetExceeded: (history) => {
      // First try mechanical compaction (free, no LLM call)
      return compactJanitor.compact(history, { clear: ['tool-result'] });
      // If still over budget after compact, Janitor proceeds with LLM compression
    },
  },
});
```

## Memory Tool Schemas

When memory is configured, `compile()` auto-injects these tool definitions for the LLM:

### `create_memory`

```json
{
  "name": "create_memory",
  "description": "Remember a new fact across conversations.",
  "parameters": {
    "type": "object",
    "properties": {
      "key":         { "type": "string", "description": "Descriptive key name" },
      "value":       { "type": "string", "description": "The value to remember" },
      "description": { "type": "string", "description": "What this entry is for" }
    },
    "required": ["key", "value"]
  }
}
```

If `allowedKeys` is configured, `key` becomes an enum.

### `modify_memory`

Only injected when existing memory entries exist. `key` is an enum of existing keys.

```json
{
  "name": "modify_memory",
  "description": "Update or delete an existing memory entry.",
  "parameters": {
    "type": "object",
    "properties": {
      "action":      { "type": "string", "enum": ["update", "delete"] },
      "key":         { "type": "string", "enum": ["<existing keys>"] },
      "value":       { "type": "string", "description": "New value (for update)" },
      "description": { "type": "string", "description": "Updated description" }
    },
    "required": ["action", "key"]
  }
}
```

## Hook Use Cases

### `onBeforeCompile` — Inject External Context

Called after Janitor compression, before adapter formatting. Return a string to inject as `<implicit_context>` alongside dynamic state, or null to skip.

```typescript
// Example 1: RAG — semantic search based on current task state
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const results = await vectorDB.search(ctx.dynamicStateXml);
    return results.map(r => r.content).join("\n");
  },
});

// Example 2: AST — inject relevant code structure
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const activeFile = extractActiveFile(ctx.dynamicStateXml);
    if (!activeFile) return null;
    const ast = await parseAST(activeFile);
    return `<code_structure file="${activeFile}">\n${ast.summary}\n</code_structure>`;
  },
});

// Example 3: MCP — query external context servers
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const mcpResults = await mcpClient.query({ context: ctx.dynamicStateXml });
    return mcpResults.length > 0 ? mcpResults.join("\n") : null;
  },
});
```

**BeforeCompileContext** — what the hook receives:
```typescript
interface BeforeCompileContext {
  systemPrompt: readonly Message[];
  history: readonly Message[];
  dynamicState: readonly Message[];
  dynamicStateXml: string;  // Serialized dynamic state (useful as search query)
}
```

### `onBudgetExceeded` — Intervene Before Compression

Fires when token budget is exceeded, BEFORE automatic compression. Use this to try cheaper strategies first.

```typescript
import { Janitor } from "@context-chef/core";
const compactJanitor = new Janitor({ contextWindow: Infinity });

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    compressionModel: async (msgs) => summarize(msgs),
    onBudgetExceeded: (history, { currentTokens, limit }) => {
      // Strategy 1: Compact tool results first (zero cost)
      return compactJanitor.compact(history, { clear: ['tool-result'] });
      // If still over budget, Janitor's LLM compression proceeds automatically
    },
  },
});

// Strategy 2: Offload large tool results to VFS before compression
const chef2 = new ContextChef({
  janitor: {
    contextWindow: 200000,
    onBudgetExceeded: (history) => {
      return history.map(msg =>
        msg.role === 'tool' && msg.content.length > 5000
          ? { ...msg, content: chef2.offload(msg.content) }
          : msg
      );
    },
  },
});
```

### `transformContext` — Final Message Transform

Called after all assembly (system + memory + history + dynamic state), before adapter formatting. Receives the full message array — use for custom mutations, reordering, or metadata injection.

```typescript
const chef = new ContextChef({
  transformContext: (messages) => {
    // Strip all system messages except the first (for providers that don't support multiple)
    let seenFirst = false;
    return messages.filter(msg => {
      if (msg.role === 'system') {
        if (!seenFirst) { seenFirst = true; return true; }
        return false;
      }
      return true;
    });
  },
});
```

### Memory Hooks

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(".memory"),
    // Filter: only inject the 10 most recently updated entries
    selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
    // Veto: block writes to certain keys
    onMemoryUpdate: (key, value, oldValue) => {
      if (key.startsWith("system_")) return false; // protect system keys
      return true;
    },
    // Notification: log all changes
    onMemoryChanged: (event) => {
      console.log(`Memory ${event.type}: ${event.key}`);
    },
    // Expiry: archive expired entries
    onMemoryExpired: (entry) => {
      archiveService.save(entry.key, entry.value);
    },
  },
});
```

## Payload Types

### OpenAIPayload
```typescript
{ messages: ChatCompletionMessageParam[], tools?: ToolDefinition[], meta?: CompileMeta }
```

### AnthropicPayload
```typescript
{ system?: TextBlockParam[], messages: MessageParam[], tools?: ToolDefinition[], meta?: CompileMeta }
```

### GeminiPayload
```typescript
{ messages: Content[], systemInstruction?: { parts: TextPart[] }, tools?: ToolDefinition[], meta?: CompileMeta }
```

### CompileMeta
```typescript
{ injectedMemoryKeys: string[], memoryExpiredKeys: string[] }
```

## Provider Adapter Behavior

| Feature | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| System messages | Kept inline | Separated to `system` field | Separated to `systemInstruction` |
| Cache breakpoints | Stripped | `cache_control: { type: 'ephemeral' }` | Stripped |
| Prefill (trailing assistant) | Degraded to `[System Note]` in last user message | Native support | Degraded to `[System Note]` |
| Thinking blocks | Stripped | Mapped to `ThinkingBlockParam` | Stripped |
| Tool calls format | `tool_calls` array | `tool_use` content blocks | `functionCall` parts |
