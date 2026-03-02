# ContextChef

TypeScript/JavaScript AI Agent 的上下文编译器。

ContextChef 解决 AI Agent 开发中最常见的上下文工程问题：对话太长模型会忘事、工具太多模型会幻觉、切换模型要重写 prompt、长程任务状态丢失。它不接管你的控制流，只负责在每次 LLM 调用前把你的状态编译成最优的 payload。

[English](./README.md)

## Features

- **对话太长？** — 自动压缩历史消息，保留近期记忆，老对话交给小模型摘要，不丢关键信息
- **工具太多？** — 按任务动态裁剪工具列表，或用双层架构（稳定分组 + 按需加载）彻底消除工具幻觉
- **换模型要重写？** — 同一套 prompt 编译到 OpenAI / Anthropic / Gemini，prefill、cache、tool call 格式自动适配
- **长程任务跑偏？** — Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点
- **终端输出太大？** — 自动截断大文本并存储到 VFS，保留错误信息 + URI 指针供模型按需读取
- **跨会话记不住？** — Core Memory 让模型主动持久化关键信息（项目规范、用户偏好），下次会话自动注入
- **想回滚怎么办？** — Snapshot & Restore 一键捕获和回滚全部上下文状态，支持分支探索
- **需要外部上下文？** — `onBeforeCompile` 钩子让你在编译前注入 RAG 检索结果、AST 片段等

## 安装

```bash
npm install context-engineer zod
```

## 快速开始

```typescript
import { ContextChef } from 'context-engineer';
import { z } from 'zod';

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
  .setTopLayer([{ role: 'system', content: 'You are an expert coder.', _cache_breakpoint: true }])
  .useRollingHistory(conversationHistory)
  .setDynamicState(TaskSchema, { activeFile: 'auth.ts', todo: ['Fix login bug'] })
  .withGovernance({ enforceXML: { outputTag: 'response' }, prefill: '<thinking>\n1.' })
  .compile({ target: 'anthropic' });

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
  memoryStore?: MemoryStore,
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>,
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>,
});
```

### 上下文构建

#### `chef.setTopLayer(messages): this`

设置静态系统提示词层。作为缓存前缀，应尽量少变。

```typescript
chef.setTopLayer([
  { role: 'system', content: 'You are an expert coder.', _cache_breakpoint: true },
]);
```

`_cache_breakpoint: true` 会让 Anthropic 适配器注入 `cache_control: { type: 'ephemeral' }`。

#### `chef.useRollingHistory(messages): this`

设置对话历史。Janitor 在 `compile()` 时自动压缩。

#### `chef.setDynamicState(schema, data, options?): this`

将 Zod 校验后的状态以 XML 注入上下文。

```typescript
const TaskSchema = z.object({ activeFile: z.string(), todo: z.array(z.string()) });

chef.setDynamicState(TaskSchema, { activeFile: 'auth.ts', todo: ['Fix bug'] });
// placement 默认为 'last_user'（注入到最后一条 user 消息中）
// 使用 { placement: 'system' } 作为独立的 system 消息
```

#### `chef.withGovernance(options): this`

应用输出格式护栏和可选的 prefill。

```typescript
chef.withGovernance({
  enforceXML: { outputTag: 'final_code' }, // 将输出规则包裹在 EPHEMERAL_MESSAGE 中
  prefill: '<thinking>\n1.',               // 尾部 assistant 消息（OpenAI/Gemini 自动降级）
});
```

#### `chef.compile(options?): Promise<TargetPayload>`

将所有内容编译为 provider 就绪的 payload。触发 Janitor 压缩。注册的工具自动包含。

```typescript
const payload = await chef.compile({ target: 'openai' });    // OpenAIPayload
const payload = await chef.compile({ target: 'anthropic' }); // AnthropicPayload
const payload = await chef.compile({ target: 'gemini' });    // GeminiPayload
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
    tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8,              // 保留 80% 的 contextWindow 给近期消息（默认值）
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count) => {
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

#### 路径 2：feedTokenUsage（简单，无需 tokenizer）

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
chef.feedTokenUsage(response.usage.prompt_tokens);
```

> **注意：** 如果没有提供 `compressionModel`，旧消息将被直接丢弃而不生成摘要。如果同时没有 `tokenizer` 和 `compressionModel`，构造时会打印控制台警告。

#### `JanitorConfig`

| 选项 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| `contextWindow` | `number` | *必填* | 模型的上下文窗口大小（token 数）。token 用量超过此值时触发压缩。 |
| `tokenizer` | `(msgs: Message[]) => number` | — | 启用 tokenizer 路径，精确计算每条消息的 token 数。 |
| `preserveRatio` | `number` | `0.8` | [Tokenizer 路径] `contextWindow` 中保留给近期消息的比例。 |
| `preserveRecentMessages` | `number` | `1` | [feedTokenUsage 路径] 压缩时保留的近期消息数量。 |
| `compressionModel` | `(msgs: Message[]) => Promise<string>` | — | 异步钩子，调用低成本 LLM 对旧消息进行摘要。 |
| `onCompress` | `(summary, count) => void` | — | 压缩完成后触发，传入摘要消息和被截断的消息数量。 |
| `onBudgetExceeded` | `(history, tokenInfo) => Message[] \| null` | — | 压缩前触发。返回修改后的历史来干预，或返回 null 让默认压缩继续执行。 |

#### `chef.feedTokenUsage(tokenCount): this`

传入 API 返回的 token 用量。下次 `compile()` 时，如果该值超过 `contextWindow`，则触发压缩。在 tokenizer 路径中，取本地计算值和传入值中的较大值。

```typescript
const response = await openai.chat.completions.create({ ... });
chef.feedTokenUsage(response.usage.prompt_tokens);
```

#### `onBudgetExceeded` 钩子

当 token 预算超标时，在自动压缩**之前**触发。返回修改后的 `Message[]` 替换历史（例如将工具结果卸载到 VFS），或返回 `null` 让默认压缩继续执行。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBudgetExceeded: (history, { currentTokens, limit }) => {
      // 示例：压缩前将大型工具结果卸载到 VFS
      return history.map(msg =>
        msg.role === 'tool' && msg.content.length > 5000
          ? { ...msg, content: pointer.process(msg.content, 'log').content }
          : msg
      );
    },
  },
});
```

#### `chef.clearRollingHistory(): this`

切换话题或完成子任务时显式清空历史并重置 Janitor 状态。

---

### 大文本卸载 (Pointer / VFS)

```typescript
// 超过阈值时截断并卸载
const safeLog = chef.processLargeOutput(rawTerminalOutput, 'log');
history.push({ role: 'tool', content: safeLog, tool_call_id: 'call_123' });
// safeLog: 内容较小时原样返回，否则截断并附带 context://vfs/ URI
```

注册一个工具让 LLM 按需读取完整内容：

```typescript
// 在你的工具处理函数中:
import { Pointer } from 'context-engineer';
const pointer = new Pointer({ storageDir: '.context_vfs' });
const fullContent = pointer.resolve(uri);
```

---

### 工具管理 (Pruner)

#### 扁平模式

```typescript
chef.registerTools([
  { name: 'read_file', description: 'Read a file', tags: ['file', 'read'] },
  { name: 'run_bash', description: 'Run a command', tags: ['shell'] },
  { name: 'get_time', description: 'Get timestamp' /* 无 tags = 始终保留 */ },
]);

const { tools, removed } = chef.tools().pruneByTask('Read the auth.ts file');
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
    name: 'file_ops',
    description: 'File system operations',
    tools: [
      { name: 'read_file', description: 'Read a file', parameters: { path: { type: 'string' } } },
      { name: 'write_file', description: 'Write to a file', parameters: { path: { type: 'string' }, content: { type: 'string' } } },
    ],
  },
  {
    name: 'terminal',
    description: 'Shell command execution',
    tools: [
      { name: 'run_bash', description: 'Execute a command', parameters: { command: { type: 'string' } } },
    ],
  },
]);

// Layer 2: 按需加载的工具包
chef.registerToolkits([
  { name: 'Weather', description: 'Weather forecast APIs', tools: [/* ... */] },
  { name: 'Database', description: 'SQL query and schema inspection', tools: [/* ... */] },
]);

// 编译 — tools: [file_ops, terminal, load_toolkit]（始终稳定）
const { tools, directoryXml } = chef.tools().compile();
// directoryXml: 注入系统提示词，让 LLM 知道可用的工具包
```

**Agent Loop 集成：**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.tools().isNamespaceCall(toolCall)) {
    // 路由 Namespace 调用到真实工具
    const { toolName, args } = chef.tools().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);

  } else if (chef.tools().isToolkitLoader(toolCall)) {
    // LLM 请求加载工具包 — 展开并重新调用
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.tools().extractToolkit(parsed.toolkit_name);
    // 合并 newTools 到下一次 LLM 请求
  }
}
```

---

### Core Memory

跨会话持久化的键值记忆。LLM 通过输出中的 XML 标签写入记忆。

```typescript
import { InMemoryStore, VFSMemoryStore } from 'context-engineer';

const chef = new ContextChef({
  memoryStore: new InMemoryStore(),          // 临时存储（测试）
  // memoryStore: new VFSMemoryStore(dir),   // 持久化存储（生产）
});

// 每次 LLM 响应后，提取并应用记忆更新
await chef.memory().extractAndApply(assistantResponse);
// 解析: <update_core_memory key="project_rules">Use TypeScript strict mode</update_core_memory>
// 解析: <delete_core_memory key="outdated_rule" />

// 直接读写
await chef.memory().set('persona', 'You are a senior engineer');
const value = await chef.memory().get('persona');

// 记忆在 compile() 时自动作为 <core_memory> XML 注入到 topLayer 和 history 之间
```

---

### Snapshot & Restore

捕获和回滚全部上下文状态，用于分支探索或错误恢复。

```typescript
const snap = chef.snapshot('before risky tool call');

// ... agent 执行工具，出了问题 ...

chef.restore(snap); // 回滚所有状态：历史、动态状态、janitor 状态、记忆
```

---

### `onBeforeCompile` 钩子

在编译前注入外部上下文（RAG、AST 片段、MCP 查询），无需修改消息数组。

```typescript
const chef = new ContextChef({
  onBeforeCompile: async (ctx) => {
    const snippets = await vectorDB.search(ctx.rawDynamicXml);
    return snippets.map(s => s.content).join('\n');
    // 作为 <implicit_context>...</implicit_context> 注入到 dynamic state 同一位置
    // 返回 null 跳过注入
  },
});
```

---

### Target Adapters

| 特性 | OpenAI | Anthropic | Gemini |
| ---- | ------ | --------- | ------ |
| 格式 | Chat Completions | Messages API | generateContent |
| 缓存断点 | 忽略 | `cache_control: { type: 'ephemeral' }` | 忽略（使用独立的 CachedContent API） |
| Prefill（尾部 assistant） | 降级为 `[System Note]` | 原生支持 | 降级为 `[System Note]` |
| `thinking` 字段 | 忽略 | 映射为 `ThinkingBlockParam` | 忽略 |
| 工具调用 | `tool_calls` 数组 | `tool_use` blocks | `functionCall` parts |

适配器由 `compile({ target })` 自动选择。也可以独立使用：

```typescript
import { getAdapter } from 'context-engineer';
const adapter = getAdapter('gemini');
const payload = adapter.compile(messages);
```
