# 事件与钩子

两个面，两种职责。**事件**只做观察：它们为日志、指标和调试而触发，不能改变编译出的东西。**Slot** 参与其中：slot 处理器在编译管道内部运行，可以否决 overflow、注入上下文，或改写装配好的消息。

4.1 的配置钩子里有两个（`onBeforeCompile`、`transformContext`）现在就是 slot —— 同一条代码路径，在构造时注册，并且已被 slot 名称取代（deprecated）。`JanitorConfig.onBeforeCompress` 不在其列：它仍然是 Janitor 上的 runner 回调。

## Slot <Badge type="tip" text="4.2" />

六个组合点，各位于[编译管道](/zh/guide/architecture)中一个有意思的阶段边界上。用 `chef.use(slot, handler)` 注册，用 `chef.unuse(slot, handler)` 移除。

| Slot | 何时触发 | 签名 | 契约 |
|---|---|---|---|
| `before-overflow` | overflow 阶段之前 | `({ history, budget }) => void \| false` | 返回 `false` 可跳过本次编译的 overflow |
| `after-overflow` | overflow 阶段之后 | `({ history, result }) => void` | 阶段被跳过时 `result` 为 `null` |
| `before-assemble` | 三明治装配之前 | `(ctx) => void` | `ctx.inject(text)` 向 `<implicit_context>` 追加一块 |
| `after-assemble` | 作用于装配好的三明治 | `(messages) => Message[]` | 处理器串联 —— 每个都收到上一个的结果 |
| `before-adapt` | 目标适配器运行之前 | `(messages) => void` | 只观察；`messages` 是 readonly |
| `after-adapt` | 作用于编译好的 payload | `(payload) => void` | 只观察，在 `compile:done` 之前 |

```typescript
// Veto: don't rewrite history while a response is streaming.
chef.use('before-overflow', ({ history, budget }) => {
  logger.info(`over budget by ${-budget.remaining} tokens, ${history.length} messages in window`);
  if (streamingInProgress) return false;
});

// Inject: RAG results, AST snippets, MCP queries — without touching your message array.
chef.use('before-assemble', async (ctx) => {
  ctx.inject(await retrieveSnippets(ctx.dynamicStateXml));
});

// Transform: broad rewrites of the assembled message list.
chef.use('after-assemble', (messages) =>
  messages.filter((m) => m.content !== '' || m.tool_calls !== undefined),
);

// Observe the payload.
chef.use('after-adapt', (payload) => metrics.record('compile', payload));
```

**顺序。** 注册顺序就是执行顺序，处理器逐个 await。`use()` 允许同一个函数注册多次 —— 每次注册都会运行，而 `unuse()` 一次只移除一个：

```typescript
const skipWhileStreaming = () => false as const;
chef.use('before-overflow', skipWhileStreaming);
chef.unuse('before-overflow', skipWhileStreaming); // → this
```

处理器列表在 slot 运行前会做一次快照，因此在运行中注册或注销另一个处理器，不会打乱它自己所处的那次迭代。

**错误不做隔离。** 与事件处理器不同，抛异常的 slot 处理器会让整个 `compile()` 失败 —— 这与它们所泛化的那些遗留配置钩子行为一致。如果失败应当可存活，请自己用 try/catch 包住。

**多次调用 `inject()` 会累积**，按注册顺序，以空行分隔；空字符串被忽略。`ctx` 还带有 `systemPrompt`、`history`、`dynamicState` 和 `dynamicStateXml`。

### 遗留配置钩子

仍然受支持、行为仍然精确、在 5.0 移除。每一个都在构造时注册到同一个 slot 注册表上，且**排在**之后任何 `use()` 调用之前 —— 所以它们总是最先运行。

| 已废弃的配置字段 | 改为注册 |
|---|---|
| `ChefConfig.onBeforeCompile` | `chef.use('before-assemble', async (ctx) => ctx.inject(await retrieve(ctx)))` —— 返回的字符串就是注入内容 |
| `ChefConfig.transformContext` | `chef.use('after-assemble', fn)` |

别名等价性由测试断言：同样的输入，通过旧字段和新 slot 会在三个目标上产出字节一致的 payload。

有两个邻居看着像该进这张表，其实不是。`ChefConfig.transformToolResult` 仍然是配置项 —— 它是 `transform-tool-results` 阶段里的逐条消息转换，不是 slot。`JanitorConfig.onBeforeCompress` 仍然是 runner 上的回调：预算判定认为要执行溢出之后，它在 Janitor 内部触发，可以返回替换后的 `Message[]`，并且在没有 slot 注册表的独立 `Janitor` 上照样能用。`before-overflow` 是另一个边界、另一套契约 —— chef 这一层、每次编译都跑、`void | false` —— 所以把处理器从一边搬到另一边并不是改个名字，返回数组在那里只会被忽略。

## 生命周期事件

通过 `chef.on()` 订阅，通过 `chef.off()` 取消订阅。

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

| 事件 | 载荷 | 说明 |
|---|---|---|
| `compile:start` | `{ systemPrompt, history }` | `compile()` 开始时发出 |
| `compile:done` | `{ payload }` | `compile()` 产出最终 payload 后发出 |
| `compress:start` | `{ historyLength, currentTokens, limit }` | 预算超标 —— 溢出策略即将运行 |
| `compress:end` | `{ compressed }` | 溢出阶段结束。`compressed: false` 表示预算没问题或结果被拒绝 |
| `compress` | `{ summary, truncatedCount, details }` | 一次溢出落入窗口后发出 |
| `offload:created` | `{ uri }` | 内容被卸载到 VFS（经由 `chef.offload` / `offloadAsync` 或溢出归档） |
| `pruner:tool-blocked` | `{ name }` | `checkToolCall()` 依据 Pruner blocklist 拒绝了一次工具调用 |
| `pipeline:invariant` <Badge type="tip" text="4.2" /> | `{ phase, message }` | 一条 `pipelineChecks` 不变量被违反。仅上报 —— `compile()` 继续 |
| `memory:changed` | `{ type, key, value, oldValue }` | 任何记忆变更（set、delete、expire）之后发出 |
| `memory:expired` | `MemoryEntry` | `compile()` 期间某条记忆过期时发出 |

事件是**只观察**的 —— 它们不影响控制流。需要改点什么时，用 slot。

**处理器错误隔离** <Badge type="tip" text="v4" />**。** 抛出或 reject 的事件处理器会被记录，其余处理器照常运行 —— 4.0 之前，一个抛异常的处理器会让整个 `compile()` 失败。

事件与既有的配置回调共存：如果你在 `JanitorConfig` 里提供了 `onCompress`，它先触发，然后才发出 `compress` 事件。

## 管道不变量 —— `pipelineChecks` <Badge type="tip" text="4.2" />

当有代码参与编译时，有三件事会悄悄出错：slot 处理器丢掉了一条固定消息、把 tool call 和它的 result 拆开了、或者改写了 tail 插入点之前的内容。它们都不会让任何东西失败 —— 你要等很久才会发现，从一个不再遵守它已经看不见的策略的模型身上。

```typescript
const chef = new ContextChef({ pipelineChecks: process.env.NODE_ENV !== 'production' });

chef.on('pipeline:invariant', ({ phase, message }) => {
  console.warn(`[pipeline] ${phase}: ${message}`);
});
```

- 整条 `after-assemble` 链跑完之后检查一次：固定消息仍在，tool call / result 仍然配对。比对的是链的输入和链的输出，所以违规报的是整条链，而不是造成它的那个处理器。
- `tail` 阶段之后：tail 插入点之前的内容一字未变，与 `tail` 之前的快照逐字节比对。

违反只被**上报，绝不阻断** —— 机制，而非策略。每一条都会送到 `ChefConfig.logger`（或 `console`）以及 `pipeline:invariant` 事件；`compile()` 绝不会因为一次检查而抛异常。它的代价是每次编译一次快照加一次序列化，所以生产环境请关掉。默认 `false`。

## 取消 —— `compile({ signal })`

给 `compile()` 传一个 `AbortSignal` 可以取消进行中的编译，并把该 signal 传播给这次调用里触发的所有事件处理器。

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
    // compile was cancelled mid-flight at a phase boundary
  }
  throw err;
}
```

两个效果：

1. **转发给处理器** —— `chef.on(event, (payload, signal?) => ...)` 会在第二个参数收到该 signal。处理器可以把它传给 `fetch`、数据库客户端或任何协作式 API。
2. **在阶段边界检查** —— 在 `overflow`、`inject`、`memory`、`assemble` 和 `adapt` 之后。每一个都跟在可能任意久的 await 后面（压缩模型、记忆存储、你自己的处理器）。中断通过 `signal.throwIfAborted()` 抛出。

`compile:start` 在第一次中断检查之前触发，因此观察者可能收到一次 `compile:start`，而该次编译最终抛异常、从不触发 `compile:done`。从外部 `memory().set()` / `delete()` 调用（在 `compile()` 之外）触发的记忆事件拿到的 `signal` 是 `undefined`。

## 并发模型

**标准做法：每个并发调用方一个 `ContextChef` 实例。** 一个 chef 会跨 `await` 点持有可变状态（进行中的 signal、记忆轮次计数、当前激活的 skill、history 引用、窗口谱系）。按请求实例化让每次调用拥有自己的状态 —— 没有共享可变状态就没有竞争。

```typescript
// Express / Fastify / Hono — one chef per request
app.post('/agent', async (req, res) => {
  const chef = new ContextChef({ store: sharedBackend, memory: {} });
  chef.setHistory(req.body.history);
  const payload = await chef.compile({ target: 'openai' });
  res.json(payload);
});
```

如果记忆需要跨请求存活，把 store 提出去（一个共享的 `FileSystemBackend`、或你自己基于 Redis 的 `StorageBackend`），再传给按请求创建的 chef —— store 层面的并发是 store 的责任，不是 chef 的。见[上下文存储](/zh/guide/context-store)。

**同一实例上的并发 `compile()` 会排队（v4）。** 它们被串行化（快照 + 串行执行），而不是交错执行并破坏共享状态（轮次计数、熔断器、signal 暂存）。输入在调用时被快照 —— 两次排队调用之间的 `setHistory()` 意味着第一次编译看到旧历史、第二次看到新历史。被 reject 的编译不会毒化队列。标准做法仍然是每个并发调用方一个 chef；队列的存在是为了让意外共享变得安全，而不是为了让它变快。
