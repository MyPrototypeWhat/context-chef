# Tool Management (Pruner)

Too many tools cause hallucinations. The Pruner decouples tool registration from routing: prune the tool list per task, block tools at dispatch time without breaking KV cache, or use a two-layer namespace + lazy-loading architecture that keeps the tool list stable across turns.

## Flat Mode

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

Also supports `allowOnly(names)` and `pruneByTaskAndAllowlist(task, names)`.

## Runtime Blocklist (Permission Gate)

Block specific tools at dispatch time without breaking KV cache. Useful for permission control, environment safety, sandboxing, rate limits, and feature flags. The compiled `tools` array stays unchanged — enforcement happens via `checkToolCall` in your agent loop.

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

`checkToolCall` returns a discriminated union (`ToolCallCheckResult`), so TypeScript guarantees `reason` is present iff the call is rejected. KV cache is preserved across blocklist changes — the LLM continues to see the full tool set; the gate is dispatch-side only.

## Namespace + Lazy Loading (Two-Layer Architecture)

**Layer 1 — Namespaces**: Core tools grouped into stable tool definitions. The tool list never changes across turns.

**Layer 2 — Lazy Loading**: Long-tail tools registered as a lightweight XML directory. The LLM loads full schemas on demand via `load_toolkit`.

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

**Agent Loop integration:**

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

> **One level is enough.** The two-layer namespace → tools depth is the empirically optimal hierarchy for tool selection — deeper nesting hurts accuracy without saving meaningful context (arXiv:2607.17598). Don't nest namespaces inside namespaces.

## Deferred tool loading — `deferLoading` <Badge type="tip" text="v4" />

Set `deferLoading: true` on a `ToolDefinition` to annotate it for Anthropic's server-side Tool Search: the flag passes through `payload.tools` verbatim on the Anthropic target, letting the API surface the tool's full schema on demand instead of loading it up front. It is an annotation only — other targets ignore it.
