# @context-chef/tanstack-ai

由 ContextChef 驱动的 [TanStack AI](https://tanstack.com/ai) `ChatMiddleware` —— 透明的历史压缩、工具结果截断和 token 预算管理，一个 middleware 即插即用。

[![npm version](https://img.shields.io/npm/v/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg)](https://www.npmjs.com/package/@context-chef/tanstack-ai)

要求 `@tanstack/ai` **^0.44**（2026-03 middleware 重构版）。使用重构前的 `^0.10` API 请用 `@context-chef/tanstack-ai@0.x`。

## 安装

```bash
npm install @context-chef/tanstack-ai @tanstack/ai
```

## 快速开始

```typescript
import { contextChefMiddleware } from '@context-chef/tanstack-ai';
import { chat } from '@tanstack/ai';
import { openaiText } from '@tanstack/ai-openai';

const stream = chat({
  adapter: openaiText('gpt-4o'),
  messages,
  threadId: 'conversation-1', // keys per-conversation compression state
  middleware: [
    contextChefMiddleware({
      contextWindow: 128_000,
      compress: { adapter: openaiText('gpt-4o-mini') },
      truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
    }),
  ],
});
```

## 特性

### 历史压缩

当对话超过 token 预算时，middleware 压缩较旧的消息腾出空间。只要配置了压缩相关选项（`compress`、`onCompress`、`onBeforeCompress`），`contextWindow` 就是**必填**的；不含压缩的配置则不需要它。

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  compress: {
    adapter: openaiText('gpt-4o-mini'), // cheap adapter for summarization
    preserveRatio: 0.8,                 // keep 80% of context for recent messages
  },
})
```

### 工具结果截断

```typescript
contextChefMiddleware({
  truncate: {
    threshold: 5000,   // truncate tool results over 5000 chars
    headChars: 500,    // preserve first 500 chars
    tailChars: 1000,   // preserve last 1000 chars
    // storage: new FileSystemAdapter('.context_vfs'),
    perTool: [
      'read_file',                                 // never truncate; not stored in VFS
      { name: 'fetch_logs', threshold: 50_000 },   // higher threshold
    ],
  },
})
```

`perTool` 的查找 key 是工具名 —— 优先读 `ModelMessage.name`，否则通过 `toolCallId` 从前一条 assistant 轮次的 `toolCalls[].function.name` 解析。正是这个回退让 `perTool` 在标准 `chat()` 流程下也能工作。

### 会话隔离

压缩状态（fed token 用量、压缩后标记、失败熔断器）按 `ctx.threadId` 跟踪，一个 middleware 实例可以安全服务多段对话。给 `chat()` 传 `threadId`（`conversationId` 是仍可用的废弃别名）；不传的调用会拿到按 run 自动生成的 id —— run 内隔离，但跨调用无连续性。最多并发跟踪 `maxSessions` 段对话（默认 256，LRU 淘汰）。

### Compact（机械裁剪）

零 LLM 成本的消息裁剪 —— 在压缩前移除 reasoning、tool call/result 对和空消息（AI SDK `pruneMessages` 语义）：

```typescript
contextChefMiddleware({
  compact: {
    reasoning: 'all',                 // strip thinking arrays
    toolCalls: 'before-last-message', // keep tools referenced by the last message
    emptyMessages: 'remove',          // strip empty messages (default)
  },
})
```

`toolCalls` 模式：`'all'`、`'before-last-message'`、`'before-last-${N}-messages'`、`'none'`（默认），以及按工具控制的数组形式 `[{ type: 'all', tools: ['search'] }]`。

### Clear（占位式清除）

`clear` 替换内容而不删除消息，保持结构和 tool-call 配对完整。它在压缩**之后**运行，所以摘要器仍能看到完整内容：

```typescript
contextChefMiddleware({
  clear: [
    { target: 'tool-result', keepRecent: 2 }, // older results → '[Old tool result content cleared]'
    'thinking',                               // strip reasoning from assistant messages
  ],
})
```

当 tool result 被清除时，会自动往 `systemPrompts` 追加一条解释指令，避免模型把占位符误读为错误。

### 动态状态注入

```typescript
contextChefMiddleware({
  dynamicState: {
    getState: () => ({ step: 3, status: 'researching', pendingTools: ['search'] }),
    placement: 'last_user', // or 'system'
  },
})
```

状态序列化为 XML 后注入最后一条 user 消息（利用近因偏置）或作为 system prompt。`getState` 在初始化和每次 agent 迭代时调用；之前注入的块会被**替换**，永不重复。打开 `appendOnly` 时，`getState` 只在每次模型调用的触发里运行，初始化时不调用，也不再替换：状态变化时追加一条新的 user 消息，之前的留在发送时的位置。

### Skill 注入

```typescript
contextChefMiddleware({
  skill: () => activeSkill, // Skill | null | undefined, sync or async
})
```

### Transform Context 钩子

```typescript
contextChefMiddleware({
  transformContext: (messages, systemPrompts, ctx) => ({
    messages: [...messages, { role: 'user', content: ragContext }],
    systemPrompts: [...systemPrompts, 'Use the RAG context above.'],
  }),
})
```

`transformContext` 在每次 `onConfig` 触发时运行（初始化 + 每次 agent 迭代），其输出会带入下一次触发 —— 请保证幂等，或用 `ctx.phase === 'init'` 做闸门。打开 `appendOnly` 时，`init` 原样放行，它只在每次模型调用的触发里、在对话被记录之后运行，添加的内容也不会被带入下一次：它添加或改动的内容，每次调用都必须完全一样、位置也一样。每次调用都会变的内容请放进 `dynamicState`。

### Append-only 模式

Claude Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5 会拒绝这样的请求：回放的 thinking 前面有任何内容发生了变化；所有 provider 的提示缓存也会从第一条被改动的消息开始失效。默认情况下，middleware 每轮迭代都会替换它的 dynamic state 块，超出预算时每次调用都重新计算压缩摘要。打开 `appendOnly: true` 后，每次模型调用的请求都重复这个对话上一次发出的内容，只在末尾追加；仍然会改写它的操作都是检查点，报告给 `onPrefixBreak`。

```typescript
// 只创建一次，每次 chat() 调用都复用
const contextChef = contextChefMiddleware({
  appendOnly: true,
  contextWindow: 200_000,
  compress: { adapter: summarizerAdapter },
  onPrefixBreak: (event) => console.info(event),
});

const stream = chat({ adapter, messages, threadId: conversationId, middleware: [contextChef] });
```

每个对话传自己的 `threadId`（不传的话每次 run 都从空白开始），middleware 只创建一次。`dynamicState` 变成独立的 user 消息，每次变化只追加一次；压缩只落地一次；检查点只剥带签名的 thinking。其他 middleware 不能修改本 middleware 返回的消息；持久化时保存客户端的对话，而不是引擎的消息。完整规则见 [Append-only 前缀](/zh/guide/append-only#tanstack-ai-的细节)。

### 永不打断 host run

在 `@tanstack/ai` 0.44 中，middleware 钩子抛异常会让整个 `chat()` run 失败。本 middleware 包裹每个钩子体：遇到意外错误时通过配置的 `logger` 记录，并原样透传请求，而不是打断你的调用。

## 持久化压缩

middleware 压缩的是引擎的在途状态 —— 你自己的消息存储不受影响。当存储归你管时，在调用之间做持久化压缩：

```typescript
import { compactTanStackMessages } from '@context-chef/tanstack-ai';
import { openaiText } from '@tanstack/ai-openai';

// Between chat() calls:
const compacted = await compactTanStackMessages(storedMessages, openaiText('gpt-4o-mini'), {
  keepRecentTurns: 6,
});
if (compacted !== storedMessages) {
  await store.replaceMessages(conversationId, compacted); // persist [summary, ...kept]
}
```

- `planCompactionTanStackMessages(messages, { keepRecentTurns })` —— 轮次安全地切分为 `{ toSummarize, toKeep }`。
- `compactTanStackMessages(messages, adapter, options)` —— 一步到位：切分、摘要、返回 `[<summary>, ...toKeep]`。no-op 时原样返回输入引用。
- `summarizeTanStackMessages(messages, adapter, opts?)` —— 只要摘要字符串。

不要在同一段对话上同时使用持久化压缩和 middleware `compress`（双重压缩）。见[持久化压缩](/zh/guide/durable-compaction)。

## API 一览

| 导出 | 作用 |
|---|---|
| `contextChefMiddleware(options)` | 创建可放进 `chat()` middleware 数组的 `ChatMiddleware` |
| `fromTanStackAI(messages)` / `toTanStackAI(messages)` | TanStack AI `ModelMessage[]`（0.44 shape）与 ContextChef IR 的互转 |
| `createCompressionAdapter(adapter)` | 把任意 TanStack text adapter 适配成 core 期望的 `(messages) => Promise<string>` 回调 |
| `compactTanStackMessages` / `planCompactionTanStackMessages` / `summarizeTanStackMessages` | 持久化压缩 helper |

`contextChefMiddleware` 关键选项：`contextWindow`（仅压缩时必填）、`compress`（`adapter`、`preserveRatio`、`toolResultStubThreshold`、`usagePreference`）、`truncate`、`compact`、`clear`、`dynamicState`、`skill`、`tokenizer`、`maxSessions`、`onCompress`、`onBeforeCompress`、`transformContext`、`logger`、`appendOnly`、`onPrefixBreak`。`compactTanStackMessages` / `planCompactionTanStackMessages` 还接受 `keptReasoning: 'strip'`（[原因](/zh/guide/durable-compaction#保留轮次的推理)）。完整选项表见 [GitHub 上的完整 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/tanstack-ai)。

## 工作原理

```
chat({ adapter, messages, systemPrompts, threadId, middleware: [contextChefMiddleware(opts)] })
  |
  v
onConfig (phase 'init', then 'beforeModel' at every agent iteration)
  1. Truncate large tool results (if configured)
  2. Convert TanStack AI messages -> context-chef IR
  3. Compact: strip reasoning / tool pairs / empty messages (zero cost)
  4. Janitor compression (if over token budget; budgeting configs only)
  5. Clear: placeholder old tool results / strip thinking (if configured)
  6. Convert back to TanStack AI messages
  7. Inject skill instructions + clear explainer into systemPrompts (idempotent)
  8. Inject dynamic state (replaced per iteration)
  9. Apply transformContext hook
  -> return { messages, systemPrompts }  (engine merges the partial config)
  |
  v
model iteration executes normally
  |
  v
onUsage (after each model iteration)
  10. Extract promptTokens from usage
  11. Feed back to the conversation's Janitor for the next budget check
```

**打开 `appendOnly` 时**流程不同。`init` 触发原样放行，工作发生在每次模型调用的触发里（`beforeModel`、`structuredOutput`）。middleware 先读回引擎从它上一次触发带过来的内容，`clear` 在压缩之前运行，对话的 ledger 会重放之前调用发出的内容：压缩只落地一次，不再重算；dynamic state 在变化时作为一条 user 消息事件追加，不会被替换，也不会放进 `systemPrompts`。ledger 没有保留的请求不计入用量：结构化输出那次调用，以及 middleware 的 config 步骤失败后原样放行的请求。见 [Append-only 前缀](/zh/guide/append-only#tanstack-ai-的细节)。

## 需要更多控制？

工具 namespace、核心记忆、快照/恢复等高级特性，请直接使用 [`@context-chef/core`](/zh/packages/core)。

## 链接

- [npm — @context-chef/tanstack-ai](https://www.npmjs.com/package/@context-chef/tanstack-ai)
- [源码与完整 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/tanstack-ai)
