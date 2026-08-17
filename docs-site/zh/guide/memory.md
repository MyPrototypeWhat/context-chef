# 记忆（Memory）

跨会话持久化的键值记忆：模型通过 tool call 写入，已有记忆在编译时自动注入 payload。记忆通过 tool call（`create_memory` / `modify_memory`）修改，`compile()` 时自动注入到 payload 中。

```typescript
import { InMemoryStore, VFSMemoryStore } from "@context-chef/core";

const chef = new ContextChef({
  memory: {
    store: new InMemoryStore(), // ephemeral (testing)
    // store: new VFSMemoryStore(dir),   // persistent (production)
  },
});

// In your agent loop, intercept memory tool calls:
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") {
      await chef.getMemory().updateMemory(key, value, description);
    } else {
      await chef.getMemory().deleteMemory(key);
    }
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");

// On compile():
// - Memory tools (create_memory, modify_memory) are auto-injected into payload.tools
// - Existing memories are injected as <memory> XML between systemPrompt and history
```

## Memory 位置 —— `memoryPlacement`

控制易变的 `<memory>` 数据块在编译产物中的落点。默认 `'after_system'`（向后兼容）。如果你在用 **Anthropic prompt caching** 且 cache breakpoint 打在 history 上，切换到 `'before_history_tail'`，这样 memory 变化就不会击穿 history 的缓存了。

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(dir),
    memoryPlacement: 'before_history_tail',
  },
});
```

| Placement | 三明治顶部 | 最后一条 user 消息 | 适用场景 |
|---|---|---|---|
| `'after_system'`（默认） | INSTRUCTION + `<memory>` 数据合并成一条 `role: 'system'` | 不动 | 简单 agent；不依赖 system 参数之后的 cache breakpoint |
| `'before_history_tail'` | 仅 INSTRUCTION（稳定，可缓存） | 在原 user 内容后追加 `<memory>` 数据块 | 你希望 history（或更靠前的 `system`）上的 cache breakpoint 在每轮 memory 变化时都能命中 |

这个拆分把稳定的使用说明留在三明治顶部享受缓存，把易变的数据块送到对话末尾。Anthropic / Gemini adapter 会把所有 `role: 'system'` 提取到 top-level `system` 参数 —— 选 `'before_history_tail'` 后，数据块改留在 `messages` 里，任何打在消息流更早位置的 cache breakpoint 都不再把变化的 memory 文本算进 hash。

如果动态状态也注入到末尾（`dynamicStatePlacement: 'last_user'`），最后一条 user 消息内部顺序是：原内容 → `<memory>` → `<dynamic_state>` → `<implicit_context>` → 锚定句。如果动态状态走独立 system message（`dynamicStatePlacement: 'system'`），memory 仍然注入到 user 末尾，但不会带锚定句。
