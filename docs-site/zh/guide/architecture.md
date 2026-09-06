# 架构 <Badge type="tip" text="4.2" />

ContextChef 把无界的信息编译进有界的窗口。这个库现有的每一个特性 —— 以及之后会长出来的每一个特性 —— 都恰好落在五条轴之一上。本页是这张地图：每条轴一段话、一个指向对应章节的链接，以及五条轴共同穿过的编译管道。

| 轴 | 它回答的问题 | 归属 |
|---|---|---|
| **① 选择（Selection）** | 什么进入窗口 | [溢出策略](/zh/guide/history-compression)、[Pruner](/zh/guide/tool-management)、`memory.selector` |
| **② 位置（Placement）** | 它落在窗口的哪里 | Assembler 三明治、tail 通道、可缓存的稳定前缀 |
| **③ 持久化（Persistence）** | 它在窗口之外时住在哪 | 唯一的[上下文存储](/zh/guide/context-store) |
| **④ 取回（Retrieval）** | 模型如何伸手去窗口之外拿东西 | `context` 工具与 `new_context` |
| **⑤ 适配（Adaptation）** | provider 的线上格式要什么 | [适配器](/zh/guide/adapters) |

溢出（overflow）不是第六条轴。它是信息从 ① 移动到 ③、并通过 ④ 保持可达 —— 所以 `summarize` / `anchored` / `reset` 是选择策略，`memory` / `notes` / `vfs` / `archive` 是持久化命名空间，`view` / `search` 是取回句柄。

## ① 选择 —— 什么进入窗口

两份互相独立的预算：对话和工具列表。

历史由**溢出策略**限界。Janitor 是 runner —— 它读预算、判断触发线是否越过、维护熔断器、发出 `compress:*`；策略决定真正离开窗口的是什么：`summarize()`、`anchored()`、`server()`、`reset()`，以及用 `chain()` 和 `background()` 组合出来的形态。固定消息（`pinned: true`）是策略唯一不能动的东西。见[溢出](/zh/guide/history-compression)。

工具列表由 [Pruner](/zh/guide/tool-management) 限界：按任务裁剪、按 allowlist 裁剪，或使用双层「命名空间 + 按需加载」架构，让编译出的工具列表在多轮之间字节稳定。记忆选择是第三份、小得多的预算 —— `memory.selector` 决定每次编译注入哪些条目（见[记忆](/zh/guide/memory)）。

## ② 位置 —— 它落在窗口的哪里

编译出的 payload 是一个三明治：稳定、可缓存的前缀（系统 prompt、工具 schema、skill 指令、记忆用法说明），加上缝进最后一条 user 消息的易变 tail（记忆数据、动态状态、隐式上下文、announcements、handoff 通知）。

让 prompt 缓存真正生效的那条规则是：任何易变内容都不得进入前缀。库自己的每一份工具 schema 都是静态的 —— `context` 工具只有一个 enum，而且那是一份固定的命令列表，绝不是你的 memory key 列表。所有逐轮变化的东西都走 tail 通道。`memoryPlacement`、`dynamicStatePlacement`、`skillPlacement` 和 announcement 的 `channel` 是这里的旋钮；`cacheAudit: true` 会在你放错位置时告诉你。见[记忆](/zh/guide/memory)、[Skill](/zh/guide/skills) 和[工具管理](/zh/guide/tool-management)。

## ③ 持久化 —— 它在窗口之外时住在哪

一套基底：带元数据的可寻址内容。`StorageBackend` 负责搬字节；`Store` 在其上加了命名空间、`context://` URI、访问索引和淘汰。目前有四个命名空间 —— `memory/`（每次编译都注入的持久事实）、`notes/`（模型自己的草稿空间）、`vfs/`（大到不能内联的工具输出）、`archive/`（被压缩出窗口的片段）。

4.2 之前这是三套互不相干的存储接口。现在它们是一套，旧接口（`MemoryStore`、`VFSStorageAdapter`、`VFSMemoryStore`、`FileSystemAdapter`）作为已废弃的包装层继续可用。见[上下文存储](/zh/guide/context-store)。

## ④ 取回 —— 模型如何伸手去窗口之外拿东西

一个面向模型的工具。`context` 覆盖全部七个命令（`view`、`create`、`str_replace`、`insert`、`delete`、`rename`、`search`）与所有命名空间，`new_context` 则让模型主动关掉一个它已经用完的窗口。`chef.ownsTool(name)` 与 `chef.handleTool(call)` 是这两者 —— 以及遗留的 `create_memory` / `modify_memory` / `recall_context` 三件套 —— 唯一的分发入口。

`ChefConfig.tools` 决定 `compile()` 发出哪一套：`'legacy'`（4.x 的默认值 —— 工具名是你循环里的分发键，所以默认值不能在 minor 版本里翻转）或 `'unified'`。这个模式同时决定本会话的词汇表，因此 prompt 绝不会提到 payload 里并不存在的工具。见[上下文存储](/zh/guide/context-store)。

## ⑤ 适配 —— provider 的线上格式要什么

同一份编译好的 IR 会变成 OpenAI、Anthropic、Gemini 或 OpenAI Responses 的 payload：prefill、cache 断点、system 消息提升、thought signature 和 tool call 形状全部是适配器的事。输入适配器（`fromOpenAI` / `fromAnthropic` / `fromGemini`）跑反方向，并在入口处做 sanitize。见[适配器](/zh/guide/adapters)。

## 编译管道

`compile()` 会跑一串固定顺序的阶段。每个阶段有明确的契约，slot 在阶段之间的边界上触发。

```
start → transform-tool-results → handoff → overflow → inject
      → memory → skill → assemble → tail → adapt → audit → done
```

| 阶段 | 做什么 |
|---|---|
| `start` | `compile:start` 事件、中断检查、目标解析 |
| `transform-tool-results` | 对每条 `role: 'tool'` 消息跑 `transformToolResult` —— 在 overflow 之前，所以摘要模型看到的是转换后的内容 |
| `handoff` | 当剩余额度落进 handoff 带宽时，每个窗口渲染一次通知 |
| `overflow` | 预算检查，然后是装配好的策略；被驱逐的内容随后归档 |
| `inject` | `before-assemble` 处理器 → `<implicit_context>` |
| `memory` | 清理过期条目、执行一次 selector，并从同一次 store 读取里派生注入块与工具定义 |
| `skill` | 当前激活 skill 的指令，落在前缀或 tail |
| `assemble` | 三明治装配 —— 系统层、历史、护栏、各种 placement |
| `tail` | tail 缝合：skill、记忆数据、动态状态、隐式上下文、announcements、锚点行 |
| `adapt` | 目标适配器、工具、服务端托管的 payload 字段 |
| `audit` | Anthropic 目标上的 `cacheAudit`，以及可选的 `pipelineChecks` 不变量 |
| `done` | `compile:done` 事件 |

中断检查（`compile({ signal })`）位于 `overflow`、`inject`、`memory`、`assemble`、`adapt` 之后 —— 每一个跟在「可能任意久的 await」后面的边界。

## Slot

Slot 是组合面。[事件](/zh/guide/events-hooks)只做观察，而 slot 处理器会参与编译：它可以否决 overflow、注入上下文，或改写装配好的消息。处理器按注册顺序运行，逐个 await。

| Slot | 签名 | 契约 |
|---|---|---|
| `before-overflow` | `({ history, budget }) => void \| false` | 返回 `false` 可跳过本次编译的 overflow |
| `after-overflow` | `({ history, result }) => void` | 阶段被跳过时 `result` 为 `null` |
| `before-assemble` | `(ctx) => void` | `ctx.inject(text)` 向 `<implicit_context>` 追加一块 |
| `after-assemble` | `(messages) => Message[]` | 处理器串联 —— 每个都收到上一个的结果 |
| `before-adapt` | `(messages) => void` | 观察点，就在适配器运行之前 |
| `after-adapt` | `(payload) => void` | 观察点，在 `compile:done` 之前 |

```typescript
chef.use('before-overflow', ({ budget }) => {
  // One more turn of headroom before the summarizer gets involved.
  if (budget.remaining > -2000) return false;
});

chef.use('before-assemble', async (ctx) => {
  ctx.inject(await retrieveSnippets(ctx.dynamicStateXml));
});

chef.use('after-adapt', (payload) => {
  metrics.record('compile', payload);
});
```

`chef.unuse(slot, handler)` 移除一次注册；同一个函数注册两次就需要 `unuse` 两次。遗留的 `onBeforeCompile` 和 `transformContext` 配置钩子在构造时注册到同一个注册表上，因此它们总是最先运行 —— 见[事件与钩子](/zh/guide/events-hooks)。

## 不可协商的三条

- **机制，而非策略。** 任何选项组合都不会被拒绝。`reset()` 不配 archive 是有损的，但允许；handoff 预算大于触发线也允许。会静默失败的那几类情况 —— 前缀被改写、固定消息被丢掉、tool 配对被拆开 —— 会通过审计与事件通道**上报**，绝不阻断。`pipelineChecks: true` 在开发期打开这类上报。
- **前缀字节稳定。** 库自己的每一份工具 schema 都是静态且引用稳定的，所以 `payload.tools` 在多次编译之间保持深度相等。易变内容只从 tail 进入。
- **4.x 内零强制迁移。** 每一个被改名的选项都保留一个映射到新形态的废弃别名。别名在 5.0 才移除。

## 下一步去哪

- [溢出](/zh/guide/history-compression) —— 策略、handoff 预算、`new_context`、窗口谱系
- [上下文存储](/zh/guide/context-store) —— 一个后端、四个命名空间、`context` 工具
- [事件与钩子](/zh/guide/events-hooks) —— slot、事件、取消、并发
- [工具管理](/zh/guide/tool-management) —— 裁剪、blocklist、announcements
- [适配器](/zh/guide/adapters) —— 输入与目标适配器
