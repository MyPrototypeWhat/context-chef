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

在 `ToolDefinition` 上设置 `deferLoading: true`，即可将其标注给 Anthropic 服务端的 Tool Search：该标志在 Anthropic target 上原样透传到 `payload.tools`，让 API 按需展示工具的完整 schema，而不是预先全部加载。它只是注解 —— 其他 target 会忽略它。
