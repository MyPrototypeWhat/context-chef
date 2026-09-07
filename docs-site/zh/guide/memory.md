# 记忆（Memory）

> **本页讲的是 Memory 模块。** 记忆**住在哪** —— 唯一的存储基底、它与 `notes/` / `vfs/` / `archive/` 共享的 `context://memory/` 寻址，以及统一的 `context` 工具 —— 见[上下文存储](/zh/guide/context-store)。Memory 是 `memory/` 命名空间，再加上真正属于 Memory 自己的那些东西：TTL、selector、`allowedKeys`、写入钩子，以及数据块落在 payload 的哪个位置。

跨会话存活的持久键值记忆：模型通过 tool call 写入，已有记忆在每次 `compile()` 时自动注入编译产物。

```typescript
import { ContextChef, FileSystemBackend } from "@context-chef/core";

const chef = new ContextChef({
  store: new FileSystemBackend("./.context"), // one backend for every namespace
  memory: {},
});

// In your agent loop, dispatch memory tool calls through chef:
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: "tool", tool_call_id: call.id, content });
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");
```

`compile()` 时：记忆工具被自动注入 `payload.tools`（`tools: 'legacy'` 下是 `create_memory` / `modify_memory`，`'unified'` 下是单个 `context` 工具），已有条目被注入为 `<memory>` XML 块。

`chef.handleTool` 两套词汇都能分发，所以上面这段循环两种模式下都一样。4.1 的写法 —— 自己解析 `create_memory` / `modify_memory` 的参数并调用 `createMemory` / `updateMemory` / `deleteMemory` —— 仍然照常可用。

## `MemoryConfig`

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `store` | `MemoryStore \| StorageBackend \| Store` | — | 条目住在哪。省略时由 `ChefConfig.store` 补上；见[上下文存储](/zh/guide/context-store)。 |
| `defaultTTL` | `TTLValue` | — | 所有写入的默认过期。裸数字 = 轮次；`{ ms }` / `{ turns }` 是显式写法。undefined = 永不过期。 |
| `allowedKeys` | `string[]` | — | 限制模型可写的 key。它会成为 `create_memory` 的 `key` enum，并在分发时再校验一次。 |
| `selector` | `(entries: MemoryEntry[]) => MemoryEntry[]` | 全部条目 | 注入前的筛选 / 排序 / 截断，每次编译执行一次，在过期清扫之后。 |
| `memoryPlacement` | `'after_system' \| 'before_history_tail'` | `'after_system'` | 易变数据块落在哪。见下文。 |
| `onMemoryUpdate` | `(key, value, oldValue) => boolean` | — | 否决钩子。返回 `false` 阻止本次写入。 |
| `onMemoryChanged` | `(event: MemoryChangeEvent) => void` | — | 任何变更（`set` / `delete` / `expire`）之后的通知。 |
| `onMemoryExpired` | `(entry: MemoryEntry) => void` | — | `compile()` 期间每有一个条目过期就触发一次。 |

## TTL —— 会老去的条目

一个条目可以按墙上时钟过期，也可以按对话轮次过期，这两件事确实不同：「这个部署 token 一小时内有效」是墙上时钟，「记住我们正在编辑的文件，撑五轮」是轮次。

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    defaultTTL: { turns: 20 }, // everything ages out after 20 compiles unless overridden
    onMemoryExpired: (entry) => logger.info(`memory expired: ${entry.key}`),
  },
});

await chef.getMemory().set("active_file", "auth.ts", { ttl: { turns: 5 } });
await chef.getMemory().set("deploy_token", "…", { ttl: { ms: 60 * 60 * 1000 } });
await chef.getMemory().set("persona", "…", { ttl: null }); // never expires
```

裸数字就是轮次：`defaultTTL: 20` 和 `defaultTTL: { turns: 20 }` 是同一件事。轮次计数每次 `compile()` 前进一格，过期清扫在 `memory` 阶段开头运行 —— 所以用 `{ turns: 1 }` 写下的条目恰好能活过下一次编译。过期条目会触发 `onMemoryExpired` 和 `memory:expired` 事件，并出现在 `payload.meta.memoryExpiredKeys` 里。

## `selector` —— 决定什么被注入

记忆和其他任何东西一样是一份选择预算：除非你另有说法，`memory/` 里的一切每次编译都会被注入。`selector` 每次编译运行一次，在过期清扫之后，作用于即将被注入的那批条目。传给它的顺序就是 store 自己的 key 顺序 —— 一次批量读把这个顺序保住了，和 4.1 一样 —— 所以除非你自己重排，`<memory>` 块在多次编译之间是字节稳定的。

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    // Only inject the 10 most recently updated entries.
    selector: (entries) => [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10),
  },
});
```

每个 `MemoryEntry` 带有 `key`、`value`、`description?`、`createdAt`、`updatedAt`、`updateCount`、`importance?` 和解析后的过期信息。`importance` 由你设定、由你解释 —— 库本身从不按它排序。selector 不能抛异常：错误会传播出 `compile()`，想吞掉就返回原数组。被注入的 key 会出现在 `payload.meta.injectedMemoryKeys` 里。

## `allowedKeys` —— 一个封闭的 key 集合

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: { allowedKeys: ["persona", "project_rules", "user_preferences"] },
});
```

有意设了两道执行点。这个列表会成为 `create_memory` 工具定义里的 `key` enum，因此模型是被引导而不是被纠正；同时每次写入在分发时会再检查一遍，因此无视 enum 的模型（或使用 `context` 工具的模型 —— 那份 schema 刻意保持静态，不带任何 key 列表）拿到的是一句可读的 `Error: … is not an allowed memory key. Allowed keys: …`，而不是把垃圾写进去。

`allowedKeys` 是构造期配置，这正是工具 schema 能在多次编译之间保持静态的原因。

## 写入钩子

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: {
    onMemoryUpdate: (key, value, oldValue) => {
      if (key === "persona" && oldValue !== null) return false; // write-once
      return true;
    },
    onMemoryChanged: (event) => audit.record(event.type, event.key),
  },
});
```

`onMemoryUpdate` 是否决点：它在 `createMemory` / `updateMemory` / `deleteMemory` 之前运行，返回 `false` 即阻止写入。写入来自 tool call 时，否决会以错误消息的形式呈现给模型，而不是抛出异常。`onMemoryChanged` 是纯通知，过期时也会触发。两者都不能抛异常 —— 错误会传播出调用它的写入方法。

直接调用 `set()` / `delete()` 会绕过否决，这是设计如此：那是开发者自己的写入，不是模型的。

## 记忆位置 —— `memoryPlacement`

控制易变的 `<memory>` 数据块落在编译产物的哪个位置。默认 `'after_system'`（向后兼容）。如果你的应用使用 **Anthropic prompt caching** 并在 history 上打 cache 断点，切到 `'before_history_tail'`，这样记忆变更不会让 history 缓存失效。

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend("./.context"),
  memory: { memoryPlacement: 'before_history_tail' },
});
```

| 位置 | 三明治顶部 | 最后一条 user 消息 | 何时使用 |
|---|---|---|---|
| `'after_system'`（默认） | INSTRUCTION + `<memory>` 数据，合并为一条 `role: 'system'` 消息 | 不动 | 简单 agent；你不依赖 system 参数之后的 cache 断点 |
| `'before_history_tail'` | 只有 INSTRUCTION（稳定、可缓存） | 把 `<memory>` 数据块追加到原有 user 内容之后 | 你希望 history（或更靠前的 `system` 块）上的 cache 断点能扛住每轮的记忆变更 |

这个拆分把稳定的用法说明留在三明治顶部干净地缓存，把易变的数据块送到对话尾部。Anthropic / Gemini adapter 会把每条 `role: 'system'` 消息提到顶层 `system` 参数里 —— 在 `'before_history_tail'` 下数据块留在 `messages` 中，因此消息流中更靠前的任何 cache 断点都不再哈希那段会变的记忆文本。

当动态状态也注入在尾部（`dynamicStatePlacement: 'last_user'`）时，最后一条 user 消息内部的顺序是：原始内容 → `<memory>` → `<dynamic_state>` → `<implicit_context>` → announcements → 锚点行。当动态状态走自己的 system 消息（`dynamicStatePlacement: 'system'`）时，记忆仍然注入在 user 尾部，且不带锚点。

这是[五轴架构](/zh/guide/architecture)里的 ②：说明是前缀，数据是尾部。
