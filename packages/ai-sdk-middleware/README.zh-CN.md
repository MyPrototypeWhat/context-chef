# @context-chef/ai-sdk-middleware

[![npm version](https://img.shields.io/npm/v/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![License](https://img.shields.io/npm/l/@context-chef/ai-sdk-middleware.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v6-black.svg)](https://ai-sdk.dev)

基于 [context-chef](https://github.com/MyPrototypeWhat/context-chef) 的 [Vercel AI SDK](https://ai-sdk.dev) 中间件。透明的历史压缩、工具结果截断和 token 预算管理 — 无需修改任何代码。

[English](./README.md)

![Quick Start](../../@context-chef_ai-sdk-middleware.png)

## 安装

```bash
npm install @context-chef/ai-sdk-middleware ai
```

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

// 下面的代码完全不变 — 兼容 generateText、streamText 和 ToolLoopAgent
const result = await generateText({
  model,
  messages: conversationHistory,
  tools: myTools,
});
```

就这样。历史压缩、工具结果截断和 token 预算追踪在后台自动完成。

## 功能

### 历史压缩

当对话超出 token 预算时，中间件会压缩旧消息以腾出空间。两种模式：

**不配置压缩模型**（默认）— 旧消息被丢弃，仅保留近期消息：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
});
```

**配置压缩模型** — 旧消息由便宜模型生成摘要后替换：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: {
    model: openai('gpt-4o-mini'),  // 用于摘要的便宜模型
    preserveRatio: 0.8,             // 保留 80% 的上下文给近期消息
  },
});
```

### 工具结果截断

大体积工具输出（终端日志、API 响应）会被自动截断，同时保留头部和尾部：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,   // 超过 5000 字符时截断
    headChars: 500,    // 保留开头 500 字符
    tailChars: 1000,   // 保留结尾 1000 字符
  },
});
```

可选地通过存储适配器持久化原始内容，LLM 后续可通过 `context://vfs/` URI 按需检索：

```typescript
import { FileSystemAdapter } from '@context-chef/core';

const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    headChars: 500,
    tailChars: 1000,
    storage: new FileSystemAdapter('.context_vfs'), // 或自定义数据库适配器
  },
});
```

### Token 预算追踪

中间件自动从 `generateText` 和 `streamText` 响应中提取 token 用量，并回传给压缩引擎。无需手动调用 `reportTokenUsage()`。

### Compact（机械裁剪）

零 LLM 成本的消息裁剪，基于 AI SDK 的 `pruneMessages` — 移除 reasoning、工具调用和空消息：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compact: {
    reasoning: 'all',                          // 移除所有 reasoning
    toolCalls: 'before-last-message',          // 仅保留最后一条消息中的工具调用
  },
});
```

也支持按工具名称精细控制：

```typescript
compact: {
  toolCalls: [
    { type: 'before-last-message', tools: ['search', 'calculator'] },
  ],
}
```

## API

### `withContextChef(model, options)`

用 context-chef 中间件包装 AI SDK 语言模型。

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';

const wrappedModel = withContextChef(model, options);
```

**参数：**

| 选项 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contextWindow` | `number` | 是 | 模型的上下文窗口大小（token 数） |
| `compress` | `CompressOptions` | 否 | 启用基于 LLM 的压缩 |
| `compress.model` | `LanguageModelV3` | 是（如启用 compress） | 用于摘要的便宜模型 |
| `compress.preserveRatio` | `number` | 否 | 保留上下文的比例（默认：`0.8`） |
| `truncate` | `TruncateOptions` | 否 | 启用工具结果截断 |
| `truncate.threshold` | `number` | 是（如启用 truncate） | 触发截断的字符数 |
| `truncate.headChars` | `number` | 否 | 保留开头的字符数（默认：`0`） |
| `truncate.tailChars` | `number` | 否 | 保留结尾的字符数（默认：`1000`） |
| `truncate.storage` | `VFSStorageAdapter` | 否 | 截断前持久化原始内容的存储适配器 |
| `compact` | `CompactConfig` | 否 | 机械消息裁剪（reasoning、工具调用）。委托给 AI SDK 的 `pruneMessages` |
| `tokenizer` | `(msgs) => number` | 否 | 自定义分词器用于精确计数 |
| `onCompress` | `(summary, count) => void` | 否 | 压缩完成后的回调 |

**返回值：** `LanguageModelV3` — 包装后的模型，可在任何使用原模型的地方直接替换。

### `createMiddleware(options)`

创建原始 `LanguageModelMiddleware`，可通过 `wrapLanguageModel` 自行应用：

```typescript
import { createMiddleware } from '@context-chef/ai-sdk-middleware';
import { wrapLanguageModel } from 'ai';

const middleware = createMiddleware({ contextWindow: 128_000 });
const model = wrapLanguageModel({ model: openai('gpt-4o'), middleware });
```

### `fromAISDK(prompt)` / `toAISDK(messages)`

AI SDK `LanguageModelV3Prompt` 与 context-chef `Message[]` IR 之间的底层转换器。适用于直接使用 context-chef 模块处理 AI SDK 消息格式的场景。

```typescript
import { fromAISDK, toAISDK } from '@context-chef/ai-sdk-middleware';

const irMessages = fromAISDK(aiSdkPrompt);
// ... 用 context-chef 模块处理 ...
const aiSdkPrompt = toAISDK(irMessages);
```

## 工作原理

```
generateText / streamText / ToolLoopAgent ({ model: wrappedModel, messages })
  |
  v
transformParams（LLM 调用前）
  1. 截断大体积工具结果（如已配置）
     - 可选持久化原始内容到存储适配器
  2. AI SDK 消息 -> context-chef IR
  3. 运行 Janitor 压缩（如超出 token 预算）
  4. 转换回 AI SDK 消息
  |
  v
LLM 调用正常执行
  |
  v
wrapGenerate / wrapStream（LLM 调用后）
  5. 从响应中提取 token 用量
  6. 回传给 Janitor 用于下次调用的预算检查
  |
  v
结果原样返回
```

中间件是**有状态的** — 它跨调用追踪 token 用量以判断何时需要压缩。每个对话/会话创建一个包装模型实例。

## 需要更多控制？

中间件覆盖了最常见的场景：透明的压缩和截断。如需动态状态注入、工具命名空间、记忆或快照/恢复等高级功能，请直接使用 [`@context-chef/core`](https://www.npmjs.com/package/@context-chef/core)。

## 许可证

ISC
