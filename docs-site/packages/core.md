# @context-chef/core

The core context compiler — history compression, tool pruning, memory, VFS offloading, snapshot/restore, and multi-provider adapters, with no framework dependency. Use it when you drive an LLM SDK (OpenAI / Anthropic / Gemini) directly and want full control over the compilation pipeline.

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)

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

## What's inside

The full API is documented across the guide, one page per concern:

| Module | Guide page |
|---|---|
| Janitor — history compression, `compact()`, `ensureValidHistory` | [History Compression](/guide/history-compression) |
| `planCompaction` / `compactHistory` / `summarizeHistory` | [Durable Compaction](/guide/durable-compaction) |
| `contextManagement: { strategy: 'server' }` | [Server-Side Context Management](/guide/server-side-context-management) |
| Offloader / VFS — `offload`, `cleanupAsync`, `reconcileAsync` | [Offloading & VFS](/guide/offloading-vfs) |
| Pruner — flat mode, blocklist, namespaces, `deferLoading` | [Tool Management](/guide/tool-management) |
| Memory — stores, tools, `memoryPlacement` | [Memory](/guide/memory) |
| Skill — `SKILL.md` loading, `renderSkill`, delivery models | [Skills](/guide/skills) |
| `withGuardrails` — XML contract + prefill | [Guardrail](/guide/guardrail) |
| `snapshot()` / `restore()` | [Snapshot & Restore](/guide/snapshot-restore) |
| Events, `compile({ signal })`, concurrency, `onBeforeCompile` | [Events & Hooks](/guide/events-hooks) |
| Input/target adapters, `adapterRegistry`, `openai-responses` | [Adapters](/guide/adapters) |

## Utilities

- `estimate(text)` / `estimateObject(obj)` — rough token estimation (replaces the removed `TokenUtils`).
- `objectToXml(obj)` — the XML serializer behind dynamic state (replaces the removed `XmlGenerator`).
- `getAdapter(name)` / `adapterRegistry` — adapter lookup and registration (replaces the removed `AdapterFactory`).
- `ensureValidHistory(messages)` — sanitize a message array to satisfy LLM API invariants.
- `getRecallToolDefinition()` / `chef.resolveRecall(uri)` — the recall tool for archived/offloaded content.

## Links

- [npm — @context-chef/core](https://www.npmjs.com/package/@context-chef/core)
- [Source & full README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/core)
- [Migration guide (v4)](/migration/v4)
