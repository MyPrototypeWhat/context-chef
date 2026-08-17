# 事件与钩子

ContextChef 提供统一的、纯观察型的事件系统，一个入口订阅所有内部模块的日志、指标和调试信息 —— 需要改变编译内容时，则使用拦截型钩子（`onBeforeCompile`、`onBeforeCompress`、`transformContext`）。

## 生命周期事件

通过 `chef.on()` 订阅，`chef.off()` 取消订阅。

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

### 可用事件

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

**Handler 错误隔离** <Badge type="tip" text="v4" />**。** 某个事件 handler 抛出或 reject 时只会被记录，其余 handler 照常执行 —— 4.0 之前，一个抛出的 handler 会让整个 `compile()` 失败。

事件与现有 config 回调共存：如果在 `JanitorConfig` 中配置了 `onCompress`，它会先触发，然后再 emit `compress` 事件。

## 取消 —— `compile({ signal })`

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

## 并发模型

**推荐模式：每个并发调用方一个 `ContextChef` 实例。** chef 在 `await` 点之间持有可变状态（in-flight signal、memory 轮次、active skill、history 引用），每请求独立实例化即可让每次调用拥有自己的状态 —— 没有共享可变状态就没有 race。

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

**同实例并发 `compile()` 会排队（v4）。** 并发调用会被序列化（snapshot + serialize），不再交错执行、破坏共享状态（轮次计数、熔断器、signal 暂存）。输入在调用时快照 —— 两次排队的 compile 之间调 `setHistory()`，第一次看到旧历史、第二次看到新历史。被 reject 的 compile 不会污染队列。推荐模式仍然是每个并发调用方一个 chef；队列的目的是让意外共享变得安全，不是变快。

## `onBeforeCompile` 钩子

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
