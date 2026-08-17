# 示例

可运行的自包含示例位于仓库的 [`examples/`](https://github.com/MyPrototypeWhat/context-chef/tree/main/examples) 目录。大多数完全离线运行（mock 摘要器，无需 API key）；调用真实模型的示例会说明需要设置哪个环境变量。用 `npx tsx examples/<name>.ts` 运行任意示例。

## Core

| 示例 | 演示内容 |
|---|---|
| [`basic-chat.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/basic-chat.ts) | ContextChef + Janitor 自动历史压缩、`reportTokenUsage` 式 token 跟踪、编译到 OpenAI 格式。需要 `OPENAI_API_KEY`。 |
| [`compression-v2.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/compression-v2.ts) | v4 janitor 管道：`triggerRatio` 腐烂前触发、`pinned` 消息穿过压缩、`archive: 'vfs'` + `chef.resolveRecall`、`compressionGuidelines`、`minShrinkRatio` + `validateCompression` 质量闸门、细粒度压缩事件、`compressionMode: 'incremental-anchored'`。完全离线。 |
| [`durable-compaction.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/durable-compaction.ts) | `planCompaction` 轮次安全切分、`compactHistory` 一步压缩、`result === history` no-op 持久化模式，以及与在途压缩的对比。完全离线。 |
| [`guardrail.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/guardrail.ts) | `withGuardrails` 强制 XML + prefill、按 provider 的 prefill 降级、`withGuardrails(null)` 清除、v4 顺序无关性。完全离线。 |
| [`memory.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/memory.ts) | `InMemoryStore` 记忆、轮次与墙钟 TTL、两种 `memoryPlacement` 模式及尾部放置为何对 KV-cache 友好、注入 selector，以及编译出的 `<memory>` 块 + 记忆工具。完全离线。 |
| [`multi-provider.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/multi-provider.ts) | 同一套 prompt 编译到 OpenAI、Anthropic、Gemini 格式 —— Anthropic 缓存断点、跨 provider 的 prefill 降级。完全离线。 |
| [`skills.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/skills.ts) | Skill 对象与 `SKILL.md` 加载、`registerSkills` + `activateSkill`、`renderSkill` 占位符替换、`formatSkillListing`、`meta.activeSkillName`。完全离线。 |
| [`snapshot-restore.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts) | `chef.snapshot(label)` / `chef.restore(snap)` 回滚、`guardrailOptions` 完整往返、快照里的 Janitor 状态（含 anchored 模式的 anchor 文档）。完全离线。 |
| [`tool-pruning.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/tool-pruning.ts) | 扁平模式按任务的 tag 裁剪，以及双层架构：稳定 namespace + 按需 toolkit。完全离线。 |
| [`vfs-lifecycle.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/vfs-lifecycle.ts) | `offloadAsync` 首尾标记 + URI、`offload:created` 事件、`getRecallToolDefinition` + `chef.resolveRecall` 往返、带 `maxFiles` / `maxBytes` LRU 驱逐的 `cleanupAsync`。完全离线。 |

## Middleware

| 示例 | 演示内容 |
|---|---|
| [`ai-sdk-middleware.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/ai-sdk-middleware.ts) | `withContextChef` 一个包装器搞定 compress + truncate + compact、按对话的 `sessionId` 隔离、Anthropic 服务端上下文管理的防双重压缩闸门、`compactModelMessages` 持久化压缩。离线可构造；模型调用需要 `OPENAI_API_KEY`。 |
| [`tanstack-ai.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/tanstack-ai.ts) | `@tanstack/ai` 0.44 上的 `contextChefMiddleware` compress + truncate + compact、`threadId` 会话 key、`compactTanStackMessages` 持久化压缩。离线可构造；`chat()` 调用需要 `OPENAI_API_KEY`。 |

## 运行示例

```bash
git clone https://github.com/MyPrototypeWhat/context-chef.git
cd context-chef
pnpm install
pnpm build

npx tsx examples/compression-v2.ts   # 离线
export OPENAI_API_KEY=your-key
npx tsx examples/basic-chat.ts       # 调用真实 API
```
