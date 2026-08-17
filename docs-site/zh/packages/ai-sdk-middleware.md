# @context-chef/ai-sdk-middleware

由 ContextChef 驱动的 [Vercel AI SDK](https://ai-sdk.dev) 中间件 —— 透明的历史压缩、工具结果截断和 token 预算管理，零代码改动。

[![npm version](https://img.shields.io/npm/v/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)

## 安装

```bash
npm install @context-chef/ai-sdk-middleware ai
```

> **AI SDK 版本。** `3.x` 面向 **AI SDK v7**（`ai@>=7`）。还在 AI SDK v6？使用 `@context-chef/ai-sdk-middleware@1` —— `1.x` 线支持 `ai@6`。

## 快速开始

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
});

// Everything below stays exactly the same — works with generateText, streamText, and ToolLoopAgent
const result = await generateText({
  model,
  messages: conversationHistory,
  tools: myTools,
});
```

就这么简单。历史压缩、工具结果截断和 token 预算跟踪都在幕后自动完成。

## 历史压缩

当对话超过 token 预算时，middleware 压缩较旧的消息腾出空间。两种模式：

**不配压缩模型**（默认）—— 旧消息被丢弃，只保留近期消息：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
});
```

**配压缩模型** —— 旧消息先由便宜的模型摘要再替换：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: {
    model: openai('gpt-4o-mini'),  // cheap model for summarization
    preserveRatio: 0.8,             // keep 80% of context for recent messages
  },
});
```

> **在途 vs 持久化。** middleware 的 `compress` 是*在途*的：它重写每次外发请求，但**不会**改动你的消息存储。对*持续*超预算的对话，摘要每次调用后被丢弃、历史重新膨胀。偶发尖峰没问题；持续场景请通过 `onCompress` **持久化**摘要，或用 `compactModelMessages` 压缩你自己的存储（推荐 —— 见[持久化压缩](/zh/guide/durable-compaction)）。`compress` 反复触发而没配 `onCompress` 时，middleware 会打一次性警告。

## Anthropic 服务端上下文管理

`@ai-sdk/anthropic` 可以通过 `providerOptions.anthropic.contextManagement` 把上下文管理交给 Anthropic API 本身（`compact_20260112`、`clear_tool_uses_20250919`、`clear_thinking_20251015` 等 edits）。如果某次调用声明了该选项**且** middleware 也配置了压缩，同一段历史会被管理两次 —— 这里一次，服务端再一次。

middleware 按调用检测并**跳过自己的压缩步骤**（服务端优先），给出一次性警告。`truncate`、`compact`、`clear`、`dynamicState`、`skill` 照常运行 —— 只有压缩步骤让位。

想有意两边都跑 —— 例如 middleware 压缩调得远低于服务端触发线 —— 关掉防护：

```typescript
const model = withContextChef(anthropic('claude-sonnet-4-6'), {
  contextWindow: 200_000,
  compress: { model: anthropic('claude-haiku-4-5') },
  allowDoubleCompression: true, // skip the guard: no skip, no warning
});
```

## 工具结果截断

大体积工具输出（终端日志、API 响应）自动截断，保留首尾：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
  },
});
```

可选地通过 storage adapter 持久化原始内容，供工具、审计管道或回放层稍后取回：

```typescript
import { FileSystemAdapter } from '@context-chef/core';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    headChars: 500,
    tailChars: 1000,
    storage: new FileSystemAdapter('.context_vfs'), // or your own DB adapter
  },
});
```

当 adapter 暴露物理路径时（`FileSystemAdapter` 通过 `getPhysicalPath` 开箱支持），截断标记会把该路径作为首选取回句柄 —— 模型用标准的文件读取工具就能读回，无需自定义 URI 工具。不映射到文件系统的 adapter 则回退为仅 `context://vfs/` URI。

通过 `perTool` 做按工具覆盖 —— 裸字符串表示整体保留该工具（同时绕过 storage），对象条目为该工具覆盖 `threshold` / `headChars` / `tailChars`：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    tailChars: 1000,
    perTool: [
      'read_file',                                 // never truncate; not stored in VFS
      { name: 'fetch_logs', threshold: 50_000 },   // higher threshold
      { name: 'big_query', tailChars: 5000 },      // bigger tail
    ],
  },
});
```

## 会话隔离（多用户服务）

wrapped model 通常在模块层创建一次、跨请求复用。压缩状态（fed token 用量、压缩抑制、失败熔断器）按**会话**跟踪 —— 每次调用通过 `providerOptions` 传 `sessionId`，并发对话就不会共享状态：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
});

// Per request:
const result = await generateText({
  model,
  messages,
  providerOptions: { contextChef: { sessionId: conversationId } },
});
```

不带 `sessionId` 的调用共享一个默认会话 —— 单对话进程没问题，多用户服务则是错误用法。最多并发跟踪 `maxSessions` 个会话（默认 256，LRU 淘汰）。

## Compact（机械裁剪）

零 LLM 成本的消息裁剪，走 AI SDK 的 `pruneMessages` —— 移除 reasoning、tool call 和空消息：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compact: {
    reasoning: 'all',                          // Remove all reasoning
    toolCalls: 'before-last-message',          // Keep tools only in the last message
  },
});
```

## API 一览

| 导出 | 作用 |
|---|---|
| `withContextChef(model, options)` | 包装 AI SDK model；返回可在任何原 model 位置使用的 `LanguageModelV3` |
| `createMiddleware(options)` | 原始 `LanguageModelMiddleware`，配合 `wrapLanguageModel` 使用 |
| `fromAISDK(prompt)` / `toAISDK(messages)` | `LanguageModelV3Prompt` 与 ContextChef IR 的互转 |
| `summarizeMessages(prompt, model, opts?)` | 摘要一段 AI-SDK prompt 切片（已含角色扁平化） |
| `compactModelMessages(messages, model, opts)` | `ModelMessage` 层一步到位的持久化压缩 |
| `planCompactionModelMessages(messages, opts)` | 其背后的同步轮次安全切分 |
| `summarizeModelMessages(messages, model, opts?)` | `ModelMessage` 层摘要器 |

`withContextChef` 关键选项：`contextWindow`（必填）、`compress`（`model`、`preserveRatio`、`toolResultStubThreshold`、`usagePreference`）、`allowDoubleCompression`、`truncate`（`threshold`、`headChars`、`tailChars`、`storage`、`perTool`）、`compact`、`clear`、`tokenizer`、`onCompress`、`logger`。完整选项表见 [GitHub 上的完整 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/ai-sdk-middleware)。

## 工作原理

```
generateText / streamText / ToolLoopAgent ({ model: wrappedModel, messages })
  |
  v
transformParams (before LLM call)
  1. Truncate large tool results (if configured)
     - Optionally persist originals to storage adapter
  2. Convert AI SDK messages -> context-chef IR
  3. Run Janitor compression (if over token budget)
  4. Convert back to AI SDK messages
  |
  v
LLM call executes normally
  |
  v
wrapGenerate / wrapStream (after LLM call)
  5. Extract token usage from response
  6. Feed back to Janitor for next call's budget check
  |
  v
Result returned unchanged
```

middleware 是**有状态的** —— 它跨调用跟踪 token 用量以判断何时需要压缩。

## 需要更多控制？

动态状态注入、工具 namespace、记忆、快照/恢复等高级特性，请直接使用 [`@context-chef/core`](/zh/packages/core)。

## 链接

- [npm — @context-chef/ai-sdk-middleware](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
- [源码与完整 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/ai-sdk-middleware)
