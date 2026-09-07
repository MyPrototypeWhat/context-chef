# 服务端上下文管理 <Badge type="tip" text="v4" />

Provider 现在可以在服务端执行 compaction（Anthropic `compact_20260112`、OpenAI `/responses/compact`）—— 少一次模型调用，还有精确的 token 计数。`ChefConfig.contextManagement` 让你把 LLM 压缩交给 provider；服务端不做的一切仍留在客户端：工具裁剪、skills、记忆、VFS 卸载、动态状态。

::: tip 这就是 `server()` 溢出策略 <Badge type="tip" text="4.2" />
从 4.2 起，服务端上下文管理是[溢出策略](/zh/guide/history-compression)之一：`overflow.strategy = server(config, { fallback })`。`contextManagement` 是一个已废弃的别名，它构造出来的正是这个 —— `server(cfg, { fallback: <默认的客户端策略> })` —— 并且到 5.0 之前行为完全不变。如果你想在同一份配置里为非 Anthropic 目标准备兜底，请用新写法。
:::

```typescript
const chef = new ContextChef({
  contextManagement: { strategy: "server" }, // 'client' (default) keeps client-side LLM compression
});

const payload = await chef.compile({ target: "anthropic" });
// payload.context_management === { edits: [{ type: "compact_20260112" }] }  (default when `server` omitted)
// payload.betas === ["compact-2026-01-12"]                                  (auto-derived per edit type)
```

## 语义

- `strategy: 'server'` 在支持它的目标上完全跳过客户端的 LLM 压缩。如果同时配置了 `compressionModel`，构造时会发出警告 —— 二选一。
- **在非 Anthropic 目标上**该策略无处可委托。`contextManagement` 别名会回落到默认的客户端策略（v4 行为）；而显式的 `server(config)` 若没有 `fallback`，则原样保留历史并报告原因。见[溢出](/zh/guide/history-compression)。
- `server` 是按 provider 形状原样透传的 edits 配置，例如 `{ edits: [{ type: 'compact_20260112', trigger: { ... } }] }` 或 `{ edits: [{ type: 'clear_tool_uses_20250919' }] }`。`payload.betas` 自动推导：compaction 类 edit 对应 `'compact-2026-01-12'`，clear-tool-uses / clear-thinking 类 edit 对应 `'context-management-2025-06-27'`。
- **compaction 块往返**：`fromAnthropic` 把 API 的 `{ type: 'compaction', content }` 块映射为标记 `pinned: true` 的透传消息，Anthropic adapter 在下次编译时把该块原文重新放在最前面 —— 服务端产出的摘要原样穿过客户端管道。

## 混合定位，不是二选一

LLM 压缩可以交给 provider，同时 ContextChef 继续做服务端不做的部分 —— 裁剪、skills、记忆、VFS 和动态状态。

AI SDK 用户有配套防护：middleware 检测到某次调用带 `providerOptions.anthropic.contextManagement` 时，会为该次调用跳过自己的压缩（服务端优先），并给出一次性警告。想有意两边都跑，关掉防护即可：

```typescript
const model = withContextChef(anthropic('claude-sonnet-4-6'), {
  contextWindow: 200_000,
  compress: { model: anthropic('claude-haiku-4-5') },
  allowDoubleCompression: true, // skip the guard: no skip, no warning
});
```

详见 [ai-sdk-middleware 包页面](/zh/packages/ai-sdk-middleware#anthropic-服务端上下文管理)。
