# VFS 生命周期 — 生产实践 Recipe

Offloader 的 `.context_vfs/`（或任意自定义 storage backend）不会自动收敛 —— 必须由你触发清理。ContextChef 提供了 mechanism：`cleanup()`、`reconcile()`、`onVFSEvicted` 钩子，但永远不自动触发。本文档收录 5 个生产级接入模式。

**速查：**

| 方法 | 作用 | 触发时机 |
|---|---|---|
| `chef.getOffloader().cleanupAsync()` | 先按 maxAge 清扫，再 LRU 淘汰至满足 maxFiles/maxBytes | 定时；每轮；会话结束 |
| `chef.getOffloader().cleanupAsync({...})` | 同上，单次调用覆盖上限 | 快照前 / 关机前激进清理 |
| `chef.getOffloader().reconcileAsync()` | 把孤儿文件接管进内存索引 | 启动 / 冷启动时调用一次 |
| `onVFSEvicted` 钩子 | 单条驱逐通知 | 接入 telemetry、审计日志、副作用 |

**驱逐顺序（单 pass）：**

1. **Phase A** —— 所有 `now - createdAt > maxAge` 的条目被驱逐（reason `'maxAge'`）。
2. **Phase B** —— 当 count > maxFiles 或 bytes > maxBytes，按 `accessedAt` 从旧到新依次驱逐（reason `'maxFiles'` 当 count cap 是制约，否则 `'maxBytes'`）。

UTF-8 字节数走 `Buffer.byteLength(content, 'utf8')` —— `maxBytes` 是真实存储字节数，不是 JS `string.length`。

---

## Recipe 1 — 长跑 server 的定时清理

任意常驻服务（Express、Fastify、Hono、NestJS、持久 worker）的默认接法。一个 scheduler，固定节奏，错误记录但不抛给请求处理。

```typescript
import { ContextChef } from '@context-chef/core';

const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    storageDir: './.context_vfs',
    maxAge: 24 * 60 * 60 * 1000,   // 24 小时
    maxFiles: 500,
    maxBytes: 100 * 1024 * 1024,   // 100 MiB
    onVFSEvicted: (entry, reason) => {
      logger.debug({ uri: entry.uri, reason, bytes: entry.bytes }, 'vfs evicted');
    },
  },
});

// 每 10 分钟清扫一次。和请求处理解耦 —— 失败只记录，不抛。
const sweepInterval = setInterval(() => {
  chef.getOffloader()
    .cleanupAsync()
    .then(({ evicted, evictedBytes, failed }) => {
      logger.info({ evicted: evicted.length, evictedBytes, failed: failed.length }, 'vfs swept');
    })
    .catch((err) => {
      logger.error({ err }, 'vfs sweep failed');
    });
}, 10 * 60 * 1000);

// 不要让 cleanup 计时器阻塞进程退出。
sweepInterval.unref();

// 优雅关机时再激进清扫一次，让下个进程从干净状态启动。
process.on('SIGTERM', async () => {
  clearInterval(sweepInterval);
  await chef.getOffloader().cleanupAsync({ maxAge: 0 }).catch(() => {});
  process.exit(0);
});
```

**每轮变体（低吞吐 agent）：** 如果你的 agent 是单用户单轮、轮间隔几秒（聊天 UI、copilot 循环），把 `cleanupAsync()` 放到每轮末尾比 setInterval 更合适，磁盘大致只会保留一轮的溢出量：

```typescript
async function handleTurn(userMessage: string) {
  // ... append、compile、调 LLM、append response ...
  await chef.getOffloader().cleanupAsync();
}
```

interval 模式适合「轮触发可能比 cleanup 完成更快」的场景（服务并发请求）。

---

## Recipe 2 — Serverless / 进程重启用 `reconcile()`

经典坑：serverless 或容器重发时，内存索引消失了，但 storage backend（挂载卷、/tmp、S3 桶）里的文件还在。新 `Offloader` 实例不知道这些文件存在，所以 `cleanup()` 沉默地变成 no-op，直到你把它们接管回来。

`reconcile()` 走 `adapter.list()`，从文件名 `vfs_<ts>_<hash>.txt` 解析出 `createdAt`，把每个孤儿插入索引。等价于 `npm cache verify`。

```typescript
import { ContextChef } from '@context-chef/core';

// 模块级一次性构造（cold start 跑一次，warm 调用复用）。
const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    storageDir: '/tmp/.context_vfs',  // serverless 可写临时空间
    maxAge: 60 * 60 * 1000,           // 1h —— Lambda /tmp 短暂但 warm 调用间会保留
    maxFiles: 100,
    maxBytes: 50 * 1024 * 1024,
  },
});

// 首次调用：接管上一轮 warm instance 留下的文件。
let reconciled = false;
async function ensureReconciled() {
  if (reconciled) return;
  reconciled = true;
  const adopted = await chef.getOffloader().reconcileAsync({ measureBytes: true });
  if (adopted > 0) logger.info({ adopted }, '从上次调用接管了孤儿 VFS 条目');
}

export async function handler(event: LambdaEvent) {
  await ensureReconciled();

  // ... 处理 event ...

  // 返回前清扫一次，让下次 warm 调用在预算内启动。
  await chef.getOffloader().cleanupAsync();

  return { statusCode: 200 };
}
```

**为什么要 `measureBytes: true`？** 不传时，被接管的条目 `bytes: 0`（list 阶段不读内容），它们对 `maxBytes` 驱逐就是不可见的，直到再次被 resolve。如果你在意按字节准确驱逐，cold start 时承担一次性读取代价；只关心 `maxAge` / `maxFiles` 就跳过。

**文件名解析：** 不匹配 `vfs_<digits>_<hex>.txt` 的孤儿（比如绕过 Offloader 写入的文件）会用 `Date.now()` 作 `createdAt` 兜底 —— 它们会从被接管的瞬间起活满一个 `maxAge`，不会更久。

---

## Recipe 3 — AI SDK middleware：共享 adapter，外置 lifecycle

**问题：** `@context-chef/ai-sdk-middleware` 在 `truncateToolResults()` 内部为每次请求都新建一个 `Offloader`（见 `packages/ai-sdk-middleware/src/truncator.ts`）。那个实例的内存索引是一次性的、用完即丢 —— 在它身上调 `cleanup()` 没意义。

**模式：** 在模块层只建一个共享的 `VFSStorageAdapter`，通过 `truncate.storage` 传给 middleware，**同时**自己再建一个长生命周期的 `Offloader` 包装同一个 adapter。lifecycle 用长跑的；middleware 那个短命的只是写穿到同一个 backend。

```typescript
import { generateText } from 'ai';
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { Offloader, FileSystemAdapter } from '@context-chef/core';

// 共享 storage backend。
const storageAdapter = new FileSystemAdapter('./.vfs');

// 长生命周期 Offloader 包装同一个 adapter。仅用于 lifecycle。
const lifecycleOffloader = new Offloader({
  threshold: 5000,
  adapter: storageAdapter,
  maxAge: 12 * 60 * 60 * 1000,
  maxFiles: 200,
  maxBytes: 50 * 1024 * 1024,
  onVFSEvicted: (entry, reason) => {
    logger.debug({ uri: entry.uri, reason }, 'vfs evicted');
  },
});

// 启动时接管孤儿（进程可能重启过）。
await lifecycleOffloader.reconcileAsync();

// 把同一个 adapter 接进 middleware。middleware 内部会构造它自己的短命 Offloader ——
// 没关系，两边都写穿到 storageAdapter。
const wrapped = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  truncate: { threshold: 5000, storage: storageAdapter },
});

// 定时清理跑在 lifecycle Offloader 上,它能看到 middleware 写的每个文件。
setInterval(() => {
  lifecycleOffloader.cleanupAsync().catch((err) => logger.error({ err }, 'vfs sweep failed'));
}, 10 * 60 * 1000).unref();

// 正常使用 wrapped 模型:
const result = await generateText({ model: wrapped, ... });
```

**为什么这样能 work：** `cleanup()` 通过内存索引按 filename 操作。middleware 的临时 Offloader 写一个文件（filename 落到 storage），然后被 GC —— 但文件留下来了。`lifecycleOffloader.reconcileAsync()` 跑的时候（启动时调用，或想最大保险时每次 cleanup 前调用），它会接管 middleware 写的每个文件，`cleanupAsync()` 按你的 cap 驱逐它们。

**双保险变体** —— 如果 middleware 写入很密集，你不想等到下个 interval 才看到新文件，那就在每次 cleanup 前都 reconcile：

```typescript
async function sweep() {
  await lifecycleOffloader.reconcileAsync();
  await lifecycleOffloader.cleanupAsync();
}
```

`reconcile()` 是幂等且廉价的（一次 `adapter.list()`），每次清理前调一遍没问题。

---

## Recipe 4 — 自定义 storage adapter（Redis 示例）

`FileSystemAdapter` 是唯一内置实现。其他后端 —— Redis、S3、SQLite、IndexedDB、纯内存 —— 都需要自定义 adapter。要启用 `cleanup()` 和 `reconcile()`，adapter 必须实现可选的 `list()` 和 `delete()` 方法。任一缺失，`cleanup()` 抛 `VFSCleanupNotSupportedError({ missing: ['list'?, 'delete'?] })`。

```typescript
import type { VFSStorageAdapter } from '@context-chef/core';
import type { RedisClientType } from 'redis';

class RedisVFSAdapter implements VFSStorageAdapter {
  constructor(
    private redis: RedisClientType,
    private keyPrefix = 'vfs:',
  ) {}

  async write(filename: string, content: string): Promise<void> {
    await this.redis.set(this.keyPrefix + filename, content);
  }

  async read(filename: string): Promise<string | null> {
    return await this.redis.get(this.keyPrefix + filename);
  }

  // cleanup() 必需。返回纯 filename（不带 prefix），和 write/delete 的入参对齐。
  async list(): Promise<string[]> {
    const keys = await this.redis.keys(this.keyPrefix + '*');
    return keys.map((k) => k.slice(this.keyPrefix.length));
  }

  // cleanup() 必需。**必须幂等** —— 删不存在的文件不能抛。Redis DEL 天然幂等。
  async delete(filename: string): Promise<void> {
    await this.redis.del(this.keyPrefix + filename);
  }
}

const chef = new ContextChef({
  vfs: {
    threshold: 5000,
    adapter: new RedisVFSAdapter(redisClient),
    maxAge: 7 * 24 * 60 * 60 * 1000,  // Redis 里存 7 天
    maxBytes: 500 * 1024 * 1024,
  },
});

// 生命周期接法和 Recipe 1 相同 —— 定时 cleanupAsync()，启动时 reconcileAsync()。
```

**自定义 adapter 上线检查：**

- [ ] `list()` 只返回 filename，**不要**返回完整 key / path / URI（Offloader 自己拼 `uriScheme`）。
- [ ] `list()` 在 namespace 为空时返回 `[]`，永远不要在「无条目」时抛。
- [ ] `delete()` 必须幂等 —— 不能因 `ENOENT` / "key not found" 抛。任何异常都会让 cleanup 把这条记进 `result.failed`。
- [ ] 如果你的 storage 有原生 TTL（Redis `EXPIRE`、S3 lifecycle rule），优先让 backend 负责真实数据驱逐，ContextChef 的 `cleanup()` 只用来同步内存索引。配置 `maxAge` 大致对齐 backend TTL。
- [ ] 在 `list()` 里过滤掉非 VFS 的 key —— 同一个 Redis 命名空间如果有别的数据，prefix 要严格限制（`FileSystemAdapter` 出于同样原因按 `vfs_` 前缀过滤文件名）。
- [ ] Async adapter **必须**配 `cleanupAsync()` / `reconcileAsync()`。同步 `cleanup()` 在 `list()` 返回 Promise 时会抛 `'use cleanupAsync() instead'`。

---

## Recipe 5 — 选择你的驱逐策略

没有放之四海而皆准的配置；答案取决于稀缺资源是什么。

| 瓶颈是… | 配… | 跳过… |
|---|---|---|
| 磁盘空间 | `maxBytes` | `maxFiles`（总字节有界时数量无所谓） |
| 文件句柄 / inode 数（大量小文件） | `maxFiles` | `maxBytes` |
| 数据时效（不能服务超过 X 老的内容） | 仅 `maxAge` —— 其他做兜底 | — |
| 以上全要 | 三个都配 —— Phase A 清陈旧，Phase B 同时强制 bytes + count | — |
| 存储硬上限，但不在意单条年龄 | `maxFiles` + `maxBytes`，留 `maxAge` 不配 | — |

**`Infinity` 关闭单次调用的某项 cap：**

```typescript
// 快照前：清掉所有 1 小时以上的，count / byte cap 这次忽略。
await chef.getOffloader().cleanupAsync({
  maxAge: 60 * 60 * 1000,
  maxFiles: Infinity,
  maxBytes: Infinity,
});
```

**`0` 触发某 phase 全清：**

```typescript
// 会话结束:不论年龄全清掉(Phase A: now - createdAt > 0 对所有条目都成立)。
await chef.getOffloader().cleanupAsync({ maxAge: 0 });
```

**Telemetry：** `onVFSEvicted` 钩子按条目触发，每次成功驱逐后调用，自身异常被吞（`console.warn` 记一笔，永不外传）。适合接 metrics、审计、下游缓存失效：

```typescript
const chef = new ContextChef({
  vfs: {
    maxFiles: 500,
    onVFSEvicted: (entry, reason) => {
      metrics.increment('vfs.eviction', { reason });
      metrics.distribution('vfs.evicted_age_ms', Date.now() - entry.createdAt);
      metrics.distribution('vfs.evicted_bytes', entry.bytes);
    },
  },
});
```

`cleanup()` / `cleanupAsync()` 返回的 `VFSCleanupResult` 已经给了聚合计数（`evicted.length`、`evictedBytes`、`evictedByAge`、`evictedByCount`、`evictedByBytes`、`failed.length`）；只在需要按条目归因时才用钩子。
