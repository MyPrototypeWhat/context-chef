# 快速开始

ContextChef 解决 AI Agent 开发中最常见的上下文工程问题：对话太长模型会忘事、工具太多模型会幻觉、切换模型要重写 prompt、长程任务状态丢失。它不接管你的控制流，只负责在每次 LLM 调用前把你的状态编译成最优的 payload。

## Packages

| 包 | 说明 |
|---|---|
| [`@context-chef/core`](/zh/packages/core) | 核心上下文编译器 —— 历史压缩、工具裁剪、记忆、VFS 卸载、多 provider 适配 |
| [`@context-chef/ai-sdk-middleware`](/zh/packages/ai-sdk-middleware) | [Vercel AI SDK](https://sdk.vercel.ai) 中间件 —— 即插即用的上下文工程，零代码改动 |
| [`@context-chef/tanstack-ai`](/zh/packages/tanstack-ai) | [TanStack AI](https://tanstack.com/ai) 中间件 —— 通过 `ChatMiddleware` 提供压缩、截断和动态状态 |

## 安装

```bash
npm install @context-chef/core zod
```

## 快速开始

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

## 零配置接入 AI SDK

如果你在用 Vercel AI SDK，只需 2 行代码即可获得透明的历史压缩和工具结果截断：

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

完整文档见 [`@context-chef/ai-sdk-middleware` 包页面](/zh/packages/ai-sdk-middleware)。

## TanStack AI 中间件

如果你在用 TanStack AI，挂上中间件即可获得透明的上下文管理：

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

完整文档见 [`@context-chef/tanstack-ai` 包页面](/zh/packages/tanstack-ai)。

## 核心概念：构建上下文

需要直接控制编译管道 —— 动态状态注入、工具 namespace、记忆、快照/恢复 —— 请直接使用核心库。

### `new ContextChef(config?)`

```typescript
const chef = new ContextChef({
  vfs?: { threshold?: number, storageDir?: string, maxAge?: number, maxFiles?: number, maxBytes?: number, onVFSEvicted?: (entry, reason) => void },
  janitor?: JanitorConfig,
  pruner?: { strategy?: 'union' | 'intersection' },
  memory?: MemoryConfig,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>,
});
```

> **4.0 移除项** —— 每一项都有直接替代：`TokenUtils` → `estimate` / `estimateObject`，`XmlGenerator` → `objectToXml`，`AdapterFactory` → `getAdapter` / `adapterRegistry`，`JanitorConfig.onBudgetExceeded` → `onBeforeCompress`。完整迁移指南见[迁移到 v4](/zh/migration/v4)。

### `chef.setSystemPrompt(messages): this`

设置静态系统提示词层。作为缓存前缀，应尽量少变。

```typescript
chef.setSystemPrompt([
  {
    role: "system",
    content: "You are an expert coder.",
    _cache_breakpoint: true,
  },
]);
```

`_cache_breakpoint: true` 会让 Anthropic 适配器注入 `cache_control: { type: 'ephemeral' }`。

### `chef.setHistory(messages): this`

设置对话历史。Janitor 在 `compile()` 时自动压缩。

### `chef.setDynamicState(schema, data, options?): this`

将 Zod 校验后的状态以 XML 注入上下文。

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

将所有内容编译为 provider 就绪的 payload。触发 Janitor 压缩。注册的工具自动包含。

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

## 接下来

- [历史压缩（Janitor）](/zh/guide/history-compression) —— 压缩管道、质量闸门和 v4 压缩管道 v2
- [工具管理（Pruner）](/zh/guide/tool-management) —— 裁剪、blocklist 和双层 namespace 架构
- [记忆（Memory）](/zh/guide/memory) —— 跨会话持久化键值记忆
- [适配器](/zh/guide/adapters) —— OpenAI / Anthropic / Gemini 及自定义 provider 的输入 / 目标适配器

## 博客系列

1. [为什么要"编译上下文"](https://myprototypewhat.cn/context-chef-1-why-compile-context)
2. [Janitor——把触发逻辑和压缩策略彻底分离](https://myprototypewhat.cn/context-chef-2-janitor)
3. [Pruner——把工具注册和路由彻底分开](https://myprototypewhat.cn/context-chef-3-pruner)
4. [Offloader/VFS——不破坏信息，只搬移信息](https://myprototypewhat.cn/context-chef-4-offloader-vfs)
5. [Core Memory——读取零成本，写入结构化](https://myprototypewhat.cn/context-chef-5-core-memory)
6. [Snapshot & Restore——捕获决定下次编译的一切](https://myprototypewhat.cn/context-chef-6-snapshot)
7. [Provider 适配层——让差异止于编译层](https://myprototypewhat.cn/context-chef-7-adapters)
8. [编译管道里的五个扩展点](https://myprototypewhat.cn/context-chef-8-hooks)

## Claude Code Skills

ContextChef 提供了 [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)，帮助你交互式地将库集成到项目中。每个 Skill 会分析你现有的代码，生成定制化的集成代码。

| Skill                     | 描述                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `context-chef-core`       | 集成 `@context-chef/core` — 完全控制编译流程，多 provider 支持             |
| `context-chef-middleware` | 集成 `@context-chef/ai-sdk-middleware` — AI SDK 即插即用中间件，零代码改动 |

按需安装：

```bash
# Core library (OpenAI / Anthropic / Gemini direct SDK usage)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK middleware (Vercel AI SDK v7+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# All
npx skills add MyPrototypeWhat/context-chef
```

然后在项目中打开 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，输入 `/context-chef-core` 或 `/context-chef-middleware`。
