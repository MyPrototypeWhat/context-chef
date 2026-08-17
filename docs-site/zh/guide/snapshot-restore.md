# 快照与恢复

捕获和回滚全部上下文状态，用于分支探索或错误恢复 —— 决定下次编译的一切都在快照里。

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

## 快照包含什么

- **History** 以及下次编译要注入的动态状态。
- **Janitor 状态** —— 包括压缩失败计数（熔断器），以及 `'incremental-anchored'` 模式下的持久 anchor 文档。后台压缩状态*不*进快照。
- **Memory** 条目。
- **护栏 options** <Badge type="tip" text="v4" /> —— v4 中 `withGuardrails` 是存储态，因此 `ChefSnapshot` 增加了 `guardrailOptions`，快照/恢复完整往返。
- 快照元数据：你传入的 `label` 和 `createdAt`。

完整的回滚演示见可运行示例 [snapshot-restore](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts)。
