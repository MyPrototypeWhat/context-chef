<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/raw/main/docs-site/public/logo.svg" width="88" alt="ContextChef" />
</p>

# ContextChef

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/core Downloads](https://img.shields.io/npm/dm/@context-chef/core.svg?label=%40context-chef%2Fcore%20downloads)](https://www.npmjs.com/package/@context-chef/core)
[![@context-chef/ai-sdk-middleware Downloads](https://img.shields.io/npm/dm/@context-chef/ai-sdk-middleware.svg?label=%40context-chef%2Fai-sdk-middleware%20downloads)](https://www.npmjs.com/package/@context-chef/ai-sdk-middleware)
[![@context-chef/tanstack-ai Downloads](https://img.shields.io/npm/dm/@context-chef/tanstack-ai.svg?label=%40context-chef%2Ftanstack-ai%20downloads)](https://www.npmjs.com/package/@context-chef/tanstack-ai)
[![License](https://img.shields.io/npm/l/@context-chef/core.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

TypeScript/JavaScript AI Agent 的上下文编译器。

ContextChef 解决 AI Agent 开发中最常见的上下文工程问题：对话太长模型会忘事、工具太多模型会幻觉、切换模型要重写 prompt、长程任务状态丢失。它不接管你的控制流，只负责在每次 LLM 调用前把你的状态编译成最优的 payload。

📖 **文档站：** <https://myprototypewhat.github.io/context-chef/zh/> · [English](./README.md)

## Packages

| 包 | 说明 |
|---|---|
| [`@context-chef/core`](./packages/core) | 核心上下文编译器 —— 溢出策略、工具裁剪、统一的上下文存储、管道插槽、多 provider 适配 |
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

## 全局地图

ContextChef 把无界的信息编译进有界的窗口。本 README 里的每一个特性都恰好落在五根轴中的一根上 —— 这就是全部的地图：

| 轴 | 回答的问题 | 由谁负责 |
|---|---|---|
| **① 选择（Selection）** | 什么进入窗口 | `overflow.strategy`（历史）、`Pruner`（工具）、`memory.selector`（记忆）、`pinned: true`（永远不许被拿走的） |
| **② 位置（Placement）** | 进入窗口后放在哪 | 三明治结构 —— system 层 → history → 末尾拼接 —— 以及 `memoryPlacement`、`skillPlacement`、`dynamicStatePlacement`、announcement channel 和可缓存前缀 |
| **③ 持久化（Persistence）** | 离开窗口后住在哪 | 一个 `StorageBackend` + 一个 `Store`，以 `context://<ns>/<path>` 寻址：`memory/`、`notes/`、`vfs/`、`archive/` |
| **④ 取回（Retrieval）** | 模型怎么伸手够到窗口之外 | 一个 `context` 工具（外加 `new_context`），经 `chef.ownsTool` / `chef.handleTool` 分发 |
| **⑤ 适配（Adaptation）** | Provider 线缆格式 | target adapter —— OpenAI / Anthropic / Gemini / 你自己的 |

溢出（overflow）不是第六件事：它就是信息从 ① 移动到 ③、并可经 ④ 取回的过程。`summarize` / `anchored` / `reset` 是 ① 的策略，`memory/` / `notes/` / `vfs/` / `archive/` 是 ③ 的命名空间，`view` / `search` / `recall_context` 是 ④ 的把手。找"某个东西住在哪"时，先找它属于哪根轴。

这五根轴上的一切都是**机制而非策略**：不拒绝任何配置组合；那些无法从根上避免的失败类型（前缀被改写、pinned 消息被丢、tool 配对被拆开）通过审计与事件通道**上报**，而不是拦下来。

## Features

**① 选择 —— 什么留在窗口里**

- **对话太长？** — 自动压缩历史消息，保留近期记忆，老对话交给小模型摘要
- **压缩把约束弄丢了？** — 约束固定（v4）：`pinned: true` 的消息原文穿过压缩，且永不被 `compact()` 清除
- **一种压缩策略不够用？** — 溢出策略（4.2）：`summarize` / `anchored` / `reset`，用 `chain()` 和 `background()` 组合，或者干脆写你自己的 `OverflowStrategy`
- **Provider 帮你做压缩？** — `server()` 策略把 LLM 压缩交给 Anthropic 服务端 compaction，裁剪/skills/记忆/VFS 仍留在客户端
- **压缩延迟拖慢主链路？** — `background()` 把摘要放到轮次之外运行，仅在仍然有效时换入；`anchored()` 把被驱逐的片段增量合并进一份持久摘要文档，而不是整份重写
- **消息存储归你管？** — 持久化压缩：`planCompaction` / `compactHistory`（以及 AI SDK 和 TanStack 移植版）把你的存储压缩一次并持久化结果，而不是每次调用都在途重复压缩
- **窗口马上要被砍了？** — 交接预算（4.2）：在触发线之上预留一段 token，让模型在机械驱逐发生之前拿到一次通知，把该留的状态写下来
- **工具太多？** — 按任务动态裁剪工具列表，或用双层架构（稳定分组 + 按需加载）彻底消除工具幻觉
- **运行时禁用工具？** — Pruner blocklist + `checkToolCall` dispatch 闸门，覆盖权限、环境、限流、沙箱等场景；默认 KV-cache 友好

**② 位置 —— 落在窗口的哪个位置**

- **按阶段切人格？** — `Skill` 原语打包指令 + 工具注解，支持从 `SKILL.md` 文件加载（与 Claude Code / Mastra / OpenCode 同格式）
- **会话中途能力变了？** — Announcements（4.1）：`announce()` 声明哪些工具/skill 上线或下线，并在每次 compile 时重新渲染，直到你撤回；`skillPlacement: 'tail'` 把 skill instructions 移出可缓存前缀，切换模式再也不会让前缀失效
- **长程任务跑偏？** — Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点
- **输出格式跑偏？** — Guardrail：`withGuardrails` 强制 XML 输出契约并设置 assistant prefill，在不支持原生 prefill 的 provider 上自动降级
- **每轮都在击穿 prompt cache？** — `memoryPlacement: 'before_history_tail'` 和 `skillPlacement: 'tail'` 把易变文本移出可缓存前缀；`cacheAudit` 会点名仍然留在里面的内容

**③ 持久化 —— 离开窗口后住在哪**

- **终端输出太大？** — 自动截断并卸载到 `vfs/`，保留错误行 + `context://` URI 指针供按需取回
- **跨会话记不住？** — `memory/` 让模型持久化关键信息（项目规范、用户偏好），下次会话自动注入
- **摘要丢了你想找回的细节？** — 可逆归档：溢出前的完整片段被存储，并在替换它的摘要里以 URI 引用
- **一件事四套存储接口？** — 一个 `StorageBackend` + 一个 `Store`（4.2）：记忆、笔记、卸载的输出和归档的片段，是同一种底料在不同地址上的样子
- **想回滚怎么办？** — Snapshot & Restore 一键捕获和回滚全部上下文状态，支持分支探索

**④ 取回 —— 模型怎么伸手够回来**

- **每个命名空间一个工具？** — 一个 `context` 工具（4.2）覆盖 view / create / str_replace / insert / delete / rename / search，经 `chef.handleTool` 分发；用 `tools: 'unified'` 开启
- **模型自己知道这段活干完了？** — `new_context` + `chef.requestNewContext()`（4.2）强制下一次 compile 开一个新窗口
- **需要外部上下文？** — `before-assemble` 插槽（4.2 之前是 `onBeforeCompile` 钩子）让你在编译前注入 RAG 检索结果、AST 片段或 MCP 查询

**⑤ 适配 —— provider 线缆格式**

- **换模型要重写？** — 同一套 prompt 编译到 OpenAI / Anthropic / Gemini，prefill、cache、tool call 格式自动适配

**贯穿整条管道**

- **想往管道里插东西？** — 管道插槽（4.2）：`chef.use('before-overflow' | 'after-overflow' | 'before-assemble' | 'after-assemble' | 'before-adapt' | 'after-adapt', handler)`
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
  janitor?: JanitorConfig,                       // ① 什么时候超预算
  overflow?: { strategy?: OverflowStrategy, archive?: 'vfs' | CompressionArchiveConfig, handoff?: { budgetTokens: number, prompt?: string } },
  pruner?: { strategy?: 'union' | 'intersection' },
  memory?: MemoryConfig,                         // ③ memory/ 命名空间
  vfs?: { threshold?: number, store?: StorageBackend | Store, storageDir?: string, maxAge?: number, maxFiles?: number, maxBytes?: number, onVFSEvicted?: (entry, reason) => void },
  store?: StorageBackend | Store,                // ③ 一个后端服务所有命名空间
  tools?: 'legacy' | 'unified',                  // ④ compile() 发出哪套库自带工具
  contextTool?: { writable?: string[] },         // ④ 模型可写的命名空间
  skillPlacement?: 'after_system' | 'tail',      // ②
  defaultTarget?: TargetProvider | ITargetAdapter, // ⑤
  logger?: ChefLogger,
  cacheAudit?: boolean,                          // 可缓存前缀里出现易变内容时告警
  pipelineChecks?: boolean,                      // 开发期不变量，只上报不拦截
  transformToolResult?: (content: string, info: { toolName: string | null; toolCallId: string | null }) => string | Promise<string>,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,   // @deprecated → use('after-assemble')
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>, // @deprecated → use('before-assemble')
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

**缓存安全落点（4.1）。** `placement: 'last_user'` 会把 enforce-XML 指令通过最后一条 user 消息的尾部注入送达（与动态状态同一通道），而不是走 system message。这在 Anthropic 上很关键：每条 `role: 'system'` 消息都会被提取进 top-level `system` 前缀，因此在默认的 `placement: 'system'` 下，护栏一有改动就会击穿其下游的所有 cache breakpoint。`prefill` 在两种落点下均不受影响。

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

不要手写这个计数函数 —— `createTokenizerAdapter`（4.1）可以包装任何 `(text) => tokens` 编码器，并把计入哪些字段的约定一次性固化下来（content + thinking + redacted 数据 + **tool call 的名称/参数** —— 手写 adapter 最常漏掉的正是这个字段，而 coding agent 的一段轨迹里，write/edit 类工具的 token 大头恰恰落在这里）：

```typescript
import { createTokenizerAdapter } from "@context-chef/core";
import { encode } from "gpt-tokenizer"; // or js-tiktoken, etc. — your dependency, not ours

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer: createTokenizerAdapter(encode) },
});
```

跨 provider 的计数是近似值（o200k 只对 OpenAI 精确），在默认 `triggerRatio: 0.7` 的余量下这是安全的；需要精确记账时，请用 `reportTokenUsage()` 配合 provider 返回的用量。

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

> **注意：** 如果没有提供 `compressionModel`，旧消息将被直接丢弃而不生成摘要。如果同时没有 `tokenizer` 和 `compressionModel`，构造时会打印一次控制台警告；显式配置了 `overflow.strategy`（或 `janitor.strategy`）则视为你有意为之，不再警告。

#### `JanitorConfig`

Runner 选项 —— 什么时候触发压缩、拿什么去量、压缩前后发生什么。这些是 Janitor 自己的事，与装了哪个[溢出策略](#溢出--什么离开窗口42)无关：

| 选项                            | 类型                                        | 默认值 | 说明                                                                     |
| ------------------------------- | ------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `contextWindow`                 | `number`                                    | _必填_ | 模型的上下文窗口大小（token 数）。用量超过 `contextWindow × triggerRatio` 时触发压缩。 |
| `triggerRatio`                  | `number`                                    | `0.7`  | 触发压缩的 `contextWindow` 占比（"腐烂前"提前压缩）。设为 `1` 可恢复 4.0 之前打满窗口才触发的行为。 |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —      | 启用 tokenizer 路径，精确计算每条消息的 token 数。                       |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`| 当 `tokenizer` 与 `reportTokenUsage` 同时存在时，决定触发判断使用哪个 token 来源。无 `tokenizer` 时取值范围收窄为 `'max' \| 'feedFirst'`，TypeScript 在编译期拒绝 `'tokenizerFirst'`。完整说明见 [core 包 README](./packages/core)。 |
| `onCompress`                    | `(summary, count, details) => void`         | —      | 压缩完成后触发，传入摘要消息和被截断的消息数量。`details.compressedMessages` 是被摘要替换的那段消息切片。 |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —      | 预算判定认为要执行溢出之后、策略运行之前触发。返回修改后的历史来干预，或返回 null 让默认压缩继续执行。它没有被废弃，也不是 `before-overflow` 插槽 —— 那个在 chef 这一层，每次 compile 都会触发。 |
| `logger`                        | `ChefLogger`                                | —      | 降级警告的日志接收器（存储/压缩），默认使用 `console`。 |
| `strategy`                      | `OverflowStrategy`                          | —      | runner 应用的策略。直接构造 `Janitor` 时用它；经 `ContextChef` 请用 `overflow.strategy`。 |

策略选项 —— 还是原来那些字段，如今是 `summarize()` / `anchored()` 的选项。写在这里（4.1 的写法）就是去构造默认策略；一旦显式配了 `overflow.strategy`，以策略为准并警告一次：

| 选项                            | 类型                                        | 默认值 | 说明                                                                     |
| ------------------------------- | ------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —      | 异步钩子，调用低成本 LLM 对旧消息进行摘要。                              |
| `customCompressionInstructions` | `string`                                    | —      | 追加到默认压缩 prompt 的额外聚焦指令（追加模式，不替换）。               |
| `compressionGuidelines`         | `string[]`                                  | —      | 注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。 |
| `toolResultStubThreshold`       | `number`                                    | —      | 摘要前把长于该字符数的 tool result 内容替换为一行元数据 stub（节省摘要模型 token）。 |
| `minShrinkRatio`                | `number`                                    | `0.5`  | 质量闸门：摘要必须让被压缩片段至少缩小该比例（仅对 ≥ 2000 字符的片段生效）；否则本次压缩失败，历史保持不变。`0` 关闭。 |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | 摘要后闸门。返回 `false`（或抛出）即拒绝该摘要 —— 历史不变，熔断计数 +1。 |
| `preserveRatio`                 | `number`                                    | `0.8`  | [Tokenizer 路径] 有效预算（`contextWindow × triggerRatio`）中保留给近期消息的比例。 |
| `preserveRecentMessages`        | `number`                                    | `1`    | [reportTokenUsage 路径] 压缩时保留的近期轮次数量。                       |
| `archive`（已废弃）              | `CompressionArchiveConfig \| 'vfs'`         | —      | → `overflow.archive`，现在对所有策略生效。可逆压缩：存储压缩前的完整片段，并在摘要中引用其 URI。 |
| `compressionMode`（已废弃）      | `'rewrite' \| 'incremental-anchored'`       | `'rewrite'`| → `overflow.strategy: summarize(...)` / `anchored(...)`。 |
| `compressionScheduling`（已废弃）| `'blocking' \| 'background'`                | `'blocking'` | → `overflow.strategy: background(...)`。 |

**压缩输出契约。** Janitor 默认 prompt 要求压缩模型输出两阶段响应：先在 `<analysis>` 里写草稿推理（会被剥除），再输出结构化的 `<summary>` 块，包含 5 个领域无关的章节（Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve）。原始输出在注入前会经过 `Prompts.formatCompactSummary` 清洗。完整契约与 `customCompressionInstructions` 用法见 [core 包 README](./packages/core)。

**失败语义（4.0 起变更）。** 压缩模型失败 —— 抛出异常、摘要未通过 `minShrinkRatio`、或被 `validateCompression` 拒绝 —— 会让历史**保持不变**（4.0 之前会截断历史并留下占位符），并使熔断计数 +1。如果连续 3 次 `compress()` 失败，`compress()` 将变为 no-op，直到下一次成功压缩或显式调用 `janitor.reset()` / `chef.clearHistory()`。失败计数由 `chef.snapshot()` / `chef.restore()` 保存。

**独立摘要。** `summarizeHistory(messages, compress, opts?): Promise<string>` 是该路径背后与 provider 无关的原语 —— 可直接调用它压缩你自己存储中的一段切片。空切片返回 `''`；无状态，且 `compress` 抛出时**直接抛出**；`compress` 回调**必须扁平化** `tool` 角色。可选项包括 `customCompressionInstructions`、`toolResultStubThreshold`、`compressionGuidelines` 和 `baseInstruction`。完整契约见 [core 包 README](./packages/core)，更高层的辅助函数见下文[持久化压缩](#持久化压缩)。

#### 压缩质量闸门（v4）

v4 围绕一条规则重建了压缩路径：坏摘要永远不能替换好历史。这些闸门属于 runner 和做摘要的策略，因此无论你装的是哪个 `overflow.strategy` 都成立。

- **腐烂前触发 —— `triggerRatio`（默认 `0.7`）**：压缩在 `contextWindow × 0.7` 处触发，而不是等到硬上限 —— 模型质量早在窗口占满之前就开始退化。`preserveRatio` 作用于这个有效预算。`triggerRatio: 1` 恢复 4.0 之前的行为。
- **约束固定 —— `pinned: true`**：固定的消息原文穿过 `compress()`（按序重新插入到摘要之后），且永不被 `compact()` 清除。固定原子轮次中的任一消息即可保护整个轮次。每个策略都会收到这份 pinned 集合，且必须原样交还。用于策略与约束文本 —— 压缩丢掉策略文本会把违规率从 0% 拉到 30% 以上（arXiv:2606.22528）。
- **缩减闸门 —— `minShrinkRatio`（默认 `0.5`）**：摘要若未能让被压缩片段缩小 ≥ 50%（按字符长度；仅对 ≥ 2000 字符的片段生效）即视为压缩失败 —— 历史不变，熔断计数 +1。防止压缩死循环。`0` 关闭。`anchored()` 下这道闸门比较的是 anchor 的**增量**，而非绝对大小。
- **`validateCompression`**：摘要后闸门 `(summary, { compressed, kept }) => boolean | Promise<boolean>` —— 返回 `false` 或抛出即拒绝该结果（历史不变，熔断计数 +1）。
- **`compressionGuidelines`**：注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200_000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    triggerRatio: 0.7,       // default — compress "pre-rot"
    minShrinkRatio: 0.5,     // default — reject summaries that barely shrink
    compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  },
  overflow: { archive: "vfs" },   // 可逆：完整片段被存储，摘要引用一个 context:// URI
});

// Pin constraint text — survives compress() verbatim, never cleared by compact()
history.push({
  role: "user",
  content: "NEVER touch prod. Deploy only from CI.",
  pinned: true,
});
```

原先写在这里的三个策略选择 —— 可逆 `archive`、增量 anchored 模式、后台调度 —— 现在都是策略：见[溢出](#溢出--什么离开窗口42)。把归档片段读回来见[召回](#召回--把归档片段读回来)。

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

### 溢出 —— 什么离开窗口（4.2）

Janitor 决定**什么时候**窗口超预算，`OverflowStrategy` 决定**什么离开窗口**。4.2 之前这两件事挤在同一个类里；现在一个是 runner，一个是策略，而策略是你传进来的一个值：

```typescript
import { ContextChef, chain, summarize, reset } from "@context-chef/core";

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },   // runner：预算、触发线、熔断
  overflow: {
    strategy: chain(summarize({ compressionModel: callGpt4oMini }), reset()),
    archive: "vfs",                                  // 被驱逐的内容仍然可取回
    handoff: { budgetTokens: 2_000 },                // 挨刀之前的一次预警
  },
});
```

其余什么都没动。`contextWindow`、`tokenizer`、`usagePreference`、`triggerRatio`、`onCompress`、`onBeforeCompress`、`logger`、熔断器、`compress:*` 事件和持久化压缩都是 runner 的事，仍然原样留在 [`JanitorConfig`](#janitorconfig) 上。`overflow.strategy` 取代的是 `janitor.compression*` 系列字段和 `contextManagement` —— 见[已废弃的溢出选项](#已废弃的溢出选项42)，它们仍然可用。

#### 内置策略

每个都是 barrel 里的工厂函数。按你愿意付的代价来选：

| 策略 | 做什么 | 代价 |
|---|---|---|
| `summarize(opts)` | 用一段 LLM 摘要替换最老的那些轮次。4.x 的默认行为（`compressionMode: 'rewrite'`）。 | 每次溢出多一次模型调用，且整份摘要每次都重写。摘要没写进去的东西就此离开窗口，除非开了 `archive`。 |
| `anchored(opts)` | 维护一份持久的 anchor 文档，每次只把新驱逐的片段合并进去，而不是从头重生成摘要（Factory.ai 模式）。 | anchor 单调增长，最终自己也要占预算。它的缩减闸门比较的是 anchor 的**增量**，不是绝对大小。 |
| `server(config, { fallback })` | 在有服务端上下文管理的 target（目前是 Anthropic）上，客户端根本不压缩 —— 跳过 overflow 阶段，payload 带上 `context_management` + betas。 | 其他 target 无处可托付：跑 `fallback`；没配 fallback 就原样放着不动。 |
| `reset(opts)` | 保留 pinned 消息，其余全部驱逐，留下一行点名"已关闭窗口"的说明。 | 零次模型调用 —— 但没配 `archive` 就是有损的。这个组合是文档说明，不做拦截。 |
| `chain(...strategies)` | 上一个策略什么都没改、或改完仍在触发线之上时，接着跑下一个。 | 顺利时不额外花钱；一次完整升级则是所有策略的代价之和。 |
| `background(strategy)` | 把 `strategy` 挪到轮次之外跑：超预算的那次 compile 原样返回历史，之后的 compile 在被摘要片段仍是当前历史前缀时把结果换入（arXiv:2605.08580）。 | 换入之前会有一到多次 compile 带着超预算的 payload 发出去；过期结果被丢弃；后台状态不进快照。 |

`summarize()` 和 `anchored()` 接受同一组选项 —— 就是原先挂在 `JanitorConfig` 上的那些字段：

```typescript
summarize({
  compressionModel: async (msgs) => callGpt4oMini(msgs),
  compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  customCompressionInstructions: "Keep every unresolved question.",
  minShrinkRatio: 0.5,          // 默认 —— 拒绝几乎没缩小的摘要
  validateCompression: (summary, { compressed, kept }) => summary.includes("Next Steps"),
  preserveRatio: 0.8,           // [split: 'ratio'] 触发预算中保留给近期轮次的比例
  preserveRecentMessages: 1,    // [split: 'recent-turns'] 保留的近期轮次数量
  toolResultStubThreshold: 5_000,
  split: "ratio",               // 不传时按你设了哪个 preserve 选项推断
});
```

`split` 是唯一的新字段：`'ratio'` 用 runner 的 tokenizer 给保留下来的尾部定价，`'recent-turns'` 只数轮次。不显式配 `overflow.strategy` 时，配了 `tokenizer` 就走 `'ratio'`，否则走 `'recent-turns'` —— 和 Janitor 两条路径一直以来的切分方式完全一致。

`chain` 存在的理由就是"升级"：

```typescript
// 正常走摘要；摘要模型挂了、或产出持续过不了缩减闸门时，
// 直接丢掉窗口，而不是让它无限膨胀。
overflow: {
  strategy: chain(summarize({ compressionModel }), reset()),
  archive: "vfs",
}
```

策略只是一个对象，所以你自己写的策略是一等公民：

```typescript
import type { OverflowStrategy } from "@context-chef/core";

const dropToolResults: OverflowStrategy = {
  name: "drop-tool-results",
  async apply({ history, pinned, window }) {
    const keep = new Set(pinned);
    const evicted = history.filter((m) => m.role === "tool" && !keep.has(m));
    return {
      history: history.filter((m) => !evicted.includes(m)),
      evicted,
      meta: { strategy: "drop-tool-results", windowId: window.current, changed: evicted.length > 0 },
    };
  },
};
```

接口另有三个可选方法：`commit(result)`、`snapshot()`、`restore(state)`。`apply` 可能是投机执行的（`background()` 就是这么干的），所以从自己产出里派生的状态 —— 比如 anchor 文档 —— 要在 `commit` 里发布，而 `commit` 只在结果真正进入窗口时才会被调用。

#### 可逆归档 —— `overflow.archive`

4.2 起归档与策略无关：不管哪个策略驱逐了什么，被驱逐的内容都会被序列化、存储，并在替换它的摘要里以 URI 引用，因此精确细节始终可取回，而不是靠重要性打分去猜（arXiv:2607.25066、arXiv:2607.08032）。

```typescript
overflow: { strategy: reset(), archive: "vfs" }               // 片段存进本 chef 的 VFS
overflow: { archive: { store: async (serialized, { messageCount }) => uploadToS3(serialized) } }
```

尽力而为：存储失败只记一条警告并跳过引用，不会让 compile 失败。4.x 里归档片段仍然落在 `vfs` 命名空间，因此 `context://vfs/...` URI 与 4.1 逐字节一致；独立的 `archive/` 命名空间留给 5.0 切换。配合 [`context` 工具](#context-工具42)（legacy 工具集下则是 `recall_context`）让模型把片段拉回来。

#### 交接预算（4.2）

溢出是机械的：策略驱逐了什么，那些内容就离开了窗口，不管模型准备好了没有。交接预算在触发线**之上**预留一段余量，把它花在一次通知上，让模型趁对话还摆在眼前时，把该留的东西写进上下文存储。

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    handoff: { budgetTokens: 4_000 },   // 剩余余量 ≤ 4000 时发出通知
    strategy: reset(),
    archive: "vfs",
  },
});
```

- 通知**每个窗口只渲染一次** —— 在触发线附近待很久也不会每轮重复 —— 窗口 id 变化时该标记重置。
- 它和 announcements 走同一条末尾通道（`channel: 'auto'`），且**永不持久化**：不进你的 history，不出现在 `getAnnouncements()` 里，服务端托管的 compile 会跳过它。
- 默认文案是 `Prompts.HANDOFF_NOTICE_TEMPLATE`。自定义 `prompt` 可以写 `{n_remaining}`，会被替换成触发线之前剩余的余量（取整、下限为 0），文案上限 2000 UTF-8 字节。
- `budgetTokens` 必须是正整数；它和 prompt 都在构造时校验，而不是等到那次会被静默跳过的 compile。

```typescript
overflow: {
  handoff: {
    budgetTokens: 4_000,
    prompt:
      "About {n_remaining} tokens remain before compression. " +
      "Write anything that must survive to context://notes/handoff.md now.",
  },
}
```

#### `new_context` —— 模型手里的窗口把手（4.2）

`chef.requestNewContext()` 强制下一次 `compile()` 无视预算直接跑溢出策略。和 `clearHistory()` 不同，它不会绕过库把对话丢掉：仍然由安装的策略决定什么活下来，`archive` 照常生效，`before-overflow` 处理器也仍然可以否决。

```typescript
import { getNewContextToolDefinition } from "@context-chef/core";

chef.registerTools([getNewContextToolDefinition()]);   // 静态、无参数、对缓存安全

// 在你的 agent loop 里：
if (call.function.name === "new_context") {
  chef.requestNewContext();
  history.push({ role: "tool", tool_call_id: call.id, content: "Starting a new context window." });
}
```

在 `tools: 'unified'` 下，只要配了 `overflow.handoff`，这个定义会自动出现在 payload 里，并由 `chef.handleTool` 分发 —— 见 [`context` 工具](#context-工具42)。这次请求会被一次 compile 消费掉，无论窗口是否真的换了（策略可能拒绝执行；熔断器可能是打开的），需要重试就再调一次。

在 `summarize()` 和 `anchored()` 下，强制那一趟会压掉除最近一轮之外的所有轮次 —— `preserveRecentMessages` 和 `preserveRatio` 不参与，它们是为了把满窗口压回触发线以下，而这一趟与预算无关。窗口里只有一轮时什么都不会发生。有两种编译会直接不做溢出 —— 服务端托管的目标和 `before-overflow` 的否决 —— 强制请求这样落空时，会通过 `pipeline:invariant` 事件加上按原因各一次的警告上报，绝不静默。

#### 窗口谱系 —— `meta.windowId`（4.2）

每个上下文窗口都有一个 id。runner 只在**提交时**分配新 id —— 也就是溢出结果真正进入窗口的那一刻；被丢弃的过期 `background()` 结果永远不会推进它。

```typescript
const payload = await chef.compile({ target: "anthropic" });
payload.meta?.windowId; // 'w_…' —— 只在模型身后的历史被改写时变化
```

两次 payload 带同一个 id，说明它们是针对同一个窗口编译的；id 变了就是"模型能看到的对话被改写过"的信号 —— 用来让你自己的缓存失效，或往存储里写一条窗口边界。`OverflowResult.meta.windowId` 是策略**作用于**的那个窗口；`CompileMeta.windowId` 是本次 payload 所属的窗口。`anchored()` 按窗口 id 存放 anchor 文档，谱系随 `snapshot()` / `restore()` 往返，`clearHistory()` 从头开始。

#### 服务端上下文管理

Provider 现在可以在服务端执行 compaction（Anthropic `compact_20260112`、OpenAI `/responses/compact`）—— 少一次模型调用，还有精确的 token 计数。`server()` 把 LLM 压缩交给 provider；服务端不做的一切仍留在客户端：工具裁剪、skills、记忆、VFS 卸载、动态状态。

```typescript
import { server, summarize } from "@context-chef/core";

const chef = new ContextChef({
  overflow: {
    // Anthropic → 服务端压缩；其他 target → 本地 summarize。
    strategy: server(undefined, { fallback: summarize({ compressionModel }) }),
  },
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `config` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

- 在服务端托管的 target 上，客户端的 overflow 阶段被完全跳过；机械 `compact()` 和其他模块照常运行。
- 第一个参数是按 provider 形状原样透传的 edits 配置，例如 `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` 或 `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`。`payload.betas` 自动推导：compaction 类 edit 对应 `'compact-2026-01-12'`，clear-tool-uses / clear-thinking 类 edit 对应 `'context-management-2025-06-27'`。
- **compaction 块往返**：`fromAnthropic` 把 API 的 `{ type: 'compaction', content }` 块映射为标记 `pinned: true` 的透传消息，Anthropic adapter 在下次编译时把该块原文重新放在最前面 —— 服务端产出的摘要原样穿过客户端管道。

这是混合定位，不是二选一：LLM 压缩可以交给 provider，同时 ContextChef 继续做服务端不做的部分 —— 裁剪、skills、记忆、VFS 和动态状态。AI SDK 用户有配套防护：middleware 检测到某次调用带 `providerOptions.anthropic.contextManagement` 时，会为该次调用跳过自己的压缩（见 [ai-sdk-middleware README](./packages/ai-sdk-middleware/README.md#anthropic-server-side-context-management)）。

已废弃的 `contextManagement: { strategy: 'server' }` 会替你构造 `server(config, { fallback: <默认的客户端策略> })`，这正是 v4 的行为。

#### 已废弃的溢出选项（4.2）

下面每个字段都仍然可用、行为不变 —— 它们现在只是去**构造**右边那个策略。5.0 移除。同时设置字段和显式的 `overflow.strategy` 会警告一次，并以策略为准。

| 已废弃 | 替代 |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy: summarize(opts)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy: anchored(opts)` |
| `janitor.compressionScheduling: 'background'` | `overflow.strategy: background(strategy)` |
| `janitor.archive` | `overflow.archive`（现在对所有策略生效，不再只是 `summarize` 的内部事） |
| `contextManagement: { strategy: 'server', server }` | `overflow.strategy: server(server, { fallback })` |
| `janitor.{compressionModel, compressionGuidelines, customCompressionInstructions, minShrinkRatio, validateCompression, preserveRatio, preserveRecentMessages, toolResultStubThreshold}` | `summarize()` / `anchored()` 的选项 |
| `JanitorSnapshot.anchorDoc` | `JanitorSnapshot.strategy`（策略的不透明状态；4.2 之前的快照仍能恢复 anchor） |

---

### 上下文存储（4.2）

ContextChef 放在窗口**之外**的一切，本质是同一种东西的不同地址：跨会话的持久事实、模型自己的工作笔记、大到没法内联的工具输出、被压缩掉的对话片段。4.2 起它们共用一套底料 —— 一个负责搬字节的 `StorageBackend`，外面套一个 `Store` 提供命名空间、`context://` 寻址、访问索引和驱逐。

| 命名空间 | 放什么 | 在窗口里吗 | 模型可写 |
|---|---|---|---|
| `memory/` | 值得带到下次会话的持久事实 | 每次 compile 都注入 | 是（默认） |
| `notes/` | 模型自己的草稿纸 | 从不 —— 这正是它的意义 | 是（默认） |
| `vfs/` | 被卸载的工具输出，靠留在原地的 URI 寻址 | 只有它读回来的部分 | 否（默认只读） |
| `archive/` | 预留给摘要引用背后的溢出前片段 —— 4.x 里没有东西往这写，`overflow.archive` 仍然落在 `vfs/` | 只有它读回来的部分 | 否（默认只读） |

```typescript
import { ContextChef, FileSystemBackend, InMemoryBackend, Store } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"), // 一个后端服务所有命名空间
  memory: {},
  vfs: { threshold: 5_000 },
});

await chef.getStore().namespace("notes").put("plan.md", "# Plan\n");
Store.uri("notes", "plan.md");                 // 'context://notes/plan.md'
Store.parseUri("context://notes/plan.md");     // { ns: 'notes', path: 'plan.md' }
```

`ChefConfig.store` 只填补没人指定的部分：显式的 `memory.store` 仍然对 memory 优先，显式的 `vfs.store` / `vfs.adapter` / `vfs.storageDir` 仍然对 VFS 优先。两者都不配时，4.1 的默认行为原样不变。

内置后端有 `InMemoryBackend`（进程内，什么都不配时的默认）和 `FileSystemBackend`（单一根目录、按命名空间布局、写入原子）。一个后端就是四个必需方法 —— `read` / `write` / `delete` / `list` —— 外加可选的 `readAll`、`exists`、`append`、`search`、`snapshot`、`restore`、`getPhysicalPath`，每一个都按能力查询：向命名空间要一个后端做不到的能力会抛 `StoreCapabilityError`（经 `context` 工具进来时则变成模型能读懂的错误文本），而不是悄悄失败。

```typescript
// 需要按命名空间配置驱逐或 URI scheme 时，传一个自己建好的 Store
const store = new Store(new InMemoryBackend(), {
  eviction: { vfs: { maxFiles: 200, maxBytes: 50 * 1024 * 1024 } },
});
const chef = new ContextChef({ store, memory: {} });

const notes = chef.getStore().namespace("notes");
await notes.put("plan.md", "# Plan\n", { description: "current plan" });
await notes.append("plan.md", "- ship 4.2\n");
notes.uri("plan.md");                       // 'context://notes/plan.md'
if (notes.supports("search")) await notes.search("ship");
const { path } = await chef.getStore().namespace("vfs").put("big output"); // 内容寻址的自动 id
```

`NamespaceView` 的每个方法都跟随后端的同步/异步性质，所以同步后端下同步调用点（`chef.offload`、`memory.snapshot`）照常工作；`getSync` / `putSync` / `deleteSync` / `listSync` 是显式的同步变体，遇到返回 Promise 的后端会抛出带指引的错误，而不是悄悄降级。

**四套老存储接口仍然可用。** 它们是被包装的，不是被重写的，原有测试全部照常通过 —— 但 5.0 会移除：

| 已废弃 | 替代 |
|---|---|
| `MemoryStore`（`memory.store`） | `StorageBackend`（或 `Store`）；经 `Store.fromMemoryStore` 包装，`MemoryStoreEntry` 的每个字段一一映射到 `StoredEntry.meta` |
| `VFSStorageAdapter`（`vfs.adapter`） | 作为 `vfs.store` 的 `StorageBackend`；经 `Store.fromVfsAdapter` 包装，用它那套扁平 keyspace 同时服务 `vfs` 和 `archive` |
| `VFSMemoryStore(dir)` | `new Store(new FileSystemBackend(dir))` 作为 `memory.store` —— 仅限**新**目录。裸后端读不了 `VFSMemoryStore` 的 `<base64url>.mem` 文件；要接着用已有目录，就留着这个 store，或用 `Store.fromMemoryStore` 包一层 |
| `FileSystemAdapter(dir)` | `FileSystemBackend(dir)`，一个根目录服务所有命名空间 |

`InMemoryStore` 没有被废弃 —— 测试里它仍然是最省事的临时 `memory.store` —— 只是现在一个 `InMemoryBackend` 就能一次覆盖所有命名空间。

#### Memory —— `memory/` 命名空间

跨会话持久化的键值记忆，每次 compile 都会注入。4.2 没有改动它的任何语义，只是它现在读写的是 `context://memory/<key>`。

```typescript
import { ContextChef, FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"),
  memory: {
    defaultTTL: 20,                          // 裸数字 = 轮次；也接受 { ms } / { turns }
    allowedKeys: ["persona", "project_rules"],
    selector: (entries) => entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
    onMemoryUpdate: (key, value, oldValue) => key !== "locked",  // 否决钩子：返回 false 拦下写入
    onMemoryChanged: (event) => audit.log(event),
    onMemoryExpired: (entry) => audit.log(entry),
    memoryPlacement: "before_history_tail",
  },
});

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");
```

`allowedKeys` 限制模型能创建哪些 key，`selector` 在过期条目被清扫之后决定注入什么、怎么排、注入多少，TTL 过期在 `compile()` 期间触发 `memory:expired`，整个命名空间随 `chef.snapshot()` / `chef.restore()` 往返。`compile()` 时已有条目以 `<memory>` 块注入；在默认的 `tools: 'legacy'` 下，`create_memory` / `modify_memory` 两个工具会被加进 `payload.tools`。

`tools: 'legacy'` 下这两个工具由你自己分发，和 4.1 完全一样：

```typescript
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") await chef.getMemory().updateMemory(key, value, description);
    else await chef.getMemory().deleteMemory(key);
  }
}
```

自 4.1 起，这两个工具定义是**静态**的 —— 无论当前存在哪些 key，每次 compile 都是同一份 schema、同一批对象引用。（此前 `modify_memory` 内嵌一份实时 key 的枚举，且只在存在 key 时出现；而工具位于每个 provider prompt 前缀的最顶部，每次 key 变动都会击穿整个 prompt cache。）现在改由注入的 memory 块向模型呈现当前有哪些 key，未知 key 的调用依然会在 `updateMemory` / `deleteMemory` 处安全失败。不想写这段分支的话，`chef.handleTool` 也能分发它们 —— 见 [`context` 工具](#context-工具42)。

##### Memory 位置 —— `memoryPlacement`

控制易变的 `<memory>` 数据块在编译产物中的落点。默认 `'after_system'`（向后兼容）。如果你在用 **Anthropic prompt caching** 且 cache breakpoint 打在 history 上，切换到 `'before_history_tail'`，这样 memory 变化就不会击穿 history 的缓存了。

| Placement | 三明治顶部 | 最后一条 user 消息 | 适用场景 |
|---|---|---|---|
| `'after_system'`（默认） | INSTRUCTION + `<memory>` 数据合并成一条 `role: 'system'` | 不动 | 简单 agent；不依赖 system 参数之后的 cache breakpoint |
| `'before_history_tail'` | 仅 INSTRUCTION（稳定，可缓存） | 在原 user 内容后追加 `<memory>` 数据块 | 你希望 history（或更靠前的 `system`）上的 cache breakpoint 在每轮 memory 变化时都能命中 |

这个拆分把稳定的使用说明留在三明治顶部享受缓存，把易变的数据块送到对话末尾。Anthropic / Gemini adapter 会把所有 `role: 'system'` 提取到 top-level `system` 参数 —— 选 `'before_history_tail'` 后，数据块改留在 `messages` 里，任何打在消息流更早位置的 cache breakpoint 都不再把变化的 memory 文本算进 hash。

如果动态状态也注入到末尾（`dynamicStatePlacement: 'last_user'`），最后一条 user 消息内部顺序是：原内容 → `<memory>` → `<dynamic_state>` → `<implicit_context>` → 锚定句。如果动态状态走独立 system message（`dynamicStatePlacement: 'system'`），memory 仍然注入到 user 末尾，但不会带锚定句。

##### Anthropic 缓存审计（4.1）

易变内容一旦落在被缓存的 prompt 前缀里，每次变化都会悄无声息地让 prompt caching 失效。这项审计检查的正是编译后的 Anthropic payload 里有没有这类问题 —— memory 数据、动态状态、隐式上下文或护栏指令被放在了最后一个 `cache_control` breakpoint 处或其之前 —— 并针对每个问题给出对应的修复方式：

```typescript
import { auditAnthropicCachePlacement } from "@context-chef/core";

const payload = await chef.compile({ target: "anthropic" });
for (const issue of auditAnthropicCachePlacement(payload)) {
  console.warn(`${issue.location}: ${issue.message}`);
}

// Or let the chef warn automatically (each distinct issue once per instance):
const chef = new ContextChef({ cacheAudit: true /* Anthropic targets only */ });
```

它按**两套**词汇的 header 识别 memory 块，所以在 `tools: 'unified'` 下审计照常工作。

**只做 Anthropic 是有意为之**：它是唯一提供显式、客户端可见 breakpoint 的 provider，因此这项检查完全确定 —— 检查的是 payload 的结构属性，零启发式。OpenAI 的自动前缀缓存和 Gemini 的隐式缓存都没有暴露可供审计的标记，所以不为它们提供等价功能。

#### 大文本卸载 —— `vfs/` 命名空间

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

模型看到的截断标记里带着可以读回完整内容的 URI。读回来这件事属于取回轴：`chef.resolveRecall(uri)`、legacy 工具集下的 `recall_context` 工具，或 `unified` 下 `context` 工具的 `view` 命令。

##### 清理与生命周期

`.context_vfs/`（或你自己存储的根目录）不会自动收敛 —— 你需要自己配置上限并触发清理，从不自动执行。

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

进程重启后，`reconcile()` 会扫描存储，把内存索引外的孤儿文件接管回来，让后续 `cleanup()` 可以看到它们：

```typescript
const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
// createdAt parsed from legacy vfs_<ts>_<hash>.txt names; content-addressed names date from adoption. bytes measured if requested.
```

清理是**机制而非策略** —— `compile()` 不会自动触发它。如果你想按轮强制执行，绑到 `compile:done` 事件钩子；否则在 agent loop 或会话结束时主动调用。4.2 起 LRU 索引和上限本身搬到了 `Store` 上（`eviction: { vfs: { … } }`）；`vfs.maxAge` / `maxFiles` / `maxBytes` 既设置这份策略，也在每次清扫时传入，所以就算你自己建了 `Store`，它们照样生效。后端没有 `list()` / `delete()` 就没法清扫：`cleanup()` 会抛 `VFSCleanupNotSupportedError`（两个内置后端都实现了）。

> **生产实践** —— 见 [`docs/vfs-lifecycle-recipes.zh-CN.md`](./docs/vfs-lifecycle-recipes.zh-CN.md) 获取可运行的 recipe：长跑 server 定时清理、Serverless 冷启动 `reconcile()`、AI SDK middleware 接法、自定义 storage adapter（Redis 示例）、驱逐策略选择。

#### 召回 —— 把归档片段读回来

开了 `overflow.archive`（或 VFS 卸载）之后，摘要背后的完整片段始终可以按 URI 取回：

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({ role: "tool", tool_call_id: call.id, content: content ?? "[not found]" });
}
```

`resolveRecall(uri, { format: 'text' })` 把存储的消息片段渲染成可读文本，而不是原始 JSON。在 `tools: 'unified'` 下这就是 `context` 工具的 `view`，由 `chef.handleTool` 分发 —— `getRecallToolDefinition()` 留给 legacy 接法。

#### `context` 工具（4.2）

`ChefConfig.tools` 决定 `compile()` 发出哪一套库自带的工具：

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend(".context_store"),
  memory: {},
  tools: "unified",                            // 默认是 'legacy'
  contextTool: { writable: ["memory", "notes"] },  // 默认策略
  overflow: { handoff: { budgetTokens: 2_000 } },
});
```

- `'legacy'`（默认）：Memory 模块的 `create_memory` / `modify_memory`。`recall_context` 和 `new_context` 保持可选，自己注册。
- `'unified'`：一个覆盖所有命名空间的 `context` 工具；配了 `overflow.handoff` 时再加上 `new_context`。legacy 三件套不再发出；两套工具永远不会同时出现在一个 payload 里。

**默认值不可能在小版本里翻转。** 工具名就是你 agent loop 里的分发 key —— payload 一旦开始说 `context`，`if (call.function.name === 'create_memory')` 这一支立刻失配。5.0 起默认切到 `'unified'`。

这个工具是 `memory_20250818` 形状的：一份静态、冻结、引用稳定的定义，整份 schema 里只有一个枚举（`command`），因此没有任何实时 key 列表会进入可缓存前缀。七个命令，按 `context://<ns>/<path>` 寻址（前缀可省，所以 `notes/plan.md` 也行）：

| 命令 | 作用 | 说明 |
|---|---|---|
| `view` | 读一个条目，或列出一个命名空间/目录 | `notes/` 带行号；`vfs/` 和 `archive/` 走召回渲染 |
| `create` | 写入一个新条目 | 已存在则失败 |
| `str_replace` | 替换 `old_str` 的唯一一次出现 | 匹配不到或有歧义时返回模型能读的错误 |
| `insert` | 把 `insert_text` 插到 0 基行号 `insert_line` | |
| `delete` | 删除一个条目 | |
| `rename` | 在同一命名空间内移动到 `new_path` | 实现为 create + delete |
| `search` | 在 `path` 之下找匹配 `query` 的条目 | 后端没有原生 `search` 时回退到 list + get |

`memory/` 的所有操作都走 Memory 模块，因此 `allowedKeys`、`onMemoryUpdate` 否决、`onMemoryChanged`、TTL 和更新计数与 legacy 工具下完全一致地生效。`notes/` 直接落到 store。`vfs/` 和 `archive/` 默认只读。

##### 一个分发入口 —— `chef.ownsTool` / `chef.handleTool`

```typescript
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,   // JSON 字符串或已解析的对象都接受
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
    continue;
  }
  await executeYourOwnTool(call);
}
```

`ownsTool` 覆盖 `context`、`new_context` **以及** legacy 的 `create_memory` / `modify_memory` / `recall_context`，与 `tools` 模式无关 —— 模式决定 `compile()` 发出什么，而不是分发器听得懂什么，所以迁移期间模型偶尔喊回老名字也照样能工作。模型侧的错误永不抛异常：未知路径、缺参数、往只读命名空间写、被 `onMemoryUpdate` 否决，都会以 `Error: …` 文本返回，让模型自己读了改。只有传进一个本 chef 不拥有的工具名才会抛 —— 那是路由 bug，用 `ownsTool` 先挡一道。

##### 写入策略 —— `contextTool.writable`

读永不受限：存储里的一切本来就是这段对话自己的溢出，能把 `context://` URI 递给模型，就能把 URI 背后的内容递给它。写才受限：

```typescript
new ContextChef({ contextTool: { writable: ["notes"] } });                  // memory 只读
new ContextChef({ contextTool: { writable: ["memory", "notes", "vfs"] } }); // 允许改卸载的输出
```

策略在分发器里执行，不在 store 里 —— store 只搬字节，你自己的代码想写哪个命名空间都可以。

##### 一套词汇

`tools` 同时决定模型读到的措辞。在 `'unified'` 下，memory 使用说明与 memory 块、卸载截断标记、摘要包装（此时会带上 `Context window: … (previous: …)` 的谱系行）以及默认交接通知，全部改写为 `context://` 寻址并指名 `context` 工具 —— 于是 prompt 里永远不会提到 payload 里没有的工具。在 `'legacy'` 下，这些字符串与 4.1 逐字节一致。两套词汇是 `LEGACY_VOCABULARY` / `UNIFIED_VOCABULARY`，每个 chef 只解析一次；不经 chef 单独构造的 `Memory` / `Offloader` / `Janitor` 保持 4.x 措辞。

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

#### Skill 位置 —— `skillPlacement`（4.1）

控制激活的 skill instructions 投递到哪里。默认 `'after_system'` 就是上面这套行为，逐字节兼容：紧跟 system prompt 的一条独立 `role: 'system'` 消息。这些 token 位于可缓存前缀里——重发不要钱——但每一次激活、切换、停用都会改写前缀，代价是一次完整的缓存失效。

改成 `'tail'` 后，instructions 彻底离开前缀，改为领衔 tail 拼接段，用 `<skill_instructions skill="NAME">` 包裹：

```typescript
const chef = new ContextChef({ skillPlacement: "tail" });
chef.registerSkills([planning, editing]); // two Skill objects, shaped like the one above
chef.setSystemPrompt([{ role: "system", content: basePrompt }]).setHistory(history);

chef.activateSkill("planning");
const a = await chef.compile({ target: "anthropic" });
chef.activateSkill("editing");
const b = await chef.compile({ target: "anthropic" });

// `a` 和 `b` 在最后一条 user message 之前逐字节相同——激活、切换、停用都不碰
// 缓存前缀，变的只有 tail：
//   <skill_instructions skill="editing">…</skill_instructions>
```

两个方向的代价都是真实的：`'tail'` 会在**每一次请求**里不走缓存地重发完整 instructions；`'after_system'` 什么都不用重发，但**每次切换**都要吃一次缓存 miss。切换模式的频率相对于每个模式的存活时长更高，就选 `'tail'`；一次设定、整个会话都不换的模式，留在默认值。

位置只影响投递方式——`meta.activeSkillName`、`getActiveSkill()`、snapshot/restore 的行为完全不变。在 tail 里，skill 块位于固定拼接顺序的最前面（`<skill_instructions>` → `<memory>` → `<dynamic_state>` → `<implicit_context>` → `<announcements>` → anchor），让模型先读"你现在是谁"，再读它要作用的状态；它**不会**单独触发 anchor 那行文案——它在自己的标签里已经自说明了。如果 `cacheAudit` 在你最后一个 `cache_control` 断点处或之前抓到 `<skill_instructions` 块，说明断点放晚了，不是 placement 的问题。

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

// 扫描目录：每个 subdir/SKILL.md 变成一个 Skill。容错——坏文件进 `errors`，
// `warnings`（4.1）报告机械性质量问题（描述过短、instructions 过长、
// allowedTools 畸形、悬空的相对资源链接），但绝不阻断加载。
const { skills, errors, warnings } = await loadSkillsDir("./skills");
for (const w of warnings) console.warn(`${w.path}: ${w.message}`);
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

listing 让 LLM 通过 `load_skill` tool 自己挑 skill。tool 定义要保持**静态**——listing 放进 system prompt 而不是 tool description，`skill_name` 用普通 string 而不是注册名的 enum。tool schema 位于所有 provider prompt 前缀的最顶端，带 listing 的 description 或 live-name enum 会在 skill 集合变化时改写 schema、让整个 prompt cache 失效（与 4.1 的 memory 工具静态 schema 同一套推理）。未知名字改在 dispatch 时拦截——`activateSkill` 会抛错并列出可用名字：

```typescript
const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill to specialize for the current task. " +
    "The available skills are listed in the system prompt.",
  parameters: {
    skill_name: { type: "string", description: "A skill name from the listing." },
  },
};

// listing 放在（稳定的）system prompt 里：
chef.setSystemPrompt([
  { role: "system", content: `${basePrompt}\n\nAvailable skills:\n${listing}` },
]);

// dispatch 循环 —— dispatch-gate，与 memory 工具同一姿势：
if (call.name === "load_skill") {
  try {
    chef.activateSkill(call.args.skill_name);
    /* push 成功的 tool result，继续循环 */
  } catch (err) {
    /* 把 String(err) 作为 tool result 推回 —— 模型会自我纠正 */
  }
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

### Announcements（4.1）

会话中途能力会变：权限被授予、toolkit 被加载、限流把 `web_search` 撤下。payload 的形状变了，却没有任何东西告诉模型*到底变了什么*——于是它继续调用已经消失的工具，或者对刚上线的工具视而不见。`announce()` 把这个变化说出来，并且一直说下去，直到你撤回。

```typescript
chef.announce("tools:added", "Tools newly available: read_file, grep");
chef.announce(
  "tools:removed",
  "web_search has been withdrawn; calls to it will be rejected",
);

chef.getAnnouncements();
// [{ id: 'tools:added', content: '…', channel: 'auto' }, { id: 'tools:removed', … }]

chef.retractAnnouncement("tools:added"); // → true；下一次 compile 不留任何痕迹
```

所有常驻 announcement 渲染进同一个块，按插入顺序排列：

```xml
<announcements>
<announcement id="tools:added">
Tools newly available: read_file, grep
</announcement>

<announcement id="tools:removed">
web_search has been withdrawn; calls to it will be rejected
</announcement>
</announcements>
```

**它是状态，不是事件。** announcement 陈述的是*当前*能力集合，每次 `compile()` 都会重新渲染——而不是往 history 里追加一条一次性消息。这正是关键：chef 的注入从不写进你的 history，所以撤回之后它会从后续 payload 里彻底消失，而不是变成一条过期的对话轮次让模型反复重读。`announce()` 按 `id` upsert——用同一个 id 重新声明会替换内容和 channel，但保留原来的插入位置，所以更新内容时整个块保持稳定。`retractAnnouncement(id)` 返回是否真的删掉了东西。

#### 三个 channel

| Channel | 渲染位置 | 说明 |
|---|---|---|
| `'user_tail'` | 并入最后一条 user message 的 tail 拼接段——在 `<dynamic_state>` / `<implicit_context>` 之后，anchor 那行之前 | 所有 provider 都能用。与 skill instructions、memory data 不同，announcement **会**触发 "Above is the current system state" 那行 anchor——它本来就是系统状态 |
| `'system'` | 合并成一条 `_positional` system message，放在对话尾部之后（仍然排在任何 assistant prefill 之前） | 具备 operator 优先级，且缓存前缀完好无损 |
| `'auto'`（默认） | 按 **target** 路由：Anthropic target 走 `'system'`，其余一律 `'user_tail'` | 见下面的坑 |

channel 是逐条设置的，所以混合设置的一组 announcement 会在同一次 compile 里分走两条投递路径。[交接通知](#交接预算42)走的是同一套 channel 解析 —— 渲染在最后，只属于那一次 compile，永远不会进入常驻集合。

**auto 路由的坑。** `'auto'` 按 *target* 路由，不按模型——chef 根本看不到你的 model id。对话中途的 `role: "system"` 消息在 Fable 5 / Mythos 5 / Opus 4.8 / Opus 5 上是原生支持的，但 **Sonnet 5 不支持**。如果你编译到 Anthropic target 而实际调用 Sonnet 5，必须显式指定 channel：

```typescript
chef.announce("tools:added", "Tools newly available: grep", { channel: "user_tail" });
```

机制而非策略——chef 不会替你猜模型。

`'system'` channel 依托 `Message._positional`：被标记为 positional 的 `role: 'system'` 消息会*留在它所在的位置*，而不是被提升进 provider 的顶层 system 参数。各适配器的行为：Anthropic 发出一条对话中途的 system message（若它会排在所有 user/tool 消息之前，则降级为提升到顶层，并只警告一次）；OpenAI Chat Completions 本来就把 system 消息留在原地，该标记是 no-op；Responses 适配器把它作为内联 `message` item 发出，而不是折进 `instructions`；Gemini 的 `contents` 没有 system role，会原样降级成一条 `user` entry。

**措辞很重要。** 陈述事实，不要下命令。"Tools newly available: read_file, grep" 和 "web_search has been withdrawn; calls to it will be rejected" 读起来是系统状态；"You must now use read_file" 读起来是一条和你的 system prompt 抢话语权的指令——模型会拿它去和你说过的所有话做权衡。

**生命周期。** announcement 能挺过 `clearHistory()`——它描述的是当前能力集合，新开的对话同样需要；变化不再成立时请显式撤回。它随 `ChefSnapshot` 一起走，`snapshot()` / `restore()` 可以完整往返；恢复 4.1 之前的快照（没有 `announcements` 字段）会得到一个空集合，而不是让上一批 announcement 继续生效。开启 `cacheAudit: true` 后，若 `<announcements>` 块出现在最后一个 `cache_control` 断点处或之前，会被标记出来——announcement 永远渲染在对话尾部，所以要把断点往前挪。

#### 自己检测 delta

chef 不做任何自动的工具 delta 检测。它只渲染你声明的内容，判断*到底变了什么*属于策略，留在你的 loop 里：

```typescript
let previousTools = new Set<string>();

function syncToolAnnouncements(next: string[]) {
  const added = next.filter((name) => !previousTools.has(name));
  const removed = [...previousTools].filter((name) => !next.includes(name));

  if (added.length) {
    chef.announce("tools:added", `Tools newly available: ${added.join(", ")}`);
  } else {
    chef.retractAnnouncement("tools:added"); // 已经不"新"了——别再重复
  }

  if (removed.length) {
    chef.announce(
      "tools:removed",
      `Withdrawn; calls to these will be rejected: ${removed.join(", ")}`,
    );
  } else {
    chef.retractAnnouncement("tools:removed");
  }

  previousTools = new Set(next);
}

// 和 Pruner blocklist 天然配套——闸门负责拒绝，announcement 负责解释：
chef.getPruner().setBlockedTools(["delete_file"]);
chef.announce("tools:blocked", "delete_file is disabled in this environment");
```

在你决定工具列表的地方调用它：构造请求之前，或者当工具集合由 Pruner 掌管时（`payload.tools`）放在 `compile:done` 处理器里——注意此时声明的 announcement 落在*下一次* compile，而不是刚刚完成的这次。

相关：`ToolDefinition.deferLoading` 用来标注一个工具不进入初始上下文（Anthropic 的 tool search，以及 `mid-conversation-tool-changes` beta 里的 `tool_addition` 机制）；deferred 定义会在计算 cache key 之前被剥离，所以新增它们永远不会让已有的缓存条目失效。announcement 是它在文本侧的对应物——chef 的 IR 以文本内容为基础，因此 `tool_addition` / `tool_removal` 内容块不做透传。

---

### Snapshot & Restore

捕获和回滚全部上下文状态，用于分支探索或错误恢复。

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

---

### 管道插槽（4.2）

`compile()` 是一串有名字的阶段 —— `start` → `transform-tool-results` → `handoff` → `overflow` → `inject` → `memory` → `skill` → `assemble` → `tail` → `adapt` → `audit` → `done`。插槽就是在这些阶段边界上触发的组合点。和事件不同，插槽 handler **参与**编译：它可以否决溢出、注入上下文、改写已装配的消息。

```typescript
chef
  .use("before-assemble", async (ctx) => ctx.inject(await vectorDB.search(ctx.dynamicStateXml)))
  .use("after-adapt", (payload) => metrics.record(payload));

chef.unuse("after-adapt", handler); // 移除一次注册
```

| 插槽 | 签名 | 契约 |
|---|---|---|
| `before-overflow` | `({ history, budget }) => void \| false` | 返回 `false` 即跳过本次 compile 的 overflow 阶段。`budget` 是 runner 的真实读数：`{ limit, current, trigger, remaining }` |
| `after-overflow` | `({ history, result }) => void` | 阶段被跳过时 `result` 为 `null`；否则是带 `meta.strategy` / `meta.changed` / `meta.windowId` 的 `OverflowResult` |
| `before-assemble` | `(ctx) => void` | `ctx` 是 `BeforeCompileContext` 外加 `inject(text)`；注入的块按注册顺序累积进 `<implicit_context>` |
| `after-assemble` | `(messages) => Message[]` | handler 串联 —— 每个拿到上一个的结果 |
| `before-adapt` | `(messages) => void` | target adapter 运行前，对最终消息数组的只读观察 |
| `after-adapt` | `(payload) => void` | `compile:done` 之前，对编译产物的只读观察 |

handler 按**注册顺序**依次 await 执行。旧的 config 钩子在构造时注册到同一个注册表上，所以它们总是最先跑 —— 不存在第二条代码路径：

| 已废弃字段 | 注册为 |
|---|---|
| `ChefConfig.onBeforeCompile` | `before-assemble`（返回的字符串等价于 `ctx.inject(...)`） |
| `ChefConfig.transformContext` | `after-assemble` |

两者行为不变，5.0 移除。`ChefConfig.transformToolResult` **没有**被废弃：它是 `transform-tool-results` 阶段的逐条变换（在压缩之前作用于每条 `role: 'tool'` 消息），不是插槽。`JanitorConfig.onBeforeCompress` 同样没有被废弃：它是 runner 上的回调，在预算判定认为要执行溢出之后于 Janitor 内部触发，可以返回替换后的历史，并且在没有插槽注册表的独立 `Janitor` 上照样能用。

插槽的错误**不做隔离** —— 和事件 handler 不同，抛出的插槽 handler 会让整次 compile 失败，这与它所泛化的那些 config 钩子完全一致。希望失败可存活就自己包 try/catch。

```typescript
// 用插槽写出 4.1 的那些钩子
chef.use("before-overflow", ({ history, budget }) => {
  if (history.length < 4) return false;              // 短对话永不压缩
  console.log(`over budget by ${-budget.remaining} tokens`);
});

chef.use("after-overflow", ({ result }) => {
  if (result?.meta.changed) store.recordWindowBoundary(result.meta.windowId);
});
```

#### 开发期不变量 —— `pipelineChecks`

`ChefConfig.pipelineChecks: true` 会在整条 `after-assemble` 链跑完之后校验一次 pinned 消息是否还在、tool call/result 是否仍然配对，并在 tail 阶段之后校验一次插入点之前的内容有没有被改动。装配那次检查比对的是链的输入和链的输出，所以违规报的是整条链，不是某一个 handler。

```typescript
const chef = new ContextChef({ pipelineChecks: true });
chef.on("pipeline:invariant", ({ phase, message }) => console.warn(`[${phase}] ${message}`));
```

违规只**上报，绝不拦截**：每一条都会送到 `ChefConfig.logger`（或 `console`）和 `pipeline:invariant` 事件，`compile()` 绝不会因为一次检查而抛出。它每次 compile 要付一次快照加一次序列化的代价，生产环境请关掉。默认 `false`。

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
| `pipeline:invariant` | `{ phase, message }` | `pipelineChecks` 不变量被破坏 —— pinned 消息被丢、tool 配对被拆、tail 插入点之前的内容被改写。仅上报 |
| `memory:changed` | `{ type, key, value, oldValue }` | 任何记忆变更（set、delete、expire）后触发 |
| `memory:expired` | `MemoryEntry` | `compile()` 期间记忆条目过期时触发 |

事件是**纯观察型**的，不影响控制流。凡是参与编译的都是[插槽](#管道插槽42)（`chef.use(...)`，以及 `onBeforeCompile` / `transformContext` 这两个别名）；`onBeforeCompress` 和 `onMemoryUpdate` 仍然是各自模块上的 config 回调。

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
    // compile was cancelled mid-flight (overflow / inject / memory / assemble boundary)
  }
  throw err;
}
```

两个作用：

1. **透传给 handler** —— `chef.on(event, (payload, signal?) => ...)` 第二个参数即 signal。handler 可把它转给 `fetch`、DB 客户端或任何支持协作取消的 API。
2. **compile() 阶段边界检查** —— `overflow`、`inject`、`memory`、`assemble` 四个阶段之后各检查一次（和 4.2 之前是同一批位置：Janitor 压缩、`before-assemble` / `onBeforeCompile`、memory、`after-assemble` / `transformContext`）；命中即通过 `signal.throwIfAborted()` 抛出。

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

如果 memory 需要跨请求共享，把 store 单独提取（共享一个 `FileSystemBackend`，或你自己包的 Redis-backed `StorageBackend`）作为 `store` 传给每请求的 chef —— store 层并发由 store 自己负责，不是 chef 的事。

**同一个 chef 实例上并发 `compile()` 是单线程语义。** 同实例两次 compile 会互相覆盖 `_currentSignal`、双进 memory 轮次、交错读取 skill/history。请按实例串行（`await chef.compile()` 链式），或用上面的 per-request 模式。Snapshot+serialize 防御性方案在 roadmap 里（TODO T2.4.1，低优先级），但 canonical 用法不需要它。

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
