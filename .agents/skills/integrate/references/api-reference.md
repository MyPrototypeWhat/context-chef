# context-chef API Quick Reference

## Installation

```bash
npm install context-chef zod
```

## Exports

```typescript
import {
  ContextChef,          // Main class
  InMemoryStore,        // Ephemeral memory store (testing)
  VFSMemoryStore,       // Persistent memory store (production)
  Offloader,            // Standalone offloader for VFS resolve
  Pruner,               // Standalone pruner (rarely needed)
  Janitor,              // Standalone janitor (rarely needed)
  getAdapter,           // Standalone adapter factory
  TokenUtils,           // Token counting utilities
  XmlGenerator,         // XML generation utilities
  Prompts,              // formatCompactSummary / getCompactSummaryWrapper
  summarizeHistory,     // Standalone summarization primitive (see History Compaction)
} from "context-chef";
```

## ChefConfig

```typescript
interface ChefConfig {
  vfs?: {
    threshold?: number;        // Character limit before truncation (default: 5000)
    storageDir?: string;       // Directory for VFS files
    adapter?: VFSStorageAdapter; // Custom storage adapter
  };
  janitor?: JanitorConfig;
  pruner?: {
    strategy?: 'union' | 'intersection'; // Tool filtering strategy
  };
  memory?: MemoryConfig;
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}
```

## JanitorConfig

```typescript
interface JanitorConfig {
  contextWindow: number;                               // Required. Model's context window in tokens
  tokenizer?: (msgs: Message[]) => number;             // Enables tokenizer path
  preserveRatio?: number;                              // Tokenizer path: ratio to preserve (default: 0.8)
  preserveRecentMessages?: number;                     // reportTokenUsage path: messages to keep (default: 1)
  compressionModel?: (msgs: Message[]) => Promise<string>; // Summarize old messages
  onCompress?: (summary: string, count: number, details: { compressedMessages: LanguageModelV3Prompt }) => void;
  onBudgetExceeded?: (history: Message[], info: { currentTokens: number; limit: number }) => Message[] | null;
  logger?: ChefLogger;  // Sink for degradation warnings; defaults to console
                        // ChefLogger = { warn(message: string, ...args: unknown[]): void }
}
```

## MemoryConfig

```typescript
interface MemoryConfig {
  store: MemoryStore;                    // InMemoryStore or VFSMemoryStore
  defaultTTL?: TTLValue;                 // Default time-to-live for entries
  allowedKeys?: string[];                // Whitelist of allowed memory keys
  selector?: (entries: MemoryEntry[]) => MemoryEntry[]; // Filter/sort before injection
  onMemoryUpdate?: (key: string, value: string) => boolean; // Veto hook
  onMemoryChanged?: (event: MemoryChangeEvent) => void;
  onMemoryExpired?: (key: string, value: string) => void;
}

type TTLValue = number | { ms: number } | { turns: number };
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
| `pruneByTask(description): { tools, removed }` | Filter tools by task relevance |
| `allowOnly(names): { tools, removed }` | Keep only named tools |
| `pruneByTaskAndAllowlist(task, names)` | Combined filtering |
| `compile(): { tools, directoryXml }` | Compile namespace + lazy loading |
| `isNamespaceCall(toolCall): boolean` | Check if a call targets a namespace tool |
| `resolveNamespace(toolCall): { toolName, args }` | Resolve namespace call to real tool |
| `isToolkitLoader(toolCall): boolean` | Check if it's a load_toolkit call |
| `extractToolkit(name): ToolDefinition[]` | Get full schemas for a toolkit |

### Memory

| Method | Description |
|---|---|
| `getMemory(): Memory` | Direct access to memory operations |
| `getMemory().createMemory(key, value, description?)` | Create a memory entry |
| `getMemory().updateMemory(key, value, description?)` | Update existing entry |
| `getMemory().deleteMemory(key)` | Delete an entry |
| `getMemory().set(key, value, options?)` | Direct set (bypasses validation) |
| `getMemory().get(key): string \| undefined` | Direct get |

### VFS / Offloading

| Method | Description |
|---|---|
| `offload(content, options?): string` | Sync truncation with VFS pointer |
| `offloadAsync(content, options?): Promise<string>` | Async version |

OffloadOptions: `{ headChars?, tailChars?, threshold? }`

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
| `snapshot(label?): ChefSnapshot` | Capture full state |
| `restore(snapshot): this` | Roll back to snapshot |

### History Compaction

```typescript
// Mechanical compaction — zero LLM cost
const compacted = chef.getJanitor().compact(history, {
  clear: ['tool-result'],   // Replace tool message content with placeholder
  // clear: ['thinking'],   // Strip thinking/redacted_thinking blocks
  // clear: ['tool-result', 'thinking'], // Both
});
```

**Standalone summarization — `summarizeHistory`:** provider-agnostic primitive behind the LLM compression path. Compress a slice in your own store (durable compaction) instead of via `compile()`.

```typescript
function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts?: { customCompressionInstructions?: string; toolResultStubThreshold?: number },
): Promise<string>;
```

Empty slice → `''` (no model call); stateless, **throws** if `compress` throws; `compress` **must role-flatten** `tool` / assistant-tool-call messages (providers reject raw `tool` roles). Wrap the result with `Prompts.getCompactSummaryWrapper` for continuation framing. AI-SDK users: prefer `summarizeMessages` from `@context-chef/ai-sdk-middleware`.

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
