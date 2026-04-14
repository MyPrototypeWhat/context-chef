# ContextChef

[![npm version](https://img.shields.io/npm/v/context-chef.svg)](https://www.npmjs.com/package/context-chef)
[![npm downloads](https://img.shields.io/npm/dm/context-chef.svg)](https://www.npmjs.com/package/context-chef)
[![GitHub stars](https://img.shields.io/github/stars/MyPrototypeWhat/context-chef)](https://github.com/MyPrototypeWhat/context-chef)
[![License](https://img.shields.io/npm/l/context-chef.svg)](https://github.com/MyPrototypeWhat/context-chef/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/context-chef/actions/workflows/ci.yml)

<p align="center">
  <img src="./ContextChef.gif" alt="ContextChef Demo" width="600" />
</p>

TypeScript/JavaScript AI Agent 的上下文编译器。

ContextChef 解决 AI Agent 开发中最常见的上下文工程问题：对话太长模型会忘事、工具太多模型会幻觉、切换模型要重写 prompt、长程任务状态丢失。它不接管你的控制流，只负责在每次 LLM 调用前把你的状态编译成最优的 payload。

[English](./README.md)

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

- **对话太长？** — 自动压缩历史消息，保留近期记忆，老对话交给小模型摘要，不丢关键信息
- **工具太多？** — 按任务动态裁剪工具列表，或用双层架构（稳定分组 + 按需加载）彻底消除工具幻觉
- **换模型要重写？** — 同一套 prompt 编译到 OpenAI / Anthropic / Gemini，prefill、cache、tool call 格式自动适配
- **长程任务跑偏？** — Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点
- **终端输出太大？** — 自动截断大文本并存储到 VFS，保留错误信息 + URI 指针供模型按需读取
- **跨会话记不住？** — Memory 让模型通过 tool call 主动持久化关键信息（项目规范、用户偏好），下次会话自动注入
- **想回滚怎么办？** — Snapshot & Restore 一键捕获和回滚全部上下文状态，支持分支探索
- **需要外部上下文？** — `onBeforeCompile` 钩子让你在编译前注入 RAG 检索结果、AST 片段等
- **需要可观测性？** — 统一事件系统（`chef.on('compress', ...)`）一个入口订阅所有内部模块的日志、指标和调试信息

## 安装

```bash
npm install context-chef zod
```

## 快速开始

```typescript
import { ContextChef } from "context-chef";
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

### `new ContextChef(config?)`

```typescript
const chef = new ContextChef({
  vfs?: { threshold?: number, storageDir?: string },
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
// placement 默认为 'last_user'（注入到最后一条 user 消息中）
// 使用 { placement: 'system' } 作为独立的 system 消息
```

#### `chef.withGuardrails(options): this`

应用输出格式护栏和可选的 prefill。

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // 将输出规则包裹在 EPHEMERAL_MESSAGE 中
  prefill: "<thinking>\n1.", // 尾部 assistant 消息（OpenAI/Gemini 自动降级）
});
```

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
    preserveRatio: 0.8, // 保留 80% 的 contextWindow 给近期消息（默认值）
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count) => {
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
    preserveRecentMessages: 1,       // 压缩时保留最后 1 条消息（默认值）
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

// 每次 LLM 调用后：
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

> **注意：** 如果没有提供 `compressionModel`，旧消息将被直接丢弃而不生成摘要。如果同时没有 `tokenizer` 和 `compressionModel`，构造时会打印控制台警告。

#### `JanitorConfig`

| 选项                            | 类型                                        | 默认值 | 说明                                                                 |
| ------------------------------- | ------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `contextWindow`                 | `number`                                    | _必填_ | 模型的上下文窗口大小（token 数）。token 用量超过此值时触发压缩。     |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —      | 启用 tokenizer 路径，精确计算每条消息的 token 数。                   |
| `preserveRatio`                 | `number`                                    | `0.8`  | [Tokenizer 路径] `contextWindow` 中保留给近期消息的比例。            |
| `preserveRecentMessages`        | `number`                                    | `1`    | [reportTokenUsage 路径] 压缩时保留的近期轮次数量（turn-based）。     |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —      | 异步钩子，调用低成本 LLM 对旧消息进行摘要。                          |
| `customCompressionInstructions` | `string`                                    | —      | 追加到默认压缩 prompt 的额外聚焦指令（追加模式，不替换）。           |
| `onCompress`                    | `(summary, count) => void`                  | —      | 压缩完成后触发，传入摘要消息和被截断的消息数量。                     |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —      | LLM 压缩前触发。返回修改后的历史来干预，或返回 null 让默认压缩继续执行。 |

**压缩输出契约。** Janitor 默认 prompt 要求压缩模型输出两阶段响应：先在 `<analysis></analysis>` 里写草稿推理（会被剥除），再在 `<summary></summary>` 里输出 5 个领域无关的结构化章节（Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve）。Janitor 会自动用 `Prompts.formatCompactSummary` 清洗压缩模型返回值。详见 [core 包 README](./packages/core)。

**熔断器。** 如果 `compressionModel` 连续 3 次失败，`compress()` 将直接返回原始历史（不再调用压缩模型），直到下一次成功或显式调用 `janitor.reset()` / `chef.clearHistory()`。失败计数由 `chef.snapshot()` / `chef.restore()` 保存。

#### `chef.reportTokenUsage(tokenCount): this`

传入 API 返回的 token 用量。下次 `compile()` 时，如果该值超过 `contextWindow`，则触发压缩。在 tokenizer 路径中，取本地计算值和传入值中的较大值。

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
      // 示例：压缩前将大型工具结果卸载到 VFS
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
// 清除所有 tool result 和 thinking 块
history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

// 保留最近 5 个 tool result，清除其余（最少保留 1 个）
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// 组合：清除旧 tool result + 所有 thinking
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }, 'thinking'],
});
```

#### `ensureValidHistory(history)`

独立工具函数，修复消息历史以满足 LLM API 约束（tool 配对完整性、消息交替规则）。适用于从数据库加载历史或手动修改后的场景。

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

#### `chef.clearHistory(): this`

切换话题或完成子任务时显式清空历史并重置 Janitor 状态。

---

### 大文本卸载 (Offloader / VFS)

```typescript
// 超过阈值时截断并卸载，默认保留最后 20 行
const safeLog = chef.offload(rawTerminalOutput);
history.push({ role: "tool", content: safeLog, tool_call_id: "call_123" });
// safeLog: 内容较小时原样返回，否则截断并附带 context://vfs/ URI

// 自定义保留的尾部行数（0 = 不保留尾部，适合静态文档）
const safeDoc = chef.offload(largeFileContent, { tailLines: 0 });

// 单次调用覆盖阈值
const safeOutput = chef.offload(content, { threshold: 2000, tailLines: 50 });
```

注册一个工具让 LLM 按需读取完整内容：

```typescript
// 在你的工具处理函数中:
import { Offloader } from "context-chef";
const offloader = new Offloader({ storageDir: ".context_vfs" });
const fullContent = offloader.resolve(uri);
```

---

### 工具管理 (Pruner)

#### 扁平模式

```typescript
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "run_bash", description: "Run a command", tags: ["shell"] },
  { name: "get_time", description: "Get timestamp" /* 无 tags = 始终保留 */ },
]);

const { tools, removed } = chef.getPruner().pruneByTask("Read the auth.ts file");
// tools: [read_file, get_time]
```

也支持 `allowOnly(names)` 和 `pruneByTaskAndAllowlist(task, names)`。

#### Namespace + Lazy Loading（双层架构）

**Layer 1 — Namespace**：核心工具分组为稳定的工具定义。工具列表在多轮对话中永不变化。

**Layer 2 — Lazy Loading**：长尾工具注册为轻量 XML 目录。LLM 通过 `load_toolkit` 按需加载完整 schema。

```typescript
// Layer 1: 稳定的 Namespace 工具
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

// Layer 2: 按需加载的工具包
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

// 编译 — tools: [file_ops, terminal, load_toolkit]（始终稳定）
const { tools, directoryXml } = chef.getPruner().compile();
// directoryXml: 注入系统提示词，让 LLM 知道可用的工具包
```

**Agent Loop 集成：**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.getPruner().isNamespaceCall(toolCall)) {
    // 路由 Namespace 调用到真实工具
    const { toolName, args } = chef.getPruner().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.getPruner().isToolkitLoader(toolCall)) {
    // LLM 请求加载工具包 — 展开并重新调用
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.getPruner().extractToolkit(parsed.toolkit_name);
    // 合并 newTools 到下一次 LLM 请求
  }
}
```

---

### Memory

跨会话持久化的键值记忆。记忆通过 tool call（`create_memory` / `modify_memory`）修改，`compile()` 时自动注入到 payload 中。

```typescript
import { InMemoryStore, VFSMemoryStore } from "context-chef";

const chef = new ContextChef({
  memory: {
    store: new InMemoryStore(), // 临时存储（测试）
    // store: new VFSMemoryStore(dir),   // 持久化存储（生产）
  },
});

// 在 agent loop 中拦截 memory tool call：
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

// 直接读写（开发者使用，跳过验证钩子）
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "Agent 的角色和人设",
});
const value = await chef.getMemory().get("persona");

// compile() 时：
// - Memory tools（create_memory、modify_memory）自动注入到 payload.tools
// - 已有记忆作为 <memory> XML 注入到 systemPrompt 和 history 之间
```

---

### Snapshot & Restore

捕获和回滚全部上下文状态，用于分支探索或错误恢复。

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent 执行工具，出了问题 ...

chef.restore(snap); // 回滚所有状态：历史、动态状态、janitor 状态、记忆
```

---

### 生命周期事件

统一的事件系统，一个入口观测所有内部模块。通过 `chef.on()` 订阅，`chef.off()` 取消订阅。

```typescript
// 历史压缩时记录日志
chef.on('compress', ({ summary, truncatedCount }) => {
  console.log(`压缩了 ${truncatedCount} 条消息`);
});

// 跟踪编译指标
chef.on('compile:done', ({ payload }) => {
  metrics.track('compile', { messageCount: payload.messages.length });
});

// 监控记忆变化
chef.on('memory:changed', ({ type, key, value }) => {
  console.log(`Memory ${type}: ${key}`);
});
```

#### 可用事件

| 事件 | Payload | 说明 |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | `compile()` 开始时触发 |
| `compile:done` | `{ payload }` | `compile()` 生成最终 payload 后触发 |
| `compress` | `{ summary, truncatedCount }` | Janitor 压缩历史后触发 |
| `memory:changed` | `{ type, key, value, oldValue }` | 任何记忆变更（set、delete、expire）后触发 |
| `memory:expired` | `MemoryEntry` | `compile()` 期间记忆条目过期时触发 |

事件是**纯观察型**的，不影响控制流。拦截型钩子（`onBeforeCompress`、`onMemoryUpdate`、`onBeforeCompile`、`transformContext`）仍然通过 config 回调配置。

事件与现有 config 回调共存：如果在 `JanitorConfig` 中配置了 `onCompress`，它会先触发，然后再 emit `compress` 事件。

---

### `onBeforeCompile` 钩子

在编译前注入外部上下文（RAG、AST 片段、MCP 查询），无需修改消息数组。

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.dynamicStateXml);
    return snippets.map((s) => s.content).join("\n");
    // 作为 <implicit_context>...</implicit_context> 注入到 dynamic state 同一位置
    // 返回 null 跳过注入
  },
});
```

---

### Input Adapters（Provider → IR）

将 OpenAI / Anthropic / Gemini 原生消息转换为 ContextChef IR，自动分离 system 和 history：

```typescript
import { fromOpenAI, fromAnthropic, fromGemini } from "context-chef";

// OpenAI
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);

// Anthropic（system 是独立的 top-level 参数）
const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
chef.setSystemPrompt(system).setHistory(history);

// Gemini（systemInstruction 是独立的 top-level 参数）
const { system, history } = fromGemini(geminiContents, systemInstruction);
chef.setSystemPrompt(system).setHistory(history);
```

多模态内容（图片、文件）自动转换为 IR `attachments` 字段：

| Provider 格式 | IR 字段 |
|---|---|
| OpenAI `image_url` / `file` | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document` | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` 时 `attachments` 自动转换回对应 provider 格式。压缩时 Janitor 会引导压缩模型描述图片内容。

---

### Target Adapters

| 特性                      | OpenAI                 | Anthropic                              | Gemini                               |
| ------------------------- | ---------------------- | -------------------------------------- | ------------------------------------ |
| 格式                      | Chat Completions       | Messages API                           | generateContent                      |
| 缓存断点                  | 忽略                   | `cache_control: { type: 'ephemeral' }` | 忽略（使用独立的 CachedContent API） |
| Prefill（尾部 assistant） | 降级为 `[System Note]` | 原生支持                               | 降级为 `[System Note]`               |
| `thinking` 字段           | 忽略                   | 映射为 `ThinkingBlockParam`            | 忽略                                 |
| 工具调用                  | `tool_calls` 数组      | `tool_use` blocks                      | `functionCall` parts                 |
| `attachments`             | `image_url` / `file` content parts | `image` / `document` blocks    | `inlineData` / `fileData` parts      |

适配器由 `compile({ target })` 自动选择。也可以独立使用：

```typescript
import { getAdapter } from "context-chef";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

---

## Skills

ContextChef 提供了 [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)，帮助你交互式地将库集成到项目中。每个 Skill 会分析你现有的代码，生成定制化的集成代码。

| Skill | 描述 |
|---|---|
| `context-chef-core` | 集成 `@context-chef/core` — 完全控制编译流程，多供应商支持 |
| `context-chef-middleware` | 集成 `@context-chef/ai-sdk-middleware` — AI SDK 即插即用中间件，零代码改动 |
| `context-chef-tanstack` | 集成 `@context-chef/tanstack-ai` — TanStack AI ChatMiddleware，带压缩和状态注入 |

### 安装 Skill

按需安装：

```bash
# 核心库（直接使用 OpenAI / Anthropic / Gemini SDK）
npx skills add MyPrototypeWhat/context-chef --skill context-chef-core

# AI SDK 中间件（Vercel AI SDK v6+）
npx skills add MyPrototypeWhat/context-chef --skill context-chef-middleware

# TanStack AI 中间件（TanStack AI v0.10+）
npx skills add MyPrototypeWhat/context-chef --skill context-chef-tanstack

# 全部安装
npx skills add MyPrototypeWhat/context-chef
```

### 使用

在项目中打开 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，输入：

```
/context-chef-core
# 或
/context-chef-middleware
# 或
/context-chef-tanstack
```

Claude 会：

1. **检测你的项目** — LLM SDK、包管理器、TypeScript 还是 JavaScript
2. **了解你的需求** — 历史压缩、工具管理、截断、记忆等
3. **生成集成代码** — 根据你的项目结构和现有 agent 循环定制
4. **解释核心架构** — 处理流程、缓存断点、动态状态注入位置
