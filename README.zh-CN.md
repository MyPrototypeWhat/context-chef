# ContextChef

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/core Downloads](https://img.shields.io/npm/dm/@context-chef/core.svg?label=%40context-chef%2Fcore%20downloads)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/ai-sdk-middleware Downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg?label=%40context-chef%2Fai-sdk-middleware%20downloads)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![@context-chef/tanstack-ai Downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg?label=%40context-chef%2Ftanstack-ai%20downloads)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/core.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="./ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

TypeScript/JavaScript AI Agent 的上下文编译器。

ContextChef 解决 AI Agent 开发中最常见的上下文工程问题：对话太长模型会忘事、工具太多模型会幻觉、切换模型要重写 prompt、长程任务状态丢失。它不接管你的控制流，只负责在每次 LLM 调用前把你的状态编译成最优的 payload。

[English](./README.md)

## Packages

| 包 | 说明 |
|---|---|
| [`@context-chef/core`](./packages/core) | 核心上下文编译器 —— 历史压缩、工具裁剪、记忆、VFS 卸载、多 provider 适配 |
| [`@context-chef/ai-sdk-middleware`](./packages/ai-sdk-middleware) | [Vercel AI SDK](https://sdk.vercel.ai) 中间件 —— 即插即用的上下文工程，零代码改动 |
| [`@context-chef/tanstack-ai`](./packages/tanstack-ai) | [TanStack AI](https://tanstack.com/ai) 中间件 —— 通过 `ChatMiddleware` 提供压缩、截断和动态状态 |

### 零配置接入 AI SDK

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

完整文档见 [`@context-chef/ai-sdk-middleware` README](./packages/ai-sdk-middleware/README.md)。

### TanStack AI 中间件

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

完整文档见 [`@context-chef/tanstack-ai` README](./packages/tanstack-ai/README.md)。

### 用 `@context-chef/core` 获得完全控制

需要直接控制编译管道 —— 动态状态注入、工具 namespace、记忆、快照/恢复 —— 请直接使用核心库：

## 博客系列

1. [为什么要"编译上下文"](https://myprototypewhat.cn/context-chef-1-why-compile-context)
2. [Janitor——把触发逻辑和压缩策略彻底分离](https://myprototypewhat.cn/context-chef-2-janitor)
3. [Pruner——把工具注册和路由彻底分开](https://myprototypewhat.cn/context-chef-3-pruner)
4. [Offloader/VFS——不破坏信息，只搬移信息](https://myprototypewhat.cn/context-chef-4-offloader-vfs)
5. [Core Memory——读取零成本，写入结构化](https://myprototypewhat.cn/context-chef-5-core-memory)
6. [Snapshot & Restore——捕获决定下次编译的一切](https://myprototypewhat.cn/context-chef-6-snapshot)
7. [Provider 适配层——让差异止于编译层](https://myprototypewhat.cn/context-chef-7-adapters)
8. [编译管道里的五个扩展点](https://myprototypewhat.cn/context-chef-8-hooks)

## Features

- **对话太长？** — 自动压缩历史消息，保留近期记忆，老对话交给小模型摘要
- **压缩把约束弄丢了？** — 约束固定（v4）：`pinned: true` 的消息原文穿过压缩，且永不被 `compact()` 清除
- **摘要丢了你想找回的细节？** — 可逆的归档 + 召回（v4）：压缩前的完整片段会被存储并在摘要中以 URI 引用；`recall_context` 工具可按需还原
- **Provider 帮你做压缩？** — 服务端上下文管理（v4）：`contextManagement: { strategy: 'server' }` 把 LLM 压缩交给 Anthropic 服务端 compaction，裁剪/skills/记忆/VFS 仍留在客户端
- **压缩延迟拖慢主链路？** — 后台压缩（v4）：摘要在轮次之外运行，仅在仍然有效时换入；anchored 模式把被驱逐的片段增量合并进一份持久摘要文档
- **消息存储归你管？** — 持久化压缩：`planCompaction` / `compactHistory`（以及 AI SDK 和 TanStack 移植版）把你的存储压缩一次并持久化结果，而不是每次调用都在途重复压缩
- **工具太多？** — 按任务动态裁剪工具列表，或用双层架构（稳定分组 + 按需加载）彻底消除工具幻觉
- **运行时禁用工具？** — Pruner blocklist + `checkToolCall` dispatch 闸门，覆盖权限、环境、限流、沙箱等场景；默认 KV-cache 友好
- **按阶段切人格？** — `Skill` 原语打包指令 + 工具注解，支持从 `SKILL.md` 文件加载（与 Claude Code / Mastra / OpenCode 同格式）
- **换模型要重写？** — 同一套 prompt 编译到 OpenAI / Anthropic / Gemini，prefill、cache、tool call 格式自动适配
- **长程任务跑偏？** — Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点
- **输出格式跑偏？** — Guardrail：`withGuardrails` 强制 XML 输出契约并设置 assistant prefill，在不支持原生 prefill 的 provider 上自动降级
- **终端输出太大？** — 自动截断并卸载到 VFS，保留错误行 + `context://` URI 指针供按需取回
- **跨会话记不住？** — Memory 让模型通过 tool call 主动持久化关键信息（项目规范、用户偏好），下次会话自动注入
- **想回滚怎么办？** — Snapshot & Restore 一键捕获和回滚全部上下文状态，支持分支探索
- **需要外部上下文？** — `onBeforeCompile` 钩子让你在编译前注入 RAG 检索结果、AST 片段或 MCP 查询
- **需要可观测性？** — 统一事件系统（`chef.on('compress', ...)`）一个入口订阅所有内部模块的日志、指标和调试信息

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

---

## API 参考

> **4.0 移除项** —— 每一项都有直接替代：`TokenUtils` → `estimate` / `estimateObject`，`XmlGenerator` → `objectToXml`，`AdapterFactory` → `getAdapter` / `adapterRegistry`，`JanitorConfig.onBudgetExceeded` → `onBeforeCompress`。完整迁移指南见 [MIGRATION-4.md](./MIGRATION-4.md)。

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

### 上下文构建

#### `chef.setSystemPrompt(messages): this`

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

#### `chef.setHistory(messages): this`

设置对话历史。Janitor 在 `compile()` 时自动压缩。

#### `chef.setDynamicState(schema, data, options?): this`

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

#### `chef.withGuardrails(options): this`

应用输出格式护栏和可选的 prefill。

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
});
```

**v4 语义。** options 现在会被*存储*并在 `compile()` 时应用，因此与 `setDynamicState` 的调用顺序不再重要（4.0 之前，在 `withGuardrails` 之后调用 `setDynamicState` 会静默丢弃护栏）。每次调用会**替换**上一次的 options（不累积）；`withGuardrails(null)` 清除。存储的 options 会随 `ChefSnapshot` 持久化（`guardrailOptions`），护栏消息作为独立消息落在三明治最末端 —— 离生成最近，不再合并进动态状态消息。

#### `chef.compile(options?): Promise<TargetPayload>`

将所有内容编译为 provider 就绪的 payload。触发 Janitor 压缩。注册的工具自动包含。

```typescript
const payload = await chef.compile({ target: "openai" }); // OpenAIPayload
const payload = await chef.compile({ target: "anthropic" }); // AnthropicPayload
const payload = await chef.compile({ target: "gemini" }); // GeminiPayload
```

---

### 历史压缩 (Janitor)

Janitor 提供两种压缩路径，根据你的场景选择：

#### 路径 1：Tokenizer（精确控制）

传入自定义的 token 计算函数，Janitor 会精确计算每条消息的 token 数。保留 `contextWindow × preserveRatio` 范围内的近期消息，其余进行压缩。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8, // keep 80% of contextWindow for recent messages (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages — the exact slice of history the summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

#### 路径 2：reportTokenUsage（简单，无需 tokenizer）

大多数 LLM API 的响应中已经包含 token 用量。直接传入该值，当超过 `contextWindow` 时，Janitor 压缩除最后 N 条消息外的所有内容。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    preserveRecentMessages: 1,       // keep last 1 message on compression (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

> **注意：** 如果没有提供 `compressionModel`，旧消息将被直接丢弃而不生成摘要。如果同时没有 `tokenizer` 和 `compressionModel`，构造时会打印控制台警告。

#### `JanitorConfig`

| 选项                            | 类型                                        | 默认值 | 说明                                                                     |
| ------------------------------- | ------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `contextWindow`                 | `number`                                    | _必填_ | 模型的上下文窗口大小（token 数）。用量超过 `contextWindow × triggerRatio` 时触发压缩。 |
| `triggerRatio`                  | `number`                                    | `0.7`  | 触发压缩的 `contextWindow` 占比（"腐烂前"提前压缩）。设为 `1` 可恢复 4.0 之前打满窗口才触发的行为。 |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —      | 启用 tokenizer 路径，精确计算每条消息的 token 数。                       |
| `preserveRatio`                 | `number`                                    | `0.8`  | [Tokenizer 路径] 有效预算（`contextWindow × triggerRatio`）中保留给近期消息的比例。 |
| `preserveRecentMessages`        | `number`                                    | `1`    | [reportTokenUsage 路径] 压缩时保留的近期轮次数量。                       |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`| 当 `tokenizer` 与 `reportTokenUsage` 同时存在时，决定触发判断使用哪个 token 来源。无 `tokenizer` 时取值范围收窄为 `'max' \| 'feedFirst'`，TypeScript 在编译期拒绝 `'tokenizerFirst'`。完整说明见 [core 包 README](./packages/core)。 |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —      | 异步钩子，调用低成本 LLM 对旧消息进行摘要。                              |
| `customCompressionInstructions` | `string`                                    | —      | 追加到默认压缩 prompt 的额外聚焦指令（追加模式，不替换）。               |
| `compressionGuidelines`         | `string[]`                                  | —      | 注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。 |
| `toolResultStubThreshold`       | `number`                                    | —      | 摘要前把长于该字符数的 tool result 内容替换为一行元数据 stub（节省摘要模型 token）。 |
| `minShrinkRatio`                | `number`                                    | `0.5`  | 质量闸门：摘要必须让被压缩片段至少缩小该比例（仅对 ≥ 2000 字符的片段生效）；否则本次压缩失败，历史保持不变。`0` 关闭。 |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | 摘要后闸门。返回 `false`（或抛出）即拒绝该摘要 —— 历史不变，熔断计数 +1。 |
| `archive`                       | `CompressionArchiveConfig \| 'vfs'`         | —      | 可逆压缩：存储压缩前的完整片段，并在摘要中引用其 URI。见[压缩管道 v2](#压缩管道-v2v4)。 |
| `compressionMode`               | `'rewrite' \| 'incremental-anchored'`       | `'rewrite'`| anchored 模式维护一份持久的 anchor 文档，每次压缩只把新驱逐的片段合并进去。 |
| `compressionScheduling`         | `'blocking' \| 'background'`                | `'blocking'` | background 模式把摘要放到轮次之外运行；超预算的 compile 先原样返回历史，结果在仍然有效时再换入。 |
| `onCompress`                    | `(summary, count, details) => void`         | —      | 压缩完成后触发，传入摘要消息和被截断的消息数量。`details.compressedMessages` 是被摘要替换的那段消息切片。 |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —      | LLM 压缩前触发。返回修改后的历史来干预，或返回 null 让默认压缩继续执行。 |
| `logger`                        | `ChefLogger`                                | —      | 降级警告的日志接收器（存储/压缩），默认使用 `console`。 |

**压缩输出契约。** Janitor 默认 prompt 要求压缩模型输出两阶段响应：先在 `<analysis>` 里写草稿推理（会被剥除），再输出结构化的 `<summary>` 块，包含 5 个领域无关的章节（Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve）。原始输出在注入前会经过 `Prompts.formatCompactSummary` 清洗。完整契约与 `customCompressionInstructions` 用法见 [core 包 README](./packages/core)。

**失败语义（4.0 起变更）。** 压缩模型失败 —— 抛出异常、摘要未通过 `minShrinkRatio`、或被 `validateCompression` 拒绝 —— 会让历史**保持不变**（4.0 之前会截断历史并留下占位符），并使熔断计数 +1。如果连续 3 次 `compress()` 失败，`compress()` 将变为 no-op，直到下一次成功压缩或显式调用 `janitor.reset()` / `chef.clearHistory()`。失败计数由 `chef.snapshot()` / `chef.restore()` 保存。

**独立摘要。** `summarizeHistory(messages, compress, opts?): Promise<string>` 是该路径背后与 provider 无关的原语 —— 可直接调用它压缩你自己存储中的一段切片。空切片返回 `''`；无状态，且 `compress` 抛出时**直接抛出**；`compress` 回调**必须扁平化** `tool` 角色。可选项包括 `customCompressionInstructions`、`toolResultStubThreshold`、`compressionGuidelines` 和 `baseInstruction`。完整契约见 [core 包 README](./packages/core)，更高层的辅助函数见下文[持久化压缩](#持久化压缩)。

#### 压缩管道 v2（v4）

v4 围绕一条规则重建了压缩路径：坏摘要永远不能替换好历史。

- **腐烂前触发 —— `triggerRatio`（默认 `0.7`）**：压缩在 `contextWindow × 0.7` 处触发，而不是等到硬上限 —— 模型质量早在窗口占满之前就开始退化。`preserveRatio` 作用于这个有效预算。`triggerRatio: 1` 恢复 4.0 之前的行为。
- **约束固定 —— `pinned: true`**：固定的消息原文穿过 `compress()`（按序重新插入到摘要之后），且永不被 `compact()` 清除。固定原子轮次中的任一消息即可保护整个轮次。用于策略与约束文本 —— 压缩丢掉策略文本会把违规率从 0% 拉到 30% 以上（arXiv:2606.22528）。
- **缩减闸门 —— `minShrinkRatio`（默认 `0.5`）**：摘要若未能让被压缩片段缩小 ≥ 50%（按字符长度；仅对 ≥ 2000 字符的片段生效）即视为压缩失败 —— 历史不变，熔断计数 +1。防止压缩死循环。`0` 关闭。
- **`validateCompression`**：摘要后闸门 `(summary, { compressed, kept }) => boolean | Promise<boolean>` —— 返回 `false` 或抛出即拒绝该结果（历史不变，熔断计数 +1）。
- **可逆归档 —— `archive`**：被压缩片段经 `store(serialized, { messageCount }) => uri` 序列化存储，摘要中引用该 URI，因此精确细节始终可取回，而不是靠重要性打分去猜（arXiv:2607.25066、arXiv:2607.08032）。`archive: 'vfs'` 存进 chef 的 VFS。尽力而为：存储失败只记一条警告并跳过引用。
- **`compressionGuidelines`**：注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。
- **增量 anchored 模式 —— `compressionMode: 'incremental-anchored'`**：维护一份持久的 anchor 文档；每次压缩只把新驱逐的片段合并进去，而不是重写整份摘要（Factory.ai 模式）。通过 `janitor.getAnchorDoc()` 读取；它是 `JanitorSnapshot` 的一部分，`reset()` 会清除。
- **后台调度 —— `compressionScheduling: 'background'`**：第一次超预算的 `compile()` 原样返回历史并在后台启动摘要；之后的 `compress()` 仅在被摘要的片段仍是当前历史的前缀时才换入结果（过期结果被丢弃；`onCompress` 在换入时触发）。把压缩延迟移出主链路（arXiv:2605.08580）。后台状态不进快照。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200_000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    triggerRatio: 0.7,       // default — compress "pre-rot"
    minShrinkRatio: 0.5,     // default — reject summaries that barely shrink
    archive: "vfs",          // reversible: full span stored, summary cites a context:// URI
    compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  },
});

// Pin constraint text — survives compress() verbatim, never cleared by compact()
history.push({
  role: "user",
  content: "NEVER touch prod. Deploy only from CI.",
  pinned: true,
});
```

**召回工具配方。** 启用 `archive`（或 VFS 卸载）后，注册内置的 `recall_context` 工具，让模型按需取回归档内容：

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({
    role: "tool",
    tool_call_id: call.id,
    content: content ?? "[not found]",
  });
}
```

#### 持久化压缩

在途压缩（上文）重写每次外发的 payload，但不会碰你的消息存储 —— 对一段持续超预算的对话，摘要在每次调用时都要重新计算。当消息存储归你管时，把它压缩一次并持久化结果。三个 helper 都在原子轮次边界处切分（assistant 消息和它的 tool result 永不分离），摘要旧切片，返回 `[...system, <summary>, ...recent turns]`；no-op 时原样返回输入引用，因此可用 `result === input` 跳过持久化。

Core —— 与 provider 无关，作用于 IR `Message[]`：

```typescript
import { compactHistory, planCompaction } from "@context-chef/core";

// myCompressFn must role-flatten tool messages (same contract as summarizeHistory)
history = await compactHistory(history, myCompressFn, { keepRecentTurns: 4 });
// planCompaction(history, { keepRecentTurns }) is the synchronous split behind it
```

Vercel AI SDK —— `ModelMessage` 层，已为你接好角色扁平化：

```typescript
import { compactModelMessages } from "@context-chef/ai-sdk-middleware";

messages = await compactModelMessages(messages, openai("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

TanStack AI —— 接受任意 TanStack text adapter：

```typescript
import { compactTanStackMessages } from "@context-chef/tanstack-ai";

messages = await compactTanStackMessages(messages, openaiText("gpt-4o-mini"), {
  keepRecentTurns: 4,
});
```

`keepRecentTurns: 0` 即完整的 Claude Code 式压缩 —— 整个对话坍缩为 `[...system, <summary>]`。不要在同一段对话上同时使用持久化压缩和在途压缩（双重压缩）。完整契约见 [core](./packages/core)、[ai-sdk-middleware](./packages/ai-sdk-middleware) 和 [tanstack-ai](./packages/tanstack-ai) 的 README。

#### `chef.reportTokenUsage(tokenCount): this`

传入 API 返回的 token 用量。下次 `compile()` 时，如果该值超过 `contextWindow`，则触发压缩。在 tokenizer 路径中，默认取本地计算值和传入值中的较大值；可通过 `usagePreference` 切换为 `'feedFirst'`（信任 API 真值）或 `'tokenizerFirst'`（完全忽略传入值）。

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

#### `onBeforeCompress` 钩子

当 token 预算超标时，在 LLM 压缩**之前**触发。返回修改后的 `Message[]` 替换历史，或返回 `null` 让默认压缩继续执行。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBeforeCompress: (history, { currentTokens, limit }) => {
      // Example: offload large tool results to VFS before compression
      return history.map((msg) =>
        msg.role === "tool" && msg.content.length > 5000
          ? { ...msg, content: pointer.offload(msg.content).content }
          : msg,
      );
    },
  },
});
```

#### 机械压缩（`compact`）

零 LLM 成本的内容清理。在 agent 循环中主动调用以保持上下文精简。

```typescript
// Clear all tool results and thinking blocks
history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

// Keep the 5 most recent tool results, clear the rest (min: 1)
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// Combine: clear old tool results + all thinking
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }, 'thinking'],
});

// v4: strip <think>...</think> tags from assistant text (open-weight reasoning models)
history = janitor.compact(history, { clear: ['reasoning-tags'] });

// v4: per-tool granularity — clear only these tools, never those
history = janitor.compact(history, {
  clear: [{
    target: 'tool-result',
    keepRecent: 5,          // counts within the clearable set
    toolFilter: ['run_bash'],   // only clear these tools
    exemptTools: ['read_file'], // never clear these (wins over toolFilter)
  }],
});
```

固定消息（`pinned: true`）永不被 `compact()` 清除，Gemini thought signature 对 `compact(['thinking'])` 免疫。

#### `ensureValidHistory(history)`

独立工具函数，修复消息历史以满足 LLM API 约束（删除孤儿 tool result、为缺失的 tool result 注入占位、确保第一条非 system 消息是 user）。适用于从数据库加载历史或手动修改后的场景。

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

> **边界契约**：所有 input adapter（`fromOpenAI` / `fromAnthropic` / `fromGemini`，以及 middleware 内部的 `fromAISDK` / `fromTanStackAI`）都会在出口自动跑一次 `ensureValidHistory` —— 它们是外部 SDK 格式与 ContextChef IR 之间的系统边界。`chef.setHistory(IR)` **不**做 sanitize：IR 是内部协议，直接构造或 mutate 出来的 history 视为已满足契约。如果不确定，显式用 `ensureValidHistory(...)` 包一下。

#### `chef.clearHistory(): this`

切换话题或完成子任务时显式清空历史并重置 Janitor 状态。

---

### 服务端上下文管理（v4）

Provider 现在可以在服务端执行 compaction（Anthropic `compact_20260112`、OpenAI `/responses/compact`）—— 少一次模型调用，还有精确的 token 计数。`ChefConfig.contextManagement` 让你把 LLM 压缩交给 provider；服务端不做的一切仍留在客户端：工具裁剪、skills、记忆、VFS 卸载、动态状态。

```typescript
const chef = new ContextChef({
  contextManagement: { strategy: "server" }, // 'client' (default) keeps Janitor LLM compression
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `server` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

- `strategy: 'server'` 完全跳过客户端的 LLM 压缩。如果同时配置了 `compressionModel`，构造时会发出警告 —— 二选一。
- `server` 是按 provider 形状原样透传的 edits 配置，例如 `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` 或 `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`。`payload.betas` 自动推导：compaction 类 edit 对应 `'compact-2026-01-12'`，clear-tool-uses / clear-thinking 类 edit 对应 `'context-management-2025-06-27'`。
- **compaction 块往返**：`fromAnthropic` 把 API 的 `{ type: 'compaction', content }` 块映射为标记 `pinned: true` 的透传消息，Anthropic adapter 在下次编译时把该块原文重新放在最前面 —— 服务端产出的摘要原样穿过客户端管道。

这是混合定位，不是二选一：LLM 压缩可以交给 provider，同时 ContextChef 继续做服务端不做的部分 —— 裁剪、skills、记忆、VFS 和动态状态。AI SDK 用户有配套防护：middleware 检测到某次调用带 `providerOptions.anthropic.contextManagement` 时，会为该次调用跳过自己的压缩（见 [ai-sdk-middleware README](./packages/ai-sdk-middleware/README.md#anthropic-server-side-context-management)）。

---

### 大文本卸载 (Offloader / VFS)

```typescript
// Offload if content exceeds threshold; preserves last 2000 chars by default
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: original content if small, or truncated with context://vfs/ URI

// Preserve head (first 500 chars) + tail (last 1000 chars), snapped to line boundaries
const safeOutput = chef.offload(content, { headChars: 500, tailChars: 1000 });

// No preview content — just truncation notice + URI
const safeDoc = chef.offload(largeFileContent, { headChars: 0, tailChars: 0 });

// Override threshold per call
const safeOutput2 = chef.offload(content, { threshold: 2000, tailChars: 500 });
```

注册一个工具让 LLM 按需读取完整内容：

```typescript
// In your tool handler:
import { Offloader } from "@context-chef/core";
const offloader = new Offloader({ storageDir: ".context_vfs" });
const fullContent = offloader.resolve(uri);
```

#### 清理与生命周期

`.context_vfs/` 不会自动收敛 —— 你需要自己配置上限并触发清理，从不自动执行。

```typescript
const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    maxAge: 24 * 60 * 60 * 1000, // ms since createdAt
    maxFiles: 200,                // LRU evict by accessedAt
    maxBytes: 50 * 1024 * 1024,   // true UTF-8 size (Buffer.byteLength)
    onVFSEvicted: (entry, reason) => {
      // 'maxAge' | 'maxFiles' | 'maxBytes' — errors logged and swallowed
      logger.debug("evicted", entry.uri, reason);
    },
  },
});

// Manual sweep — call from your agent loop, on session end, or wire to compile:done.
const result = await chef.getOffloader().cleanupAsync();
// { evicted, evictedBytes, evictedByAge, evictedByCount, evictedByBytes, failed }

// Override caps for one call (Infinity disables a single cap).
await chef.getOffloader().cleanupAsync({ maxFiles: 0 }); // evict all over-age + all
```

进程重启后，`reconcile()` 会扫描 adapter，把内存索引外的孤儿文件接管回来，让后续 `cleanup()` 可以看到它们：

```typescript
const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
// createdAt parsed from legacy vfs_<ts>_<hash>.txt names; content-addressed names date from adoption. bytes measured if requested.
```

清理是**机制而非策略** —— `compile()` 不会自动触发它。如果你想按轮强制执行，绑到 `compile:done` 事件钩子；否则在 agent loop 或会话结束时主动调用。自定义的 `VFSStorageAdapter` 必须实现可选的 `list()` / `delete()` 才能开启清理；任一缺失时 `cleanup()` 会抛 `VFSCleanupNotSupportedError`（内置 `FileSystemAdapter` 两者都已实现）。

> **生产实践** —— 见 [`docs/vfs-lifecycle-recipes.zh-CN.md`](./docs/vfs-lifecycle-recipes.zh-CN.md) 获取可运行的 recipe：长跑 server 定时清理、Serverless 冷启动 `reconcile()`、AI SDK middleware 接法、自定义 storage adapter（Redis 示例）、驱逐策略选择。

---

### 工具管理 (Pruner)

#### 扁平模式

```typescript
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "run_bash", description: "Run a command", tags: ["shell"] },
  {
    name: "get_time",
    description: "Get timestamp" /* no tags = always kept */,
  },
]);

const { tools, removed } = chef.getPruner().pruneByTask("Read the auth.ts file");
// tools: [read_file, get_time]
```

也支持 `allowOnly(names)` 和 `pruneByTaskAndAllowlist(task, names)`。

#### 运行时 Blocklist（权限闸门）

在 dispatch 时拦下指定工具，**不破坏 KV cache**。适合权限控制、环境隔离、沙箱、限流、feature flag。编译出的 `tools` 数组保持不变，强制由 agent loop 里的 `checkToolCall` 完成。

```typescript
// Set policy (rare event — startup, on user role change, prod env, etc.)
chef.getPruner().setBlockedTools(["delete_file", "tail_logs"]);

// In your agent loop, gate every tool call before dispatch:
for (const call of response.tool_calls) {
  const check = chef.checkToolCall({ name: call.function.name });
  if (!check.allowed) {
    history.push({
      role: "tool",
      tool_call_id: call.id,
      content: check.reason, // e.g. 'Tool "delete_file" is currently blocked.'
    });
    continue;
  }
  await executeTool(call);
}
```

`checkToolCall` 返回 discriminated union (`ToolCallCheckResult`)，TypeScript 保证 `reason` 当且仅当被拒绝时存在。Blocklist 变化不破 KV cache —— LLM 仍看到全部工具，闸门只在 dispatch 端生效。

#### Namespace + Lazy Loading（双层架构）

**Layer 1 — Namespace**：核心工具分组为稳定的工具定义。工具列表在多轮对话中永不变化。

**Layer 2 — Lazy Loading**：长尾工具注册为轻量 XML 目录。LLM 通过 `load_toolkit` 按需加载完整 schema。

```typescript
// Layer 1: Stable namespace tools
chef.registerNamespaces([
  {
    name: "file_ops",
    description: "File system operations",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { path: { type: "string" } },
      },
      {
        name: "write_file",
        description: "Write to a file",
        parameters: { path: { type: "string" }, content: { type: "string" } },
      },
    ],
  },
  {
    name: "terminal",
    description: "Shell command execution",
    tools: [
      {
        name: "run_bash",
        description: "Execute a command",
        parameters: { command: { type: "string" } },
      },
    ],
  },
]);

// Layer 2: On-demand toolkits
chef.registerToolkits([
  {
    name: "Weather",
    description: "Weather forecast APIs",
    tools: [
      /* ... */
    ],
  },
  {
    name: "Database",
    description: "SQL query and schema inspection",
    tools: [
      /* ... */
    ],
  },
]);

// Compile — tools: [file_ops, terminal, load_toolkit] (always stable)
const { tools, directoryXml } = chef.getPruner().compile();
// directoryXml: inject into system prompt so LLM knows available toolkits
```

**Agent Loop 集成：**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.getPruner().isNamespaceCall(toolCall)) {
    // Route namespace call to real tool
    const { toolName, args } = chef.getPruner().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.getPruner().isToolkitLoader(toolCall)) {
    // LLM requested a toolkit — expand and re-call
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.getPruner().extractToolkit(parsed.toolkit_name);
    // Merge newTools into the next LLM request
  }
}
```

> **一层就够了。** namespace → tools 的两层深度是工具选择上经验最优的层级 —— 更深的嵌套会损害准确率，却省不下多少上下文（arXiv:2607.17598）。不要在 namespace 里再嵌套 namespace。

#### 延迟工具加载 —— `deferLoading`（v4）

在 `ToolDefinition` 上设置 `deferLoading: true`，即可将其标注给 Anthropic 服务端的 Tool Search：该标志在 Anthropic target 上原样透传到 `payload.tools`，让 API 按需展示工具的完整 schema，而不是预先全部加载。它只是注解 —— 其他 target 会忽略它。

---

### Memory

跨会话持久化的键值记忆。记忆通过 tool call（`create_memory` / `modify_memory`）修改，`compile()` 时自动注入到 payload 中。

```typescript
import { InMemoryStore, VFSMemoryStore } from "@context-chef/core";

const chef = new ContextChef({
  memory: {
    store: new InMemoryStore(), // ephemeral (testing)
    // store: new VFSMemoryStore(dir),   // persistent (production)
  },
});

// In your agent loop, intercept memory tool calls:
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") {
      await chef.getMemory().updateMemory(key, value, description);
    } else {
      await chef.getMemory().deleteMemory(key);
    }
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");

// On compile():
// - Memory tools (create_memory, modify_memory) are auto-injected into payload.tools
// - Existing memories are injected as <memory> XML between systemPrompt and history
```

#### Memory 位置 —— `memoryPlacement`

控制易变的 `<memory>` 数据块在编译产物中的落点。默认 `'after_system'`（向后兼容）。如果你在用 **Anthropic prompt caching** 且 cache breakpoint 打在 history 上，切换到 `'before_history_tail'`，这样 memory 变化就不会击穿 history 的缓存了。

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(dir),
    memoryPlacement: 'before_history_tail',
  },
});
```

| Placement | 三明治顶部 | 最后一条 user 消息 | 适用场景 |
|---|---|---|---|
| `'after_system'`（默认） | INSTRUCTION + `<memory>` 数据合并成一条 `role: 'system'` | 不动 | 简单 agent；不依赖 system 参数之后的 cache breakpoint |
| `'before_history_tail'` | 仅 INSTRUCTION（稳定，可缓存） | 在原 user 内容后追加 `<memory>` 数据块 | 你希望 history（或更靠前的 `system`）上的 cache breakpoint 在每轮 memory 变化时都能命中 |

这个拆分把稳定的使用说明留在三明治顶部享受缓存，把易变的数据块送到对话末尾。Anthropic / Gemini adapter 会把所有 `role: 'system'` 提取到 top-level `system` 参数 —— 选 `'before_history_tail'` 后，数据块改留在 `messages` 里，任何打在消息流更早位置的 cache breakpoint 都不再把变化的 memory 文本算进 hash。

如果动态状态也注入到末尾（`dynamicStatePlacement: 'last_user'`），最后一条 user 消息内部顺序是：原内容 → `<memory>` → `<dynamic_state>` → `<implicit_context>` → 锚定句。如果动态状态走独立 system message（`dynamicStatePlacement: 'system'`），memory 仍然注入到 user 末尾，但不会带锚定句。

---

### Skill（行为打包）

`Skill` 是一份可移植的 `(name + description + instructions + ...)` 打包，用来在某个阶段或领域里给 agent "切人格"。激活后，instructions 作为单独的 system message 注入到你的 system prompt 和 memory 块之间——你不需要手动改 prompt。Skill 可以是内联 JS 对象，也可以从 `SKILL.md` 加载（与 Claude Code / Mastra / OpenCode 同 frontmatter 格式）。

```typescript
import { ContextChef, type Skill } from "@context-chef/core";

const planning: Skill = {
  name: "planning",
  description: "Plan changes before editing",
  whenToUse: "When the task is non-trivial and requires multiple steps",
  instructions: "Read code, list affected files, write plan to scratchpad.",
  allowedTools: ["read_file", "grep"], // annotation only — chef does NOT enforce
};

const chef = new ContextChef();
chef.registerSkills([planning]);
chef.activateSkill("planning");
// activateSkill also accepts a Skill object directly, or null to deactivate.

const { messages, meta } = await chef.compile({ target: "openai" });
// messages = [...systemPrompt, { role: 'system', content: planning.instructions }, ...rest]
// meta.activeSkillName === 'planning'
```

#### 从 `SKILL.md` 加载

```typescript
import {
  loadSkill,
  loadSkillsDir,
  loadSkillsDirs,
  renderSkill,
  formatSkillListing,
} from "@context-chef/core";

// Load a single skill file
const skill = await loadSkill("./skills/db-debug/SKILL.md");

// Or scan a directory: each subdir/SKILL.md becomes a Skill (tolerant — bad files surface in `errors`)
const { skills, errors } = await loadSkillsDir("./skills");
chef.registerSkills(skills);

// Or merge several sources at once (e.g. builtin + user + project) — later dirs
// win on name collisions, dirs are realpath-deduped, and an optional `namespace`
// callback can prefix names per source:
const merged = await loadSkillsDirs([builtinDir, userDir, projectDir], {
  precedence: "last-wins",
});

// Render a system-prompt-friendly listing (useful for LLM-driven `load_skill` tool)
const listing = formatSkillListing(skills, { format: "plain" });
```

`SKILL.md` 解析是容忍的：块标量（`>` 折叠 / `|` 字面）、`- item` 列表、kebab key（`allowed-tools`、`when-to-use`）都能加载；chef 不认识的 key 原样保留在 `skill.metadata` 上交给 host 读取——chef 从不解释，仅作注解（与 `allowedTools` 一致）。已知字段若写成畸形嵌套结构会直接抛错，而不是静默失效（打错的 `allowed-tools` 会暴露，而非悄悄关掉限制）。

listing 通常作为 `load_skill` tool 的 description，让 LLM 自己挑 skill：

```typescript
const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill to specialize for the current task. Available:\n" + listing,
  parameters: {
    skill_name: {
      type: "string",
      enum: chef.getRegisteredSkills().map((s) => s.name),
    },
  },
};

// In your dispatch loop:
if (call.name === "load_skill") {
  chef.activateSkill(call.args.skill_name);
  /* push tool result, continue loop */
}
```

#### 渲染参数（`renderSkill`）

`renderSkill` 把 skill instructions 里的 `$ARGUMENTS` / `$0..$N` / `$name` / `${VAR}` 占位符替换掉，返回一个新的 `Skill`（纯函数，无 I/O）。渲染后的 skill 怎么投递由你决定：上面的 system 槽（常驻"模式"），或 host 追加成消息以同时渐进式挂载多个 skill。

```typescript
const triage = await loadSkill("./skills/triage/SKILL.md");

// Fill $ARGUMENTS / $0.. / ${SKILL_DIR} before activating:
chef.activateSkill(renderSkill(triage, { args: "p0 incidents" }));
```

引用文件（`@./schema.json` 等）chef **不会**内联——传 `renderSkill(skill, { includeBaseDir: true })`，让你的 agent 用自己的文件工具按需读取。

设计动机（Skill ⊥ Pruner 解耦、SKILL.md frontmatter 格式、mode 接线配方、LLM 自主加载 skill、reference 文件）见 [`SKILL_SPEC.md`](./SKILL_SPEC.md)。参数渲染、多源加载、两种交付模型见 [`docs/skill-interop-design.md`](./docs/skill-interop-design.md) 和使用配方 [`docs/skill-recipes.md`](./docs/skill-recipes.md)。

---

### Snapshot & Restore

捕获和回滚全部上下文状态，用于分支探索或错误恢复。

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

---

### 生命周期事件

统一的事件系统，一个入口观测所有内部模块。通过 `chef.on()` 订阅，`chef.off()` 取消订阅。

```typescript
// Log when history gets compressed
chef.on('compress', ({ summary, truncatedCount }) => {
  console.log(`Compressed ${truncatedCount} messages`);
});

// Track compile metrics
chef.on('compile:done', ({ payload }) => {
  metrics.track('compile', { messageCount: payload.messages.length });
});

// Monitor memory changes
chef.on('memory:changed', ({ type, key, value }) => {
  console.log(`Memory ${type}: ${key}`);
});
```

#### 可用事件

| 事件 | Payload | 说明 |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | `compile()` 开始时触发 |
| `compile:done` | `{ payload }` | `compile()` 生成最终 payload 后触发 |
| `compress:start` | `{ historyLength, currentTokens, limit }` | 预算超标 —— 压缩即将运行时触发（摘要之前） |
| `compress:end` | `{ compressed }` | 压缩阶段结束。`compressed: false` = 预算未超或结果被拒绝 |
| `compress` | `{ summary, truncatedCount, details }` | Janitor 压缩历史后触发 |
| `offload:created` | `{ uri }` | 内容被卸载到 VFS（经 `chef.offload` / `offloadAsync` 或压缩归档） |
| `pruner:tool-blocked` | `{ name }` | `checkToolCall()` 依据 Pruner blocklist 拒绝了一次工具调用 |
| `memory:changed` | `{ type, key, value, oldValue }` | 任何记忆变更（set、delete、expire）后触发 |
| `memory:expired` | `MemoryEntry` | `compile()` 期间记忆条目过期时触发 |

事件是**纯观察型**的，不影响控制流。拦截型钩子（`onBeforeCompress`、`onMemoryUpdate`、`onBeforeCompile`、`transformContext`）仍然通过 config 回调配置。

**Handler 错误隔离（v4）。** 某个事件 handler 抛出或 reject 时只会被记录，其余 handler 照常执行 —— 4.0 之前，一个抛出的 handler 会让整个 `compile()` 失败。

事件与现有 config 回调共存：如果在 `JanitorConfig` 中配置了 `onCompress`，它会先触发，然后再 emit `compress` 事件。

#### 取消 —— `compile({ signal })`

向 `compile()` 传入 `AbortSignal`，可取消进行中的 compile，并把 signal 透传给该次调用期间所有触发的事件 handler。

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // hard 5s budget

chef.on('compile:done', async ({ payload }, signal) => {
  // signal === controller.signal — forward it to slow async work
  await db.write(payload, { signal });
  await metrics.report(payload, { signal });
});

try {
  await chef.compile({ target: 'openai', signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    // compile was cancelled mid-flight (Janitor / onBeforeCompile / transformContext boundary)
  }
  throw err;
}
```

两个作用：

1. **透传给 handler** —— `chef.on(event, (payload, signal?) => ...)` 第二个参数即 signal。handler 可把它转给 `fetch`、DB 客户端或任何支持协作取消的 API。
2. **compile() 阶段边界检查** —— Janitor 压缩后、`onBeforeCompile` 后、`transformContext` 后均会检查；命中即通过 `signal.throwIfAborted()` 抛出。

`compile:start` 在第一次 abort 检查之前触发，所以观察者可能收到一个最终抛 AbortError 而没有 `compile:done` 的 compile 调用。从 `memory().set()` / `delete()` 这类**外部**调用触发的 memory 事件，signal 为 `undefined`。

#### 并发模型

**推荐模式：每个并发调用方一个 `ContextChef` 实例。** chef 在 `await` 点之间持有可变状态（in-flight signal、memory 轮次、active skill、history 引用），每请求独立实例化即可让每次调用拥有自己的状态——没有共享可变状态就没有 race。

```typescript
// Express / Fastify / Hono — one chef per request
app.post('/agent', async (req, res) => {
  const chef = new ContextChef({ memory: { store: sharedMemoryStore } });
  chef.setHistory(req.body.history);
  const payload = await chef.compile({ target: 'openai' });
  res.json(payload);
});
```

如果 memory 需要跨请求共享，把 store 单独提取（`VFSMemoryStore` 或你自己包的 Redis-backed store）传给每请求的 chef —— store 层并发由 store 自己负责，不是 chef 的事。

**同一个 chef 实例上并发 `compile()` 是单线程语义。** 同实例两次 compile 会互相覆盖 `_currentSignal`、双进 memory 轮次、交错读取 skill/history。请按实例串行（`await chef.compile()` 链式），或用上面的 per-request 模式。Snapshot+serialize 防御性方案在 roadmap 里（TODO T2.4.1，低优先级），但 canonical 用法不需要它。

---

### `onBeforeCompile` 钩子

在编译前注入外部上下文（RAG、AST 片段、MCP 查询），无需修改消息数组。

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.dynamicStateXml);
    return snippets.map((s) => s.content).join("\n");
    // Injected as <implicit_context>...</implicit_context> alongside dynamic state
    // Return null to skip injection
  },
});
```

---

### Input Adapters（Provider → IR）

将 OpenAI / Anthropic / Gemini 原生消息转换为 ContextChef IR，自动分离 system 和 history。每个 adapter 都会在出口跑一次 `ensureValidHistory` 做边界 sanitize —— 删除孤儿 tool result、为缺失的 tool result 注入 `[No tool result available]` 占位、强制首条非 system 消息为 user。手动 `chef.setHistory(...)` 进来的 IR **不**做 sanitize：trust IR，或者自己显式调用 `ensureValidHistory(messages)`。

```typescript
import { fromOpenAI, fromAnthropic, fromGemini } from "@context-chef/core";

// OpenAI
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);

// Anthropic (system is a separate top-level parameter)
const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
chef.setSystemPrompt(system).setHistory(history);

// Gemini (systemInstruction is a separate top-level parameter)
const { system, history } = fromGemini(geminiContents, systemInstruction);
chef.setSystemPrompt(system).setHistory(history);
```

多模态内容（图片、文件）自动转换为 IR `attachments` 字段：

| Provider 格式                    | IR 字段                              |
| -------------------------------- | ------------------------------------ |
| OpenAI `image_url` / `file`      | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document`   | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` 时 `attachments` 自动转换回对应 provider 格式。压缩时 Janitor 会引导压缩模型描述图片内容。

---

### Target Adapters

| 特性                      | OpenAI                             | Anthropic                              | Gemini                               |
| ------------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------ |
| 格式                      | Chat Completions                   | Messages API                           | generateContent                      |
| 缓存断点                  | 移除                               | `cache_control: { type: 'ephemeral' }` | 移除（使用独立的 CachedContent API） |
| Prefill（尾部 assistant） | 降级为 `[System Note]`             | 原生支持                               | 降级为 `[System Note]`               |
| `thinking` 字段           | 移除                               | 映射为 `ThinkingBlockParam`            | 移除                                 |
| 工具调用                  | `tool_calls` 数组                  | `tool_use` blocks                      | `functionCall` parts                 |
| `attachments`             | `image_url` / `file` content parts | `image` / `document` blocks            | `inlineData` / `fileData` parts      |

适配器由 `compile({ target })` 自动选择。也可以独立使用：

```typescript
import { getAdapter } from "@context-chef/core";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

#### `openai-responses` target（v4）

面向 OpenAI Responses API 的第四个内置 target。`compile({ target: "openai-responses" })` 产出 `OpenAIResponsesPayload { instructions?, input, tools?, meta? }`，`fromOpenAIResponses(items, instructions?)` 是配套的 input adapter：

```typescript
import { fromOpenAIResponses } from "@context-chef/core";

const payload = await chef.compile({ target: "openai-responses" });
const { system, history } = fromOpenAIResponses(response.output, instructions);
```

往返转换处理 `message` / `function_call` / `function_call_output` 条目（按 `call_id` 关联，乱序安全），逐字节保留 reasoning 条目的 `encrypted_content`，并把 `input_image` / `input_file` part 转为 IR attachments。

#### Gemini thought signatures（v4）

Gemini 3.x 会拒绝当前轮次里缺失 thought signature 的 function call（HTTP 400）。`fromGemini` 会捕获它们 —— `functionCall` part 存进 `ToolCall.thoughtSignature`，text part 走透传字段 —— `GeminiAdapter` 原样重新发出。它们对 `compact({ clear: ['thinking'] })` 免疫。

#### `preserveThinkingAsText`（v4）

`new OpenAIAdapter({ preserveThinkingAsText: true })` / `new GeminiAdapter({ preserveThinkingAsText: true })` 会把 Anthropic 风格的 `thinking` 转成 `<thinking>...</thinking>` 文本前缀而不是丢弃 —— 适合在会话中途把 Claude 对话迁到其他 provider。`redacted_thinking` 永不文本化（丢弃，并给出一次警告）。默认 `false`。

#### 自定义适配器 —— `adapterRegistry` 与 `defaultTarget`

三个内置适配器（`'openai' | 'anthropic' | 'gemini'`）会自动注册。如果想接入第三方协议（Cohere、Mistral、自家私有协议），实现 `ITargetAdapter` 后注册一次即可：

```typescript
import { adapterRegistry, ITargetAdapter } from "@context-chef/core";

class CohereAdapter implements ITargetAdapter {
  compile(messages) {
    /* return Cohere-shaped payload */
  }
}

adapterRegistry.register("cohere", new CohereAdapter());
await chef.compile({ target: "cohere" }); // routed via the registry
```

`compile({ target })` 接受三种形式：

| 形式             | 示例                                   | 适用场景                            |
| ---------------- | -------------------------------------- | ----------------------------------- |
| 内置字面量       | `compile({ target: "openai" })`        | 通过类型重载获得精确 payload 类型   |
| 注册名字符串     | `compile({ target: "cohere" })`        | 复用同一个第三方适配器多次          |
| `ITargetAdapter` | `compile({ target: new MyAdapter() })` | 一次性使用 / 测试 — 跳过 registry   |

在构造函数中设置 `defaultTarget` 可以避免每次调用都传 target：

```typescript
const chef = new ContextChef({ defaultTarget: "anthropic" });
await chef.compile(); // → AnthropicPayload
```

`compile()` 解析顺序：
`options.target` → `ChefConfig.defaultTarget` → `'openai'`（最终内置兜底）。

对插件系统和测试隔离，可以传入 `sourceId`，把一组注册按来源批量卸载：

```typescript
adapterRegistry.register("cohere", new CohereAdapter(), "my-plugin");
adapterRegistry.register("mistral", new MistralAdapter(), "my-plugin");
// Later — unload the entire plugin in one call
adapterRegistry.unregisterBySource("my-plugin");
```

> **替换内置名**（如 `register('openai', myFork)`）会保留 strict overload 的 payload 返回类型 —— `compile({ target: 'openai' })` 仍标注为 `Promise<OpenAIPayload>`，因此你的替换实现在运行时必须遵守该 shape。TypeScript 无法在替换层面强制这个约束。

---

## Skills

ContextChef 提供了 [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)，帮助你交互式地将库集成到项目中。每个 Skill 会分析你现有的代码，生成定制化的集成代码。

| Skill                     | 描述                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `context-chef-core`       | 集成 `@context-chef/core` — 完全控制编译流程，多 provider 支持             |
| `context-chef-middleware` | 集成 `@context-chef/ai-sdk-middleware` — AI SDK 即插即用中间件，零代码改动 |

### 安装 Skill

按需安装：

```bash
# Core library (OpenAI / Anthropic / Gemini direct SDK usage)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK middleware (Vercel AI SDK v7+)
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# All
npx skills add MyPrototypeWhat/context-chef
```

### 使用

在项目中打开 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，输入：

```
/context-chef-core
# or
/context-chef-middleware
```

Claude 会：

1. **检测你的项目** — LLM SDK、包管理器、TypeScript 还是 JavaScript
2. **了解你的需求** — 历史压缩、工具管理、截断、记忆等
3. **生成集成代码** — 根据你的项目结构和现有 agent 循环定制
4. **解释核心架构** — 处理流程、缓存断点、动态状态注入位置
