# Getting Started

ContextChef solves the most common context engineering problems in AI agent development: conversations too long for the model to remember, too many tools causing hallucinations, having to rewrite prompts when switching providers, and state drift in long-running tasks. It doesn't take over your control flow — it just compiles your state into an optimal payload before each LLM call.

## Packages

| Package | Description |
|---|---|
| [`@context-chef/core`](/packages/core) | Core context compiler — overflow strategies, tool pruning, the context store, multi-provider adapters |
| [`@context-chef/ai-sdk-middleware`](/packages/ai-sdk-middleware) | [Vercel AI SDK](https://sdk.vercel.ai) middleware — drop-in context engineering with zero code changes |
| [`@context-chef/tanstack-ai`](/packages/tanstack-ai) | [TanStack AI](https://tanstack.com/ai) middleware — compression, truncation, and dynamic state via `ChatMiddleware` |

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

## Zero-config AI SDK integration

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

See the [`@context-chef/ai-sdk-middleware` package page](/packages/ai-sdk-middleware) for full documentation.

## TanStack AI middleware

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

See the [`@context-chef/tanstack-ai` package page](/packages/tanstack-ai) for full documentation.

## Core concepts: building the context

For direct control over the compilation pipeline — dynamic state injection, tool namespaces, memory, snapshot/restore — use the core library directly.

### `new ContextChef(config?)`

```typescript
const chef = new ContextChef({
  janitor?: JanitorConfig,                       // the overflow runner: budget, trigger, breaker
  overflow?: { strategy?, archive?, handoff? },  // the overflow policy
  store?: StorageBackend | Store,                // one substrate for memory/ notes/ vfs/ archive/
  tools?: 'legacy' | 'unified',                  // which library-owned tools compile() emits
  contextTool?: { writable?: string[] },
  memory?: MemoryConfig,
  vfs?: { threshold?: number, storageDir?: string, maxAge?: number, maxFiles?: number, maxBytes?: number, onVFSEvicted?: (entry, reason) => void },
  pruner?: { strategy?: 'union' | 'intersection' },
  transformToolResult?: (content: string, info) => string | Promise<string>,
  pipelineChecks?: boolean,
  cacheAudit?: boolean,
});
```

> **Composition lives on slots** <Badge type="tip" text="4.2" />**.** `chef.use('before-assemble', ...)` / `chef.use('after-assemble', ...)` replace the `onBeforeCompile` and `transformContext` config hooks, which still work and are removed in 5.0. See [Events & Hooks](/guide/events-hooks#slots).

> **Removed in 4.0** — each has a direct replacement: `TokenUtils` → `estimate` / `estimateObject`, `XmlGenerator` → `objectToXml`, `AdapterFactory` → `getAdapter` / `adapterRegistry`, `JanitorConfig.onBudgetExceeded` → `onBeforeCompress`. See the [migration guide](/migration/v4).

### `chef.setSystemPrompt(messages): this`

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

### `chef.setHistory(messages): this`

Sets the conversation history. Janitor compresses automatically on `compile()`.

### `chef.setDynamicState(schema, data, options?): this`

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

### `chef.compile(options?): Promise<TargetPayload>`

Compiles everything into a provider-ready payload. Triggers Janitor compression. Registered tools are auto-included.

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

## Where to go next

- [Architecture](/guide/architecture) — the five axes, the compile pipeline, and the slots
- [Overflow](/guide/history-compression) — strategies, quality gates, the handoff budget, `new_context`
- [Context store](/guide/context-store) — one backend behind `memory/`, `notes/`, `vfs/` and `archive/`, and the `context` tool
- [Tool Management (Pruner)](/guide/tool-management) — pruning, blocklists, and the two-layer namespace architecture
- [Adapters](/guide/adapters) — input and target adapters for OpenAI / Anthropic / Gemini and beyond

## Blog series

1. [Why "Compile" Your Context](https://myprototypewhat.cn/context-chef-1-why-compile-context-en)
2. [Janitor — Separating Trigger Logic from Compression Policy](https://myprototypewhat.cn/context-chef-2-janitor-en)
3. [Pruner — Decoupling Tool Registration from Routing](https://myprototypewhat.cn/context-chef-3-pruner-en)
4. [Offloader/VFS — Relocate Information, Don't Destroy It](https://myprototypewhat.cn/context-chef-4-offloader-vfs-en)
5. [Core Memory — Zero-Cost Reads, Structured Writes](https://myprototypewhat.cn/context-chef-5-core-memory-en)
6. [Snapshot & Restore — Capture Everything That Determines the Next Compile](https://myprototypewhat.cn/context-chef-6-snapshot-en)
7. [The Provider Adapter Layer — Let Differences Stop at Compile Time](https://myprototypewhat.cn/context-chef-7-adapters-en)
8. [Five Extension Points in the Compile Pipeline](https://myprototypewhat.cn/context-chef-8-hooks-en)

## Claude Code skills

ContextChef ships [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills) that help you integrate the library into your project interactively. Each skill analyzes your existing codebase and generates tailored integration code.

| Skill | Description |
|---|---|
| `context-chef-core` | Integrate `@context-chef/core` — full control over compilation pipeline, multi-provider support |
| `context-chef-middleware` | Integrate `@context-chef/ai-sdk-middleware` — drop-in AI SDK middleware, zero code changes |

Install only what you need:

```bash
# Core library (OpenAI / Anthropic / Gemini direct SDK usage)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK middleware (Vercel AI SDK v7+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# All
npx skills add MyPrototypeWhat/context-chef
```

Then open [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) in your project and type `/context-chef-core` or `/context-chef-middleware`.
