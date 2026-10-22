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
- **handoff 通知标记** <Badge type="tip" text="4.2" /> —— `ChefSnapshot.handoffNoticedWindow` 记录通知已经为哪个窗口发过。窗口谱系本身会随 janitor 状态往返，没有这个字段的话，恢复出来的会话就会停在一个「已经通知过」的窗口上却把标记清空了，于是每一轮都重发一次通知。
- **append-only ledger** <Badge type="tip" text="4.3" /> —— 打开 `appendOnly` 时，`ChefSnapshot.prefixLedger` 记录 chef 在哪里追加了什么、上一次发送了什么，`modelMemoryWrites` 记录哪些 memory 写入是模型做的。恢复它们不算检查点。每个请求新建一个 chef 时，必须在每次 compile 之后保存它的快照，在请求的 tool call 执行完后再保存一次，并在下一个请求里恢复：没有 ledger，每个请求一开始都是一次 `ledger` 检查点，在 Anthropic 上会剥掉 history 里的 thinking。memory 放在共享存储里时，恢复时跳过快照里的 memory（恢复这一部分会把共享存储回滚到保存时的样子）：`chef.restore({ ...saved, modules: { ...saved.modules, memory: null } })`。skill 在 `restore()` 之前注册；system prompt、tools 和状态在它之后设置，因为它会用保存的值替换这些。见 [Append-only 前缀](/zh/guide/append-only#持久化对话)。
- 快照元数据：你传入的 `label` 和 `createdAt`。

完整的回滚演示见可运行示例 [snapshot-restore](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts)。
