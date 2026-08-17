# 持久化压缩

在途压缩重写每次外发的 payload，但不会碰你的消息存储 —— 对一段持续超预算的对话，摘要在每次调用时都要重新计算。当消息存储归你管时，把它压缩一次并持久化结果。本页覆盖 core 里的持久化压缩 helper 及其 AI SDK / TanStack AI 移植版。

三个 helper 都在原子轮次边界处切分（assistant 消息和它的 tool result 永不分离），摘要旧切片，返回 `[...system, <summary>, ...recent turns]`；no-op 时原样返回输入引用，因此可用 `result === input` 跳过持久化。

## Core —— 与 provider 无关，作用于 IR `Message[]`

```typescript
import { compactHistory, planCompaction } from "@context-chef/core";

// myCompressFn must role-flatten tool messages (same contract as summarizeHistory)
history = await compactHistory(history, myCompressFn, { keepRecentTurns: 4 });
// planCompaction(history, { keepRecentTurns }) is the synchronous split behind it
```

## Vercel AI SDK —— `ModelMessage` 层，已为你接好角色扁平化

```typescript
import { compactModelMessages } from "@context-chef/ai-sdk-middleware";

messages = await compactModelMessages(messages, openai("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

在自己的循环里跑（自己管存储、把结果写回去），或放进 `ToolLoopAgent`：

```typescript
import { compactModelMessages } from '@context-chef/ai-sdk-middleware';

const agent = new ToolLoopAgent({
  model,
  tools,
  prepareStep: async ({ messages, model }) => ({
    messages: await compactModelMessages(messages, model, { keepRecentTurns: 4 }),
  }),
});
```

关键特性：

- `model` 就是 `ai` 的 `LanguageModel`（`string id | V3 | V2`）—— `prepareStep` / `generateText` 给你的正是它。
- 切分只落在**轮次边界**上（assistant 和它的 tool result 保持在一起），永远不会孤立 tool result、也不会拆开多 block 的 assistant 消息。
- system 消息原样保留，永不被摘要。
- 当没有足够旧的内容可压缩或摘要器没产出文本时，返回**同一个 `messages` 引用** —— 用 `next !== messages` 跳过持久化。可以无条件调用；只有模型调用抛出时才抛。
- 接受与 `summarizeMessages` 相同的 `SummarizeMessagesOptions`（`customCompressionInstructions`、`toolResultStubThreshold`）。

> **`keepRecentTurns` 是消息级别的轮次，不是 `ToolLoopAgent` 的 step。** 一个轮次是一条 user/assistant 消息，或一个 assistant 带上它全部 tool result（保持在一起）。一个用工具的 step 往往是 2–3 个轮次，所以按你最坏情况的 step 来设定 `keepRecentTurns` —— 工具密集的 agent loop 需要比普通聊天更大的值。摘要作为 `user` 消息插入，所以当保留的尾巴也以 user 轮开头时，结果可能出现两条相邻的 `user` 消息 —— 这是合法的 `ModelMessage[]`，AI SDK 的 provider 层会做归一化（Anthropic 合并同角色，OpenAI 直接接受）。

## TanStack AI —— 接受任意 TanStack text adapter

```typescript
import { compactTanStackMessages } from "@context-chef/tanstack-ai";

messages = await compactTanStackMessages(messages, openaiText("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

- `planCompactionTanStackMessages(messages, { keepRecentTurns })` —— 轮次安全地切分为 `{ toSummarize, toKeep }`（没有 `system` 切片：TanStack AI 的 system prompt 不在 `messages` 里）。
- `compactTanStackMessages(messages, adapter, options)` —— 一步到位：切分、摘要、返回 `[<summary>, ...toKeep]`。no-op 时原样返回输入引用。
- `summarizeTanStackMessages(messages, adapter, opts?)` —— 只要摘要字符串，管道与 `compress` 相同。

## 完整压缩（Claude Code 风格）

`keepRecentTurns: 0` 即完整的 Claude Code 式压缩 —— 整个对话坍缩为 `[...system, <summary>]`，没有原文尾巴。这是最容易持久化的模式：因为没有保留尾巴，就不需要对齐你存储自己的单元边界 —— 写回就是「用两条消息的结果替换整个存储」。

代价是**没有任何原文近期上下文幸存** —— 模型只能从有损摘要继续。所以摘要质量就是一切；用 `customCompressionInstructions` 把它导向结构化交接：

```typescript
const next = await compactModelMessages(messages, summarizerModel, {
  keepRecentTurns: 0, // full compaction — collapse everything into the summary
  customCompressionInstructions: [
    'Write the summary as a handoff for resuming the task:',
    '- What was accomplished and the current state',
    '- Decisions made and why they were made',
    '- Files / resources touched',
    '- The exact next step to take',
  ].join('\n'),
});
// `next` is now [system, summary] — trivial to persist, no boundary bookkeeping.
```

想让进行中的轮次原文保留（自治 loop 任务中更安全），选小一点的 `keepRecentTurns`（如 `2`–`4`）；想要最大缩减和干净、无边界记账的存储，选 `0`。

## 切分与摘要分开做

想只要边界不做摘要（自己持久化 marker，或用别的摘要器）时，用同步切分 + 独立摘要器：

```typescript
import { planCompactionModelMessages, summarizeModelMessages } from '@context-chef/ai-sdk-middleware';
import { Prompts } from '@context-chef/core';

const { system, toSummarize, toKeep } = planCompactionModelMessages(messages, { keepRecentTurns: 4 });
if (toSummarize.length > 0) {
  const summary = await summarizeModelMessages(toSummarize, model);
  messages = [
    ...system,
    { role: 'user', content: [{ type: 'text', text: Prompts.getCompactSummaryWrapper(summary) }] },
    ...toKeep,
  ];
}
```

## 不要双重压缩

不要在同一段对话上同时使用持久化压缩和在途压缩（[Janitor](/zh/guide/history-compression) 或 middleware `compress`）—— 那会把同一段历史压缩两次。每段对话选一种策略。完整契约见 [core](/zh/packages/core)、[ai-sdk-middleware](/zh/packages/ai-sdk-middleware) 和 [tanstack-ai](/zh/packages/tanstack-ai) 的包页面。
