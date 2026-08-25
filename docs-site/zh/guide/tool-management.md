# 工具管理（Pruner）

工具太多会导致幻觉。Pruner 把工具注册和路由彻底分开：按任务裁剪工具列表、在 dispatch 时拦截工具而不破坏 KV cache，或用双层 namespace + 按需加载架构让工具列表在多轮对话中保持稳定。

## 扁平模式

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

## 运行时 Blocklist（权限闸门）

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

`checkToolCall` 返回 discriminated union（`ToolCallCheckResult`），TypeScript 保证 `reason` 当且仅当被拒绝时存在。Blocklist 变化不破 KV cache —— LLM 仍看到全部工具，闸门只在 dispatch 端生效。

## Namespace + Lazy Loading（双层架构）

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

## 延迟工具加载 —— `deferLoading` <Badge type="tip" text="v4" />

在 `ToolDefinition` 上设置 `deferLoading: true`，即可将其标注给 Anthropic 服务端的 Tool Search：该标志在 Anthropic target 上原样透传到 `payload.tools`，让 API 按需展示工具的完整 schema，而不是预先全部加载。它只是注解 —— 其他 target 会忽略它（OpenAI 有自己的等价原生 tool-search 机制）。

一个标志，两个消费方。Claude 通过 tool search 按需发现 deferred 工具；在 `mid-conversation-tool-changes` beta 下，deferred 工具还会一直被扣住，直到对话中途出现 `tool_addition` 块把它放出来。deferred 定义会在计算 cache key 之前被剥离，所以新增它们永远不会让已有的缓存条目失效。chef 只原样透传该标志 —— 转换成 provider 的线上字段（`defer_loading`）和定义的其余部分一样，属于你的工具转换步骤；`tool_addition` / `tool_removal` 内容块不做透传（chef 的 IR 以文本内容为基础）。想用*文字*告诉模型工具集合变了，用下面的 announcements。

## Announcements —— 告诉模型发生了什么变化 <Badge type="tip" text="4.1" />

会话中途能力会变：权限被授予、toolkit 被加载、限流把 `web_search` 撤下。payload 的形状变了，却没有任何东西告诉模型*到底变了什么* —— 于是它继续调用已经消失的工具，或者对刚上线的工具视而不见。`announce()` 把这个变化说出来，并且一直说下去，直到你撤回。

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

**它是状态，不是事件。** announcement 陈述的是*当前*能力集合，每次 `compile()` 都会重新渲染 —— 而不是往 history 里追加一条一次性消息。这正是关键：chef 的注入从不写进你的 history，所以撤回之后它会从后续 payload 里彻底消失，而不是变成一条过期的对话轮次让模型反复重读。`announce()` 按 `id` upsert —— 用同一个 id 重新声明会替换内容和 channel，但保留原来的插入位置，所以更新内容时整个块保持稳定。`retractAnnouncement(id)` 返回是否真的删掉了东西。

### 三个 channel

| Channel | 渲染位置 | 说明 |
|---|---|---|
| `'user_tail'` | 并入最后一条 user message 的 tail 拼接段 —— 在 `<dynamic_state>` / `<implicit_context>` 之后，anchor 那行之前 | 所有 provider 都能用。与 skill instructions、memory data 不同，announcement **会**触发 "Above is the current system state" 那行 anchor —— 它本来就是系统状态 |
| `'system'` | 合并成一条 `_positional` system message，放在对话尾部之后（仍然排在任何 assistant prefill 之前） | 具备 operator 优先级，且缓存前缀完好无损 |
| `'auto'`（默认） | 按 **target** 路由：Anthropic target 走 `'system'`，其余一律 `'user_tail'` | 见下面的坑 |

channel 是逐条设置的，所以混合设置的一组 announcement 会在同一次 compile 里分走两条投递路径。

**auto 路由的坑。** `'auto'` 按 *target* 路由，不按模型 —— chef 根本看不到你的 model id。对话中途的 `role: "system"` 消息在 Fable 5 / Mythos 5 / Opus 4.8 / Opus 5 上是原生支持的，但 **Sonnet 5 不支持**。如果你编译到 Anthropic target 而实际调用 Sonnet 5，必须显式指定 channel：

```typescript
chef.announce("tools:added", "Tools newly available: grep", { channel: "user_tail" });
```

机制而非策略 —— chef 不会替你猜模型。

`'system'` channel 依托 `Message._positional`：被标记为 positional 的 `role: 'system'` 消息会*留在它所在的位置*，而不是被提升进 provider 的顶层 system 参数。各适配器的行为：Anthropic 发出一条对话中途的 system message（若它会排在所有 user/tool 消息之前，则降级为提升到顶层，并只警告一次）；OpenAI Chat Completions 本来就把 system 消息留在原地，该标记是 no-op；Responses 适配器把它作为内联 `message` item 发出，而不是折进 `instructions`；Gemini 的 `contents` 没有 system role，会原样降级成一条 `user` entry。

**措辞很重要。** 陈述事实，不要下命令。"Tools newly available: read_file, grep" 和 "web_search has been withdrawn; calls to it will be rejected" 读起来是系统状态；"You must now use read_file" 读起来是一条和你的 system prompt 抢话语权的指令 —— 模型会拿它去和你说过的所有话做权衡。

**生命周期。** announcement 能挺过 `clearHistory()` —— 它描述的是当前能力集合，新开的对话同样需要；变化不再成立时请显式撤回。它随 `ChefSnapshot` 一起走，`snapshot()` / `restore()` 可以完整往返；恢复 4.1 之前的快照（没有 `announcements` 字段）会得到一个空集合，而不是让上一批 announcement 继续生效。开启 `cacheAudit: true` 后，若 `<announcements>` 块出现在最后一个 `cache_control` 断点处或之前，会被标记出来 —— announcement 永远渲染在对话尾部，所以要把断点往前挪。

### 自己检测 delta

chef 不做任何自动的工具 delta 检测。它只渲染你声明的内容，判断*到底变了什么*属于策略，留在你的 loop 里：

```typescript
let previousTools = new Set<string>();

function syncToolAnnouncements(next: string[]) {
  const added = next.filter((name) => !previousTools.has(name));
  const removed = [...previousTools].filter((name) => !next.includes(name));

  if (added.length) {
    chef.announce("tools:added", `Tools newly available: ${added.join(", ")}`);
  } else {
    chef.retractAnnouncement("tools:added"); // 已经不"新"了 —— 别再重复
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

// 和上面的运行时 blocklist 天然配套 —— 闸门负责拒绝，announcement 负责解释：
chef.getPruner().setBlockedTools(["delete_file"]);
chef.announce("tools:blocked", "delete_file is disabled in this environment");
```

在你决定工具列表的地方调用它：构造请求之前，或者当工具集合由 Pruner 掌管时（`payload.tools`）放在 `compile:done` 处理器里 —— 注意此时声明的 announcement 落在*下一次* compile，而不是刚刚完成的这次。
