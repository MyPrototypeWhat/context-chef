# 上下文存储 <Badge type="tip" text="4.2" />

ContextChef 留在上下文窗口之外的所有东西 —— 持久的记忆条目、卸载出去的工具输出、归档的压缩片段、模型自己的工作笔记 —— 本质上是同一种东西的不同地址。4.2 把过去三套互不相干的存储接口收敛成一套基底和一个面向模型的工具。

这对应[五轴架构](/zh/guide/architecture)里的 ③（持久化）和 ④（取回）。模块级的细节仍留在各自的页面：[记忆](/zh/guide/memory)讲 TTL、selector 和 `allowedKeys`，[卸载与 VFS](/zh/guide/offloading-vfs) 讲截断与清理生命周期，[溢出](/zh/guide/history-compression)讲什么会被归档。

## 基底

两层。`StorageBackend` 为一个或多个命名空间搬字节；`Store` 在其上加了命名空间、`context://` URI、访问索引和淘汰。

```typescript
interface StoredEntry {
  content: string;
  meta: { createdAt: number; updatedAt: number; bytes?: number } & Record<string, unknown>;
}

interface StorageBackend {
  read(ns: string, path: string): MaybePromise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): MaybePromise<void>;
  delete(ns: string, path: string): MaybePromise<boolean>;
  list(ns: string, prefix?: string): MaybePromise<ListedEntry[]>;
  // optional capabilities, queried rather than assumed:
  readAll?(ns: string, prefix?: string): MaybePromise<Record<string, StoredEntry>>;
  exists?(ns: string, path: string): MaybePromise<boolean>;
  append?(ns: string, path: string, content: string): MaybePromise<void>;
  search?(ns: string, query: string): MaybePromise<SearchHit[]>;
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
  getPhysicalPath?(ns: string, path: string): MaybePromise<string | null>;
  supports?(capability: StoreCapability, ns?: string): boolean;
}
```

每个方法都可以是同步或异步的，`Store` 会把这个选择原样透传下去，所以同步后端能让同步调用点（`chef.offload`、`memory.snapshot`）继续保持同步。向某个命名空间要它的后端做不到的能力会抛 `StoreCapabilityError`，并写明缺哪个能力 —— `context` 工具会把它转成模型能读懂的错误文本，而不是让这一轮失败。

库内置两个后端：

| 后端 | 存储方式 | 同步？ |
|---|---|---|
| `InMemoryBackend` | 每个命名空间一个 `Map` | 是 —— 临时性的，适合测试 |
| `FileSystemBackend` | 根目录下每个命名空间一个目录 | 是 —— 落盘的那个 |

`FileSystemBackend` 为每个命名空间保留各自的磁盘布局，因此两种历史格式（扁平的 `vfs_<ts>_<hash>.txt` VFS 文件和 JSON 记忆条目）都能原样往返。

## 命名空间

| 命名空间 | 装什么 | 谁写 | 在窗口里吗？ |
|---|---|---|---|
| `memory/` | 值得跨对话携带的持久事实 | [Memory](/zh/guide/memory)、模型 | 每次编译都注入 |
| `notes/` | 模型自己的工作草稿空间 | 模型，通过 `context` 工具 | 只有模型去读时才在 |
| `vfs/` | 大到不能内联的工具输出 | [Offloader](/zh/guide/offloading-vfs) | 只留截断标记 + URI |
| `archive/` | 被压缩出窗口的片段 | [溢出](/zh/guide/history-compression)的 `archive` | 摘要里的一条引用 |

`memory/` 是唯一自动展示给模型的命名空间；其余命名空间在模型主动去读之前都不进窗口。这正是 `notes/` 的意义所在：一个放计划或运行日志的地方，且每轮不产生任何成本。

::: tip 4.x 里归档仍然写进 `vfs/`
`overflow.archive` 仍把片段存到 `context://vfs/...` 之下，好让已有的 URI 保持字节一致。专门的 `archive/` 命名空间已经存在、可读，并将在 5.0 成为归档的正式落点。
:::

## `ChefConfig.store`

一个后端撑起所有命名空间：

```typescript
import { ContextChef, FileSystemBackend } from '@context-chef/core';

const chef = new ContextChef({
  store: new FileSystemBackend('./.context'),
  memory: {},
  vfs: { threshold: 5000 },
  overflow: { archive: 'vfs' },
});
```

`store` 只填补别处没有指定的部分。显式的 `memory.store` 对记忆仍然优先，显式的 `vfs.store` / `vfs.adapter` / `vfs.storageDir` 对 VFS 仍然优先 —— 两者都不设时，今天的默认行为原样保留，所以给已有配置加上 `store` 绝不会在你背后搬运数据。

如果你想要按命名空间的淘汰上限或 URI 前缀，传一个构造好的 `Store` 而不是裸后端：

```typescript
import { FileSystemBackend, Store } from '@context-chef/core';

const store = new Store(new FileSystemBackend('./.context'), {
  eviction: {
    vfs: { maxFiles: 500, maxBytes: 100 * 1024 * 1024 },
    archive: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  },
});
```

## 寻址

每个条目只有一个地址：`context://<namespace>/<path>`。

```typescript
const notes = chef.getStore().namespace('notes');

await notes.put('plan.md', '# Plan\n1. Read the failing test\n');
const entry = await notes.get('plan.md');
notes.uri('plan.md'); // 'context://notes/plan.md'

Store.parseUri('context://notes/plan.md'); // { ns: 'notes', path: 'plan.md' }
```

传了 `ChefConfig.store` 时 `chef.getStore()` 返回那个共享 store，否则返回 Offloader 自己的那个 —— 因此它永远是 `context` 工具读写的同一个 store。用它在开跑前预置 notes，或在跑完后检查模型写了什么。

`NamespaceView` 还提供 `list`、`entries`、`append`、`delete`、`search`、`exists`、`getPhysicalPath` 和 `supports`，以及给同步后端用的 `getSync` / `putSync` / `deleteSync` / `listSync`。`put` 返回 `{ path, uri }`；不带 path 调用（`put(content, meta)`）时它会按内容派生路径，因此在 agent 循环里重复卸载相同内容是幂等的，URI 也能跨进程保持稳定。

## `context` 工具

一个工具、七个命令、所有命名空间：

| 命令 | 做什么 |
|---|---|
| `view` | 读一个条目，或列出一个目录（`context://notes/` 就是目录） |
| `create` | 写一个新条目；已存在则失败 |
| `str_replace` | 把 `old_str` 唯一一次精确出现替换成 `new_str` |
| `insert` | 把 `insert_text` 放到 0 基行号 `insert_line` 上 |
| `delete` | 删除一个条目 |
| `rename` | 在同一命名空间内移动到 `new_path` |
| `search` | 在 `path` 之下查找内容匹配 `query` 的条目 |

这份 schema 是静态、冻结且引用稳定的：只有一个 enum，而且它是命令列表 —— 绝不是你的 memory key 的实时列表。这正是它能安心待在缓存前缀里、不让任何东西失效的原因。「此刻有什么」由 prompt 更下方的部分传达：注入的记忆块，以及这个工具自己的返回结果。

行为按命名空间区分，每个命名空间都保留其模块的语义：

- **`memory/`** 经由 Memory 模块，因此 `allowedKeys`、`onMemoryUpdate` 否决、`onMemoryChanged`、TTL 和更新计数的行为与直接调用 API 完全一致。`rename` 是一次 create 加一次 delete。
- **`notes/`** 直达 `store.namespace('notes')` —— 带行号的 `view`、要求唯一匹配的 `str_replace`、0 基的 `insert`，以及在后端没有原生检索时退回「list + get」的 `search`。
- **`vfs/`** 和 **`archive/`** 默认只读，并通过与 `recall_context` 相同的召回路径渲染。

模型自己的错误从不抛异常。未知路径、缺参数、写只读命名空间、不被允许的 memory key、`onMemoryUpdate` 的否决，都会以 `Error: …` 文本返回，让模型读到并自行纠正。只有 chef 不拥有的工具名会抛异常 —— 那是你循环里的路由 bug，模型修不了。

### 访问策略

读永远不受限：store 里的一切都是这段对话自己溢出的内容，一个能拿到 `context://` URI 的模型，也就能拿到 URI 背后的东西。写则受限：

```typescript
const chef = new ContextChef({
  store: new FileSystemBackend('./.context'),
  memory: {},
  tools: 'unified',
  contextTool: { writable: ['notes'] }, // memory becomes read-only to the model
});
```

默认值是 `['memory', 'notes']`。加上 `'vfs'` 可以让模型编辑卸载出去的工具输出。策略在调用分发时执行，绝不在 store 里执行 —— 你自己的代码想写哪儿写哪儿。

### 分发 —— `ownsTool` 与 `handleTool`

库拥有的每个工具只有一个入口：`context`、`new_context`，以及遗留的 `create_memory` / `modify_memory` / `recall_context` 三件套。

```typescript
for (const call of response.tool_calls) {
  if (chef.ownsTool(call.function.name)) {
    const content = await chef.handleTool({
      name: call.function.name,
      arguments: call.function.arguments,
    });
    history.push({ role: 'tool', tool_call_id: call.id, content });
    continue;
  }
  await executeYourOwnTool(call);
}
```

`arguments` 既接受 OpenAI 和 Anthropic SDK 给出的 JSON 字符串，也接受 Anthropic `input` / Gemini `args` 里已经解析好的对象。

`ownsTool` 与 `ChefConfig.tools` 无关：模式决定 `compile()` **发出**什么，而不是 `handleTool` **理解**什么。一个已经发出 `context`、但模型偶尔还会去调 `create_memory` 的迁移期是可用的，反过来也一样。

## `tools` 模式

```typescript
const chef = new ContextChef({ tools: 'unified' /* default: 'legacy' */ });
```

| 模式 | `payload.tools` 携带 | 词汇表 |
|---|---|---|
| `'legacy'`（4.x 默认） | Memory 的 `create_memory` / `modify_memory`。`recall_context` 与 `new_context` 保持可选 —— 自行注册 | 4.x 的说法：记忆是一个自带工具的独立特性 |
| `'unified'` | 一个 `context` 工具，外加配置了 `overflow.handoff` 时的 `new_context`。不再发出遗留记忆工具 | 全程 `context://` 寻址 |

两套永远不会同时出现在一个 payload 里：它们用两套词汇描述同一批操作，同时拿到两套的模型只能去猜宿主到底分发哪一套。

**为什么默认仍是 `'legacy'`。** 工具名是你 agent 循环里的分发键。翻转默认值等于在一个 minor 版本里悄悄给你 `if (name === 'create_memory')` 匹配的工具改名。它会在 5.0 变成 `'unified'` —— 那是一个 major，你会先读到迁移说明。

你不必等模式切换才用上这个工具。两种模式下自行注册都可以：

```typescript
import { getContextToolDefinition, getNewContextToolDefinition } from '@context-chef/core';

chef.registerTools([getContextToolDefinition(), getNewContextToolDefinition()]);
```

### 词汇表开关

模式同时决定本会话的词汇表 —— 在构造函数里解析一次，然后注入到库为模型渲染文本的每一处：

| 模型读到的东西 | `'legacy'` | `'unified'` |
|---|---|---|
| 记忆用法说明 | `Prompts.MEMORY_INSTRUCTION` | `Prompts.CONTEXT_STORE_INSTRUCTION` —— 命名空间、寻址、哪些是自动展示的 |
| 注入记忆块的头部 | 4.x 的头部 | `Memory (context://memory/*) currently holds:` |
| 卸载截断标记 | 4.x 的占位符 | 点名 `context` 工具与 `context://vfs/` URI |
| 摘要包装 | 4.x 的包装 | 引用 `context://archive`，并带上窗口谱系行 |
| handoff 通知 | `Prompts.HANDOFF_NOTICE_TEMPLATE` | 用 `context://` 寻址的版本 |

要点在于：prompt 绝不会提到 payload 里并不存在的工具。`LEGACY_VOCABULARY` 逐字委托给现有的 `Prompts` 字符串，这正是默认行为与 4.1 字节一致的原因 —— golden payload 固定用例会断言这一点。

不经过 chef 单独构造的模块（`new Memory(...)`、`new Offloader(...)`）在你不手动传词汇表时，行为与从前完全一致。

## 从 4.1 的存储接口迁移

什么都不会坏。旧接口是新基底之上的废弃包装层，现有配置全部继续可用。

| 已废弃 | 替代 | 说明 |
|---|---|---|
| `MemoryStore` | `StorageBackend` | 由 `Store.fromMemoryStore` 包装；`MemoryStoreEntry` 与 `StoredEntry.meta` 一一对应 |
| `VFSStorageAdapter` | `StorageBackend` | 由 `Store.fromVfsAdapter` 包装 |
| `FileSystemAdapter` | `FileSystemBackend` | 磁盘格式相同 |
| `VFSMemoryStore` | `FileSystemBackend` + `memory` 命名空间 | 它本来就是 VFS 后端上的 `memory/`；已在新后端上重建，磁盘格式不变 |
| `InMemoryStore` | `InMemoryBackend` | 仍然导出、仍然可用 |
| 各模块各自的 `memory.store` / `vfs.storage` | 一个 `ChefConfig.store` | 设置了模块级 store 时仍以模块级为准 |

`Memory` 与 `Offloader` 三种都接受 —— 遗留 store、`StorageBackend`、或 `Store` —— 且公开 API 未变。它们在 5.0 移除。

## 下一步去哪

- [记忆](/zh/guide/memory) —— TTL、`selector`、`allowedKeys`、`memoryPlacement`
- [卸载与 VFS](/zh/guide/offloading-vfs) —— 截断、清理生命周期、自定义后端
- [溢出](/zh/guide/history-compression) —— 什么会被归档，以及 `new_context`
- [架构](/zh/guide/architecture) —— 持久化与取回在五轴中的位置
