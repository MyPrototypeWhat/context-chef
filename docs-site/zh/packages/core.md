# @context-chef/core

核心上下文编译器 —— 历史压缩、工具裁剪、记忆、VFS 卸载、快照/恢复和多 provider 适配，无框架依赖。当你直接驱动 LLM SDK（OpenAI / Anthropic / Gemini）并希望完全控制编译管道时使用它。

[![npm version](https://img.shields.io/npm/v/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)
[![npm downloads](https://img.shields.io/npm/dm/@context-chef/core.svg)](https://www.npmjs.com/package/@context-chef/core)

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

## 内含模块

完整 API 按模块分布在指南中，一页一个关注点：

| 模块 | 指南页面 |
|---|---|
| 五条轴、编译管道、slot | [架构](/zh/guide/architecture) |
| 溢出策略、Janitor runner、`compact()`、`ensureValidHistory` | [溢出](/zh/guide/history-compression) |
| `planCompaction` / `compactHistory` / `summarizeHistory` | [持久化压缩](/zh/guide/durable-compaction) |
| `server()` 策略、`contextManagement: { strategy: 'server' }` | [服务端上下文管理](/zh/guide/server-side-context-management) |
| `StorageBackend` / `Store`、`context` 工具、`tools` 模式 | [上下文存储](/zh/guide/context-store) |
| Memory —— TTL、`selector`、`allowedKeys`、`memoryPlacement` | [记忆](/zh/guide/memory) |
| Offloader / VFS —— `offload`、`cleanupAsync`、`reconcileAsync` | [卸载与 VFS](/zh/guide/offloading-vfs) |
| Pruner —— 扁平模式、blocklist、namespace、`deferLoading` | [工具管理](/zh/guide/tool-management) |
| Skill —— `SKILL.md` 加载、`renderSkill`、交付模型 | [Skill](/zh/guide/skills) |
| `withGuardrails` —— XML 契约 + prefill | [护栏](/zh/guide/guardrail) |
| `snapshot()` / `restore()` | [快照与恢复](/zh/guide/snapshot-restore) |
| slot、事件、`compile({ signal })`、并发 | [事件与钩子](/zh/guide/events-hooks) |
| 输入/目标适配器、`adapterRegistry`、`openai-responses` | [适配器](/zh/guide/adapters) |

## 工具函数

- `estimate(text)` / `estimateObject(obj)` —— 粗略 token 估算（替代已移除的 `TokenUtils`）。
- `objectToXml(obj)` —— 动态状态背后的 XML 序列化器（替代已移除的 `XmlGenerator`）。
- `getAdapter(name)` / `adapterRegistry` —— 适配器查找与注册（替代已移除的 `AdapterFactory`）。
- `ensureValidHistory(messages)` —— 修复消息数组以满足 LLM API 约束。
- `getRecallToolDefinition()` / `chef.resolveRecall(uri)` —— 归档/卸载内容的召回工具。

## 链接

- [npm — @context-chef/core](https://www.npmjs.com/package/@context-chef/core)
- [源码与完整 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/core)
- [迁移指南（v4）](/zh/migration/v4)
