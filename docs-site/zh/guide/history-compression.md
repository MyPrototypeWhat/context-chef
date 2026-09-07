# 溢出（Overflow）

当对话长过窗口，总得有东西离开。这就是溢出：信息从窗口移动到[上下文存储](/zh/guide/context-store)，并通过 `context` 工具保持可达。它是[五轴架构](/zh/guide/architecture)里的 ① → ③ → ④，也是一个被干净地劈成两半的决策。

**Janitor 是 runner。** 它读 token 预算、判断触发线何时越过、维护熔断器、归档离开窗口的内容、发出 `compress:*`、跑持久化压缩。**策略是 policy。** 它拿到窗口内的历史和被击穿的预算，返回新的窗口内容以及所有离开窗口的东西。

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },      // the runner
  overflow: {
    strategy: chain(summarize({ compressionModel: callGpt4oMini }), reset()), // the policy
    archive: 'vfs',
  },
});
```

本页「策略」一节以下的所有内容，对你装配的任何策略都成立。

## 策略 <Badge type="tip" text="4.2" />

六个内置项，每个都是 `@context-chef/core` 里的工厂函数。四个是 policy，两个是组合子。

| 工厂 | 什么离开窗口 | 成本 | 什么时候用 |
|---|---|---|---|
| `summarize(opts)` | 旧轮次，被一份 LLM 摘要取代 | 每次溢出一次模型调用 | 默认项 —— 你希望对话的实质内容留下来 |
| `anchored(opts)` | 旧轮次，合并进一份持久的 anchor 文档 | 每次溢出一次模型调用，但作用范围更小 | 长会话，每次重写整份摘要既浪费又会漂移 |
| `server(config, { fallback })` | 在能替你压缩的 provider 上，客户端什么都不做 | 在 Anthropic 上零额外模型调用 | 你面向 Anthropic 且想要精确的 token 记账；`fallback` 让这份配置可跨 provider 复用 |
| `reset(opts)` | 除固定消息外的一切，只留一条 stub | 零 | 作为 `chain` 的兜底步骤，或子任务之间的硬边界。不配 `archive` 则有损 |
| `chain(...strategies)` | 第一个成功的策略驱逐的内容 | 该策略的成本 | 你想要兜底：先尝试摘要，摘要模型挂了也要把窗口收回来 |
| `background(strategy)` | 与 `strategy` 相同，只是晚一次编译 | 相同，但不在主链路上 | 压缩延迟正在拖慢你的轮次 |

`chain` 在某个策略什么都没改**或**历史仍在触发线之上时继续往下走，并停在第一个把窗口压回预算内的策略上。`background` 让第一次超预算的编译原样返回历史，之后再把完成的结果换入 —— 且只在结果仍然适用时换入，判定用的是内容等价，因此期间被改写过的片段会丢弃该任务，而不是污染窗口。

```typescript
import { anchored, background, ContextChef, server, summarize } from '@context-chef/core';

// Anchored, off the hot path.
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: { strategy: background(anchored({ compressionModel: callGpt4oMini })) },
});

// Server-side on Anthropic, client-side everywhere else — one portable config.
const portable = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: server(
      { edits: [{ type: 'compact_20260112' }] },
      { fallback: summarize({ compressionModel: callGpt4oMini }) },
    ),
  },
});
```

`summarize()` 和 `anchored()` 接受同一组选项 —— `compressionModel`、`compressionGuidelines`、`customCompressionInstructions`、`minShrinkRatio`、`validateCompression`、`preserveRatio`、`preserveRecentMessages`、`toolResultStubThreshold`、`split`。这些就是你也可以直接写在 `janitor` 上的那组字段；见本页下方的「4.1 的压缩选项」。

### 切分点落在哪

两个摘要类策略都在轮次边界上切 —— assistant 消息和它的 tool result 绝不分离 —— 差别只在保留的尾巴多大：

- `split: 'ratio'` 保留能装进 `budget.trigger × preserveRatio`（默认 `0.8`）的近期轮次。只有配上真正的 tokenizer 才有意义。
- `split: 'recent-turns'` 保留最后 `preserveRecentMessages` 个轮次（默认 `1`），不管它们多贵。当 token 数来自 provider 而不是本地 tokenizer 时，这才是正确选择。

当 `preserveRecentMessages` 是你给出的唯一保留选项时默认为 `'recent-turns'`，否则为 `'ratio'`。

## 怎么知道预算

runner 需要知道窗口有多满。两条路径，选一条。

### 路径 1：`tokenizer`（精确）

传入你自己的计数函数，Janitor 会逐条消息计算。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages — the exact slice of history the summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
  overflow: {
    strategy: summarize({ compressionModel: async (msgs) => callGpt4oMini(msgs), preserveRatio: 0.8 }),
  },
});
```

### 路径 2：`reportTokenUsage`（不需要 tokenizer）

大多数 LLM API 的响应里已经带了 token 用量。把那个值喂回来即可。

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200000 },
  overflow: {
    strategy: summarize({
      compressionModel: async (msgs) => callGpt4oMini(msgs),
      preserveRecentMessages: 1,
    }),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

在 tokenizer 路径下，默认取本地计算值与喂入值中的较大者；`usagePreference` 可切换为 `'feedFirst'`（信任 API 真值）或 `'tokenizerFirst'`（完全忽略喂入值）。没有 `tokenizer` 时取值范围收窄为 `'max' | 'feedFirst'`，TypeScript 在编译期就会拒绝 `'tokenizerFirst'`。

> **注意：** 没有 `compressionModel` 时，`summarize()` 会直接丢弃被驱逐的片段而不做摘要。如果 `tokenizer` 和 `compressionModel` 都没有，构造时会打印一次控制台警告；显式配置了 `overflow.strategy`（或 `janitor.strategy`）则视为你有意为之，不再警告。

## 质量闸门

只有一条规则：坏摘要永远不能替换好历史。

- **腐烂前触发 —— `triggerRatio`（默认 `0.7`）**：溢出在 `contextWindow × 0.7` 处触发，而不是等到硬上限，因为模型质量早在窗口占满之前就开始退化。`triggerRatio: 1` 恢复 4.0 之前的行为。
- **约束固定 —— `pinned: true`**：固定消息原文穿过每一种策略（按序重新插入到摘要之后），且永不被 `compact()` 清除。固定原子轮次中的任一消息即可保护整个轮次。用于策略与约束文本 —— 压缩丢掉策略文本会把违规率从 0% 拉到 30% 以上（arXiv:2606.22528）。
- **缩减闸门 —— `minShrinkRatio`（默认 `0.5`）**：摘要若未能让被压缩片段缩小 ≥ 50%（按字符长度；仅对 ≥ 2000 字符的片段生效）即视为一次失败的溢出 —— 历史不变，熔断计数 +1。防止压缩死循环。`0` 关闭。
- **`validateCompression`**：摘要后闸门 `(summary, { compressed, kept }) => boolean | Promise<boolean>` —— 返回 `false` 或抛出即拒绝该结果。
- **熔断器（归 runner 所有）**：**当前装配的任何策略**连续失败三次，溢出就变成 no-op，直到下一次成功或显式调用 `janitor.reset()` / `chef.clearHistory()`。计数由 `chef.snapshot()` / `chef.restore()` 保存。

一次失败 —— 模型抛异常、摘要没过缩减闸门、校验器说不 —— 会让历史**保持不变**（4.0 之前会截断并留占位符）。

**压缩输出契约。** 默认 prompt 要求压缩模型先写 `<analysis>` 草稿（会被剥除），再输出结构化的 `<summary>` 块，含 5 个领域无关的章节（Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve）。原始输出在注入前会经过 `Prompts.formatCompactSummary`。

**独立摘要。** `summarizeHistory(messages, compress, opts?): Promise<string>` 是该路径背后与 provider 无关的原语 —— 可直接调用它压缩你自己存储中的一段切片。空切片返回 `''`；无状态，且 `compress` 抛出时**直接抛出**；`compress` 回调**必须扁平化** `tool` 角色。更高层的辅助函数见[持久化压缩](/zh/guide/durable-compaction)。

## 归档 —— 可撤销的溢出 <Badge type="tip" text="4.2" />

`overflow.archive` 与策略无关：装配的策略压缩掉的那一段会被序列化存储（`OverflowResult.span`，因此被重新插回窗口的固定消息也会连同上下文一起归档），URI 则被取代它的摘要引用，因此精确细节始终可取回，而不是靠重要性打分去猜（arXiv:2607.25066、arXiv:2607.08032）。它对 `reset()` 的作用和对 `summarize()` 完全一样。

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: reset(),
    archive: 'vfs', // or { store: (serialized, { messageCount }) => uri }
  },
});
```

`'vfs'` 把片段存进这个 chef 的 VFS，位于 `context://vfs/...` 之下。归档是尽力而为：存储失败只记一条警告并跳过引用，而不会让溢出失败。

::: warning `reset()` 不配 `archive` 是有损的
除固定消息外的一切都没了 —— 没有摘要，也没有 URI。这个组合是被文档化的，不是被禁止的：机制，而非策略。除非你真的打算丢弃，否则给 `reset()` 配上归档。
:::

注册内置的 `recall_context` 工具，让模型按需取回归档内容：

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({ role: "tool", tool_call_id: call.id, content: content ?? "[not found]" });
}
```

在 `tools: 'unified'` 下，这件事由 `context` 工具的 `view` 命令完成，且 `chef.handleTool` 会替你分发 —— 见[上下文存储](/zh/guide/context-store)。

## Handoff 预算 <Badge type="tip" text="4.2" />

溢出是机械的。策略驱逐掉的东西就是从窗口里没了，不管模型准备好没有 —— 而只有模型知道对话的哪一半仍然重要。

Handoff 预算在触发线**之上**留出一段余量，并把它花在一条通知上：你的窗口马上要被裁掉了，把重要的东西写下来。

```typescript
const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: {
    strategy: summarize({ compressionModel: callGpt4oMini }),
    archive: 'vfs',
    handoff: {
      budgetTokens: 4000,
      prompt:
        'About {n_remaining} tokens remain before this conversation is compacted. ' +
        'Write anything worth keeping to context://notes/ or context://memory/ now.',
    },
  },
  tools: 'unified',
});
```

- 通知在 `budget.remaining <= budgetTokens` 时触发，**每个窗口一次** —— 在触发线附近待很久也不会每轮重复。窗口 id 变化时该标记重置。
- 它通过 announcement 的 tail 通道投递（`channel: 'auto'`，因此在 Anthropic 上是一条对话中的 system 消息，其他地方走 user tail），且从不持久化：它不在 `getAnnouncements()` 里、不进你的历史，在服务端托管的编译上则整体跳过。
- `{n_remaining}` 在出现的每一处都会被替换，取整并在 0 处截断。
- `budgetTokens` 必须是正整数，`prompt` 最多 2000 UTF-8 字节；两者都在构造时校验，而不是在编译时被悄悄忽略。省略 `prompt` 会用 `Prompts.HANDOFF_NOTICE_TEMPLATE`（在 `tools: 'unified'` 下则是它的 `context://` 变体）。

把它和上下文存储搭配使用：只有当模型有地方可写时，这条通知才有意义。`notes/` 在被读回来之前每轮不产生任何成本。

## `new_context` —— 让模型自己关掉窗口 <Badge type="tip" text="4.2" />

有时模型远在预算说话之前，就知道一块工作已经做完了。`new_context` 是一个静态、无参数的工具，说的正是这件事。

```typescript
import { getNewContextToolDefinition } from '@context-chef/core';

chef.registerTools([getNewContextToolDefinition()]);

for (const call of response.tool_calls) {
  if (call.function.name === 'new_context') {
    chef.requestNewContext();
    history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: 'Starting a new context window.',
    });
  }
}
```

在 `tools: 'unified'` 下，配置了 `overflow.handoff` 时这个工具会被自动发出，并由 `chef.handleTool` 分发。

`chef.requestNewContext()` 是一次性强制：下一次 `compile()` 不管预算怎么说都会执行策略。「新窗口」意味着什么，取决于你装配的策略 —— `summarize()` 留下一份摘要，`reset()` 留下一条 stub，两种情况下 `archive` 都让片段保持可取回。与 `clearHistory()` 不同，它不会在库背后丢掉任何东西：仍然由策略决定什么留下，`before-overflow` 处理器仍可否决，熔断器仍然生效。无论窗口是否真的变了，这个请求都会被一次编译消耗掉。

**强制溢出在哪里切。** 在 `summarize()` 和 `anchored()` 下，一次强制压缩会压掉除最近一轮之外的所有轮次，`preserveRecentMessages` / `preserveRatio` 不参与 —— 那两条规则是为了把满窗口压到触发线以下，而强制这一趟本来就与预算无关。留下最近一轮，是为了让模型有地方读到回答。窗口里只有一轮时什么都不会发生，结果的 `meta.reason` 会说明原因。

**跑不成的强制溢出绝不会静默。** 有两种编译会直接不做溢出：服务端托管的目标（窗口归提供方管）和 `before-overflow` 的否决。无论哪种，这个请求都已经被消耗掉了 —— 模型已经被告知要开新窗口了，所以这次落空会通过 `pipeline:invariant` 事件上报，并按原因各警告一次，说明是哪一种、以及该怎么办。

## 窗口谱系 <Badge type="tip" text="4.2" />

每一次落地的溢出都会关掉一个上下文窗口并开启下一个。runner 维护 `{ first, previous?, current }`，并且**只在 commit 时**推进，因此一个过期的后台结果绝不会移动这条链 —— 它记录的是存在过的窗口，不是被考虑过的窗口。

```typescript
chef.use('after-overflow', ({ result }) => {
  if (!result?.meta.changed) return;
  logger.info('overflow', result.meta.strategy, result.meta.windowId, result.evicted.length);
});

const payload = await chef.compile({ target: 'openai' });
payload.meta?.windowId;
```

两个 id，故意不同：`OverflowResult.meta.windowId` 是策略**作用于**的窗口，`CompileMeta.windowId` 是 payload **所属**的窗口。带着同一个 id 的两次 payload 是在同一个窗口上编译的，因此 id 变化就是「模型身后的历史被改写了」的信号。

谱系是让其余部分成立的东西：`anchored()` 按窗口 id 存放它的 anchor 文档（所以恢复快照会带回那个窗口当时真正拥有的 anchor）、handoff 通知每窗口一次、`reset()` 的 stub 会点名它关掉的窗口。它随 `JanitorSnapshot` 和 `ChefSnapshot` 一起往返于 `snapshot()` / `restore()`；`clearHistory()` 开启一条全新的谱系。「每窗口一次」这个标记也跟着走，就是 `ChefSnapshot.handoffNoticedWindow`，恢复出来的会话因此不会把模型已经看过的通知再发一遍。

## 写你自己的策略 <Badge type="tip" text="4.2" />

任何具有下面这种 `apply` 形状的对象都可以传给 `overflow.strategy`：

```typescript
interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  commit?(result: OverflowResult): void;   // the result actually entered the window
  pending?(): boolean;                     // a finished result is still waiting to land
  snapshot?(): unknown;                    // serialized into JanitorSnapshot
  restore?(state: unknown): void;
  attach?(runner: OverflowRunner): void;   // the runner installs its breaker + logger
}
```

`OverflowInput` 携带 `history`、`budget`、`tokenizer`、`pinned`（按轮次界定，按引用传递 —— 用 `===` 比较，不要按值比）、`window`、`forced` 和可选的 `signal`。`OverflowResult` 携带新的 `history`、全部 `evicted`、摘要所覆盖的 `span`、可选的 `summary`，以及 `meta: { strategy, windowId, changed, reason? }`。

`evicted` 的意思是「离开了窗口」。`span` 是摘要所覆盖的那一段 —— 同样这批消息，再加上策略原样塞回去、其实并没有离开窗口的 pinned 轮次。两个字段都是必填的：没有塞回任何东西的策略就把 `evicted` 原样再给一遍，什么都没改变的结果则两者都置空。`onCompress` 拿到的 `details.compressedMessages`、归档存下来的内容，以及引用里数的条数，读的都是 `span`。

`pending()` 是可选的，属于离线执行的策略。runner 在评估预算之前会问一次：`background()` 在有已完成的任务等着落地时返回 `true`，所以一份在历史已经回落到触发线以下之后才算完的摘要，仍然会在下一次编译落地，而不用等窗口重新填满。

```typescript
const dropToolResults: OverflowStrategy = {
  name: 'drop-tool-results',
  async apply(input: OverflowInput): Promise<OverflowResult> {
    const pinned = new Set(input.pinned);
    const evicted = input.history.filter((m) => m.role === 'tool' && !pinned.has(m));
    if (evicted.length === 0) {
      return {
        history: input.history,
        evicted: [],
        span: [],
        meta: {
          strategy: 'drop-tool-results',
          windowId: input.window.current,
          changed: false,
          reason: 'no unpinned tool results left',
        },
      };
    }
    const dropped = new Set(evicted);
    return {
      history: input.history.filter((m) => !dropped.has(m)),
      evicted,
      span: evicted,
      meta: { strategy: 'drop-tool-results', windowId: input.window.current, changed: true },
    };
  },
};

const chef = new ContextChef({
  janitor: { contextWindow: 200_000, tokenizer },
  overflow: { strategy: chain(dropToolResults, summarize({ compressionModel: callGpt4oMini })) },
});
```

两条规矩。绝不要丢掉 `input.pinned` 里的消息 —— `pipelineChecks` 不变量就是为了在你丢掉时抓住你。以及：从自己输出里派生的状态要在 `commit` 里发布，不要在 `apply` 里 —— `apply` 可能是投机执行的（`background()` 干的正是这件事），一个从未落地的结果不该污染你的状态。

## `JanitorConfig` —— runner 的选项

这些留在 Janitor 上。它们是预算与生命周期的事，不是策略的事。

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `contextWindow` | `number` | _必填_ | 模型的上下文窗口大小（token 数）。超过 `contextWindow × triggerRatio` 时触发溢出。 |
| `triggerRatio` | `number` | `0.7` | 触发溢出的 `contextWindow` 占比（「腐烂前」提前压缩）。设为 `1` 可恢复 4.0 之前打满窗口才触发的行为。 |
| `tokenizer` | `(msgs: Message[]) => number` | — | 启用 tokenizer 路径，精确计算每条消息的 token 数。 |
| `usagePreference` | `'max' \| 'feedFirst' \| 'tokenizerFirst'` | `'max'` | 当 `tokenizer` 与 `reportTokenUsage` 同时存在时，决定触发判断使用哪个 token 来源。 |
| `onCompress` | `(summary, count, details) => void` | — | 一次溢出落地后触发。`details.compressedMessages` 是被摘要替换的那段消息切片。 |
| `onBeforeCompress` | `(history, tokenInfo) => Message[] \| null` | — | 预算判定认为要执行溢出之后、策略运行之前触发。返回替换后的历史来介入，返回 `null` 则照常继续。未废弃。 |
| `logger` | `ChefLogger` | — | 降级警告的日志接收器（存储 / 压缩），默认使用 `console`。 |

## 4.1 的压缩选项

这里其实是两组东西，别混为一谈。下面这些**别名**已废弃：它们仍然可用、行为完全不变，并在 5.0 移除。别名和 `overflow.strategy` 同时设置会打印一次警告，且以策略为准。

| 已废弃 | 替代 |
|---|---|
| `janitor.compressionMode: 'rewrite'` | `overflow.strategy = summarize(...)` |
| `janitor.compressionMode: 'incremental-anchored'` | `overflow.strategy = anchored(...)` |
| `janitor.compressionScheduling: 'background'` | 用 `background(...)` 包住策略 |
| `janitor.archive` | `overflow.archive` |
| `contextManagement.strategy: 'server'` + `contextManagement.server` | `overflow.strategy = server(config, { fallback })` |

`contextManagement` 别名会构造出 `server(cfg, { fallback: <默认的客户端策略> })`，这正是 v4 的行为：Anthropic 上走服务端，其他地方走客户端压缩。见[服务端上下文管理](/zh/guide/server-side-context-management)。

另一组是调参选项，它们**没有**被废弃：`janitor.compressionModel`、`compressionGuidelines`、`customCompressionInstructions`、`minShrinkRatio`、`validateCompression`、`preserveRecentMessages`、`preserveRatio` 和 `toolResultStubThreshold`。没有配置 `overflow.strategy` 时，janitor 正是拿这几个字段解析出默认的 `summarize()`，所以它们仍然是不引入工厂函数就配置默认策略的受支持方式。`summarize()` 用的是同样的名字，所以自己组合策略只是把它们搬个地方，不用改名；显式的 `overflow.strategy` 会覆盖它们（并警告一次），但不等于把它们废弃。

## `chef.reportTokenUsage(tokenCount): this`

传入 API 返回的 token 用量。下次 `compile()` 时，如果该值超过触发线，就会执行溢出。

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

## 在溢出之前介入

`onBeforeCompress` 和 `before-overflow` slot 是两个不同的边界，两者都受支持。`onBeforeCompress` 是 runner 上的回调：只有预算判定认为要执行溢出时才触发，并且可以返回一份替换后的历史，由 runner 重新判定。slot 则在 chef 这一层 —— 每次编译都触发，早于任何判定，能看到 runner 真实的预算，并且可以通过返回 `false` 直接否决这个阶段：

```typescript
chef.use('before-overflow', ({ history, budget }) => {
  logger.info(`over budget by ${-budget.remaining} tokens, ${history.length} messages in window`);
  if (streamingInProgress) return false; // don't rewrite history mid-stream
});
```

完整的 slot 列表见[事件与钩子](/zh/guide/events-hooks)。

## 机械压缩（`compact`）

零 LLM 成本地从历史里剥掉内容。与溢出无关 —— 在你的 agent 循环里主动调用，可以保持窗口精简、推迟触发线。

```typescript
// Clear all tool results and thinking blocks
history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });

// Keep the 5 most recent tool results, clear the rest (min: 1)
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }],
});

// Combine: clear old tool results + all thinking
history = janitor.compact(history, {
  clear: [{ target: 'tool-result', keepRecent: 5 }, 'thinking'],
});

// v4: strip <think>...</think> tags from assistant text (open-weight reasoning models)
history = janitor.compact(history, { clear: ['reasoning-tags'] });

// v4: per-tool granularity — clear only these tools, never those
history = janitor.compact(history, {
  clear: [{
    target: 'tool-result',
    keepRecent: 5,          // counts within the clearable set
    toolFilter: ['run_bash'],   // only clear these tools
    exemptTools: ['read_file'], // never clear these (wins over toolFilter)
  }],
});
```

固定消息（`pinned: true`）永不被 `compact()` 清除，Gemini thought signature 对 `compact(['thinking'])` 免疫。

## `ensureValidHistory(history)`

独立工具函数，修复消息历史以满足 LLM API 约束（删除孤儿 tool result、为缺失的 tool result 注入占位、确保第一条非 system 消息是 user）。适用于从数据库加载历史或手动修改后的场景。

```typescript
import { ensureValidHistory } from '@context-chef/core';

const safeHistory = ensureValidHistory(rawHistory);
chef.setHistory(safeHistory);
```

> **边界契约**：所有 input adapter（`fromOpenAI` / `fromAnthropic` / `fromGemini`，以及 middleware 内部的 `fromAISDK` / `fromTanStackAI`）都会在出口自动跑一次 `ensureValidHistory` —— 它们是外部 SDK 格式与 ContextChef IR 之间的系统边界。`chef.setHistory(IR)` **不**做 sanitize：IR 是内部协议，直接构造或 mutate 出来的 history 视为已满足契约。如果不确定，显式用 `ensureValidHistory(...)` 包一下。

## `chef.clearHistory(): this`

切换话题或完成子任务时，显式清空历史并重置 runner 的状态 —— 熔断器、策略状态和窗口谱系。announcement 会保留；需要时显式撤回。
