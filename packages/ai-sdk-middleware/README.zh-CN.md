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

> **In-flight 与 durable 的区别。** 中间件的 `compress` 是 *in-flight* 的：它只重写每次发出去的请求，**不会**改动你的消息存储。所以对于**持续超预算**的对话（长聊天，或长的多步 loop），摘要每次调用后即被丢弃、历史随即回胀 —— 压缩实际上只会隔次触发,payload 还会持续增长。一次性尖峰无所谓;若是持续场景,请通过 `onCompress` **持久化**摘要,或用 [`compactHistory`](#compacthistoryprompt-model-options) 压缩你自己的存储(推荐)。若 `compress` 反复触发却没配 `onCompress`,中间件会打印一次告警。

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

可选地通过存储适配器持久化原始内容，方便后续被工具、审计流水线或回放层取回：

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

当适配器暴露物理路径（`FileSystemAdapter` 通过 `getPhysicalPath` 默认就支持），截断 marker 会把该路径作为首选的取回句柄输出 —— 模型用现成的 file-read 工具直接读取即可，不必另写一个识别自定义 URI 的工具。不映射到文件系统的适配器（DB、内存）则不实现 `getPhysicalPath`，marker 退化为单独的 `context://vfs/` URI。

通过 `perTool` 做按工具覆写 —— 字符串条目完全保留该工具（同时跳过 VFS 写入），对象条目则只针对该工具覆盖 `threshold` / `headChars` / `tailChars`：

```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: {
    threshold: 5000,
    tailChars: 1000,
    perTool: [
      'read_file',                                 // 永不截断；也不写入 VFS
      { name: 'fetch_logs', threshold: 50_000 },   // 提高阈值
      { name: 'big_query', tailChars: 5000 },      // 保留更多尾部
    ],
  },
});
```

未列出的工具继续使用顶层默认值。查找键是 `tool-result.toolName`，过滤粒度是**单个 `tool-result` part** —— 因此同一条 tool 消息可以混合保留与截断的 part。（TanStack 中间件的同名选项粒度是**单条消息**，因为 TanStack 的一条 tool 消息对应一次 tool 调用。）不支持通配符，`storage` 也无法按工具覆写。`perTool` 只控制 truncate 这一步 —— 保留下来的消息仍可能被 `compact` 整条删除（若 `compact.toolCalls` 命中）、被 `compress` 在超出 token 预算时摘要，或被 `transformContext` 改写。

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
| `compress.toolResultStubThreshold` | `number` | 否 | 在把待摘要历史送给 compression model 之前，将超过该字符数的 tool-result 内容替换为一行元信息桩（`[Tool name returned N chars; omitted before summarization]`）。近期保留的 tool-result 不动。默认：undefined（关闭）。 |
| `compress.usagePreference` | `'max' \| 'feedFirst' \| 'tokenizerFirst'` | 否 | 当 `tokenizer` 与 AI SDK 上报的 usage 同时存在时，决定触发判断使用哪个 token 来源。默认 `'max'`（最保守 — `Math.max(tokenizer, fed)`）。`'feedFirst'` 信任 API 真值，避免 tokenizer 高估导致的提前压缩；`'tokenizerFirst'` 完全忽略上报的 usage。`'tokenizerFirst'` 需要 `tokenizer`，缺失时构造期会被消毒为 `'max'` 并打印控制台警告。 |
| `truncate` | `TruncateOptions` | 否 | 启用工具结果截断 |
| `truncate.threshold` | `number` | 是（如启用 truncate） | 触发截断的字符数 |
| `truncate.headChars` | `number` | 否 | 保留开头的字符数（默认：`0`） |
| `truncate.tailChars` | `number` | 否 | 保留结尾的字符数（默认：`1000`） |
| `truncate.storage` | `VFSStorageAdapter` | 否 | 截断前持久化原始内容的存储适配器 |
| `truncate.perTool` | `Array<string \| { name; threshold?; headChars?; tailChars? }>` | 否 | 按工具覆写。字符串 = 保留（同时跳过存储）；对象 = 为该工具覆写参数。重复名称时后者胜出。 |
| `compact` | `CompactConfig` | 否 | 机械消息裁剪（reasoning、工具调用）。委托给 AI SDK 的 `pruneMessages` |
| `tokenizer` | `(msgs) => number` | 否 | 自定义分词器用于精确计数 |
| `onCompress` | `(summary, count, details) => void` | 否 | 压缩完成后的回调。`details.compressedMessages` 是被摘要替换掉的 AI SDK 格式（`LanguageModelV3Prompt`）切片，可用于在自有存储中持久化摘要边界。 |
| `logger` | `ChefLogger` | 否 | 降级警告的输出目标（存储写入失败、缺少 usage 数据、配置异常等），默认 `console`。转发给底层 Janitor 和 Offloader。 |
| `clear` | `ClearTarget[]` | 否 | 占位符式的 **tool-result** 清除。被清除的工具结果变为 `'[Old tool result content cleared]'`——消息结构保持完整，与删除内容的 `compact` 不同。在压缩之后执行。当工具结果被清除时，自动注入一条系统消息以避免模型将占位符读作错误。仅 `'tool-result'` 目标生效；`'thinking'` 目标为空操作（会记录一条警告）——请用 `compact: { reasoning: ... }` 删除 reasoning。`ClearTarget` 从 `@context-chef/core` 导出。 |

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

### `summarizeMessages(prompt, model, options?)`

将一段 AI SDK prompt 切片摘要为单个字符串，使用与在途压缩相同的流水线。它会先 `fromAISDK`、丢弃 system 消息，再以内置的角色扁平化适配器调用 core 的 `summarizeHistory` —— 因此你无需自行扁平化 `tool` 角色。返回提取出的摘要文本；空 prompt 不调用模型直接返回 `''`，模型调用失败时抛出异常。

适用于**持久化压缩**：由宿主自己拥有对话存储并自行持久化压缩结果，而非依赖中间件的透明压缩。

```typescript
import { summarizeMessages } from '@context-chef/ai-sdk-middleware';

const summary = await summarizeMessages(promptSlice, model, {
  toolResultStubThreshold: 5000,
});
// 自行持久化 { summary, boundary }；之后回放 [summary] + [recent]。
```

`SummarizeMessagesOptions` 是 core `SummarizeHistoryOptions` 的结构别名（`customCompressionInstructions`、`toolResultStubThreshold`）。如需「续接对话」的框架文本，用 `@context-chef/core` 的 `getCompactSummaryWrapper` 包裹返回值。

> **协调注意：** 若以此方式驱动摘要，请**不要**在同一中间件路径上对同一对话再配置 `compress`（带 `model`）—— 那会重复压缩（调用时一次、持久化时再一次）。仅做通知的 `onCompress`，以及 `truncate`、`clear`、`dynamicState` 可安全并用。

### `compactHistory(prompt, model, options)`

**一站式 durable 压缩** —— 当你拥有消息存储时（长 agent loop，或超预算的聊天），让长对话保持精简的推荐方式。它在 turn 边界切分历史、对旧切片摘要,返回一份可直接持久化的新 prompt —— `[...system, <摘要>, ...最近若干轮]`：

```typescript
import { compactHistory } from '@context-chef/ai-sdk-middleware';

// 在模型调用之间,当你持有 `messages` 时:
messages = await compactHistory(messages, summarizerModel, {
  keepRecentTurns: 4,           // 逐字保留最近 4 个原子轮次
  toolResultStubThreshold: 5000,
});
// 持久化结果 —— 历史真正变小并保持精简。
```

- 切点只落在 **turn 边界**(assistant 及其 tool 结果作为整体),所以不会 orphan tool 结果、也不会切进多 block 的 assistant 消息。
- system 消息逐字保留、永不被摘要。
- 当没有足够旧的内容可压(轮数少于 `keepRecentTurns`)、或摘要器无输出时,**原样返回** prompt —— 可无条件调用。仅当模型调用抛错时才抛错。
- 接受与 `summarizeMessages` 相同的 `SummarizeMessagesOptions`(`customCompressionInstructions`、`toolResultStubThreshold`)。

> 对同一对话用这个**或** in-flight `compress`,二选一(同时用会重复压缩)。

### `planCompaction(prompt, options)`

`compactHistory` 背后的同步切分函数,适用于只要边界、不想立刻摘要的场景(持久化你自己的标记,或用别的摘要器)。返回 `{ system, toSummarize, toKeep }`(均为 `LanguageModelV3Prompt`),按 turn 边界切分:

```typescript
import { planCompaction, summarizeMessages } from '@context-chef/ai-sdk-middleware';
import { Prompts } from '@context-chef/core';

const { system, toSummarize, toKeep } = planCompaction(messages, { keepRecentTurns: 4 });
if (toSummarize.length > 0) {
  const summary = await summarizeMessages(toSummarize, model);
  messages = [
    ...system,
    { role: 'user', content: [{ type: 'text', text: Prompts.getCompactSummaryWrapper(summary) }] },
    ...toKeep,
  ];
}
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

MIT
