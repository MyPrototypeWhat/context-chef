# 历史压缩（Janitor）

Janitor 负责把长对话控制在模型的上下文窗口内：它监控 token 用量，在超预算时用低成本模型摘要旧消息、保留近期消息。本页覆盖两种压缩路径、`JanitorConfig` 的每个选项、v4「压缩管道 v2」的质量闸门，以及零 LLM 成本的 `compact()` 工具。

Janitor 提供两种压缩路径，根据你的场景选择：

## 路径 1：Tokenizer（精确控制）

传入自定义的 token 计算函数，Janitor 会精确计算每条消息的 token 数。保留 `contextWindow × preserveRatio` 范围内的近期消息，其余进行压缩。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) =>
      msgs.reduce((sum, m) => sum + encode(m.content).length, 0),
    preserveRatio: 0.8, // keep 80% of contextWindow for recent messages (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    onCompress: async (summary, count, details) => {
      // details.compressedMessages — the exact slice of history the summary replaced
      await db.saveCompression(sessionId, summary, count);
    },
  },
});
```

## 路径 2：reportTokenUsage（简单，无需 tokenizer）

大多数 LLM API 的响应中已经包含 token 用量。直接传入该值，当超过 `contextWindow` 时，Janitor 压缩除最后 N 条消息外的所有内容。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    preserveRecentMessages: 1,       // keep last 1 message on compression (default)
    compressionModel: async (msgs) => callGpt4oMini(msgs),
  },
});

// After each LLM call:
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

> **注意：** 如果没有提供 `compressionModel`，旧消息将被直接丢弃而不生成摘要。如果同时没有 `tokenizer` 和 `compressionModel`，构造时会打印控制台警告。

## `JanitorConfig`

| 选项                            | 类型                                        | 默认值 | 说明                                                                     |
| ------------------------------- | ------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `contextWindow`                 | `number`                                    | _必填_ | 模型的上下文窗口大小（token 数）。用量超过 `contextWindow × triggerRatio` 时触发压缩。 |
| `triggerRatio`                  | `number`                                    | `0.7`  | 触发压缩的 `contextWindow` 占比（"腐烂前"提前压缩）。设为 `1` 可恢复 4.0 之前打满窗口才触发的行为。 |
| `tokenizer`                     | `(msgs: Message[]) => number`               | —      | 启用 tokenizer 路径，精确计算每条消息的 token 数。                       |
| `preserveRatio`                 | `number`                                    | `0.8`  | [Tokenizer 路径] 有效预算（`contextWindow × triggerRatio`）中保留给近期消息的比例。 |
| `preserveRecentMessages`        | `number`                                    | `1`    | [reportTokenUsage 路径] 压缩时保留的近期轮次数量。                       |
| `usagePreference`               | `'max' \| 'feedFirst' \| 'tokenizerFirst'`  | `'max'`| 当 `tokenizer` 与 `reportTokenUsage` 同时存在时，决定触发判断使用哪个 token 来源。无 `tokenizer` 时取值范围收窄为 `'max' \| 'feedFirst'`，TypeScript 在编译期拒绝 `'tokenizerFirst'`。 |
| `compressionModel`              | `(msgs: Message[]) => Promise<string>`      | —      | 异步钩子，调用低成本 LLM 对旧消息进行摘要。                              |
| `customCompressionInstructions` | `string`                                    | —      | 追加到默认压缩 prompt 的额外聚焦指令（追加模式，不替换）。               |
| `compressionGuidelines`         | `string[]`                                  | —      | 注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。 |
| `toolResultStubThreshold`       | `number`                                    | —      | 摘要前把长于该字符数的 tool result 内容替换为一行元数据 stub（节省摘要模型 token）。 |
| `minShrinkRatio`                | `number`                                    | `0.5`  | 质量闸门：摘要必须让被压缩片段至少缩小该比例（仅对 ≥ 2000 字符的片段生效）；否则本次压缩失败，历史保持不变。`0` 关闭。 |
| `validateCompression`           | `(summary, { compressed, kept }) => boolean \| Promise<boolean>` | — | 摘要后闸门。返回 `false`（或抛出）即拒绝该摘要 —— 历史不变，熔断计数 +1。 |
| `archive`                       | `CompressionArchiveConfig \| 'vfs'`         | —      | 可逆压缩：存储压缩前的完整片段，并在摘要中引用其 URI。见[压缩管道 v2](#压缩管道-v2-v4)。 |
| `compressionMode`               | `'rewrite' \| 'incremental-anchored'`       | `'rewrite'`| anchored 模式维护一份持久的 anchor 文档，每次压缩只把新驱逐的片段合并进去。 |
| `compressionScheduling`         | `'blocking' \| 'background'`                | `'blocking'` | background 模式把摘要放到轮次之外运行；超预算的 compile 先原样返回历史，结果在仍然有效时再换入。 |
| `onCompress`                    | `(summary, count, details) => void`         | —      | 压缩完成后触发，传入摘要消息和被截断的消息数量。`details.compressedMessages` 是被摘要替换的那段消息切片。 |
| `onBeforeCompress`              | `(history, tokenInfo) => Message[] \| null` | —      | LLM 压缩前触发。返回修改后的历史来干预，或返回 null 让默认压缩继续执行。 |
| `logger`                        | `ChefLogger`                                | —      | 降级警告的日志接收器（存储/压缩），默认使用 `console`。 |

**压缩输出契约。** Janitor 默认 prompt 要求压缩模型输出两阶段响应：先在 `<analysis>` 里写草稿推理（会被剥除），再输出结构化的 `<summary>` 块，包含 5 个领域无关的章节（Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve）。原始输出在注入前会经过 `Prompts.formatCompactSummary` 清洗。完整契约与 `customCompressionInstructions` 用法见 [core 包 README](https://github.com/MyPrototypeWhat/context-chef/tree/main/packages/core)。

**失败语义（4.0 起变更）。** 压缩模型失败 —— 抛出异常、摘要未通过 `minShrinkRatio`、或被 `validateCompression` 拒绝 —— 会让历史**保持不变**（4.0 之前会截断历史并留下占位符），并使熔断计数 +1。如果连续 3 次 `compress()` 失败，`compress()` 将变为 no-op，直到下一次成功压缩或显式调用 `janitor.reset()` / `chef.clearHistory()`。失败计数由 `chef.snapshot()` / `chef.restore()` 保存。

**独立摘要。** `summarizeHistory(messages, compress, opts?): Promise<string>` 是该路径背后与 provider 无关的原语 —— 可直接调用它压缩你自己存储中的一段切片。空切片返回 `''`；无状态，且 `compress` 抛出时**直接抛出**；`compress` 回调**必须扁平化** `tool` 角色。可选项包括 `customCompressionInstructions`、`toolResultStubThreshold`、`compressionGuidelines` 和 `baseInstruction`。更高层的辅助函数见[持久化压缩](/zh/guide/durable-compaction)。

## 压缩管道 v2（v4）

v4 围绕一条规则重建了压缩路径：坏摘要永远不能替换好历史。

- **腐烂前触发 —— `triggerRatio`（默认 `0.7`）**：压缩在 `contextWindow × 0.7` 处触发，而不是等到硬上限 —— 模型质量早在窗口占满之前就开始退化。`preserveRatio` 作用于这个有效预算。`triggerRatio: 1` 恢复 4.0 之前的行为。
- **约束固定 —— `pinned: true`**：固定的消息原文穿过 `compress()`（按序重新插入到摘要之后），且永不被 `compact()` 清除。固定原子轮次中的任一消息即可保护整个轮次。用于策略与约束文本 —— 压缩丢掉策略文本会把违规率从 0% 拉到 30% 以上（arXiv:2606.22528）。
- **缩减闸门 —— `minShrinkRatio`（默认 `0.5`）**：摘要若未能让被压缩片段缩小 ≥ 50%（按字符长度；仅对 ≥ 2000 字符的片段生效）即视为压缩失败 —— 历史不变，熔断计数 +1。防止压缩死循环。`0` 关闭。
- **`validateCompression`**：摘要后闸门 `(summary, { compressed, kept }) => boolean | Promise<boolean>` —— 返回 `false` 或抛出即拒绝该结果（历史不变，熔断计数 +1）。
- **可逆归档 —— `archive`**：被压缩片段经 `store(serialized, { messageCount }) => uri` 序列化存储，摘要中引用该 URI，因此精确细节始终可取回，而不是靠重要性打分去猜（arXiv:2607.25066、arXiv:2607.08032）。`archive: 'vfs'` 存进 chef 的 VFS。尽力而为：存储失败只记一条警告并跳过引用。
- **`compressionGuidelines`**：注入压缩 prompt 的带编号领域指南，位于 `customCompressionInstructions` 之前。
- **增量 anchored 模式 —— `compressionMode: 'incremental-anchored'`**：维护一份持久的 anchor 文档；每次压缩只把新驱逐的片段合并进去，而不是重写整份摘要（Factory.ai 模式）。通过 `janitor.getAnchorDoc()` 读取；它是 `JanitorSnapshot` 的一部分，`reset()` 会清除。
- **后台调度 —— `compressionScheduling: 'background'`**：第一次超预算的 `compile()` 原样返回历史并在后台启动摘要；之后的 `compress()` 仅在被摘要的片段仍是当前历史的前缀时才换入结果（过期结果被丢弃；`onCompress` 在换入时触发）。把压缩延迟移出主链路（arXiv:2605.08580）。后台状态不进快照。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200_000,
    compressionModel: async (msgs) => callGpt4oMini(msgs),
    triggerRatio: 0.7,       // default — compress "pre-rot"
    minShrinkRatio: 0.5,     // default — reject summaries that barely shrink
    archive: "vfs",          // reversible: full span stored, summary cites a context:// URI
    compressionGuidelines: ["Preserve ticket IDs and SKUs verbatim."],
  },
});

// Pin constraint text — survives compress() verbatim, never cleared by compact()
history.push({
  role: "user",
  content: "NEVER touch prod. Deploy only from CI.",
  pinned: true,
});
```

### 召回工具配方

启用 `archive`（或 VFS 卸载）后，注册内置的 `recall_context` 工具，让模型按需取回归档内容：

```typescript
import { getRecallToolDefinition } from "@context-chef/core";

chef.registerTools([getRecallToolDefinition()]);

// In your agent loop:
if (call.function.name === "recall_context") {
  const { uri } = JSON.parse(call.function.arguments);
  const content = await chef.resolveRecall(uri); // full stored content, or null
  history.push({
    role: "tool",
    tool_call_id: call.id,
    content: content ?? "[not found]",
  });
}
```

## `chef.reportTokenUsage(tokenCount): this`

传入 API 返回的 token 用量。下次 `compile()` 时，如果该值超过 `contextWindow`，则触发压缩。在 tokenizer 路径中，默认取本地计算值和传入值中的较大值；可通过 `usagePreference` 切换为 `'feedFirst'`（信任 API 真值）或 `'tokenizerFirst'`（完全忽略传入值）。

```typescript
const response = await openai.chat.completions.create({ ... });
chef.reportTokenUsage(response.usage.prompt_tokens);
```

## `onBeforeCompress` 钩子

当 token 预算超标时，在 LLM 压缩**之前**触发。返回修改后的 `Message[]` 替换历史，或返回 `null` 让默认压缩继续执行。

```typescript
const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    tokenizer: (msgs) => countTokens(msgs),
    onBeforeCompress: (history, { currentTokens, limit }) => {
      // Example: offload large tool results to VFS before compression
      return history.map((msg) =>
        msg.role === "tool" && msg.content.length > 5000
          ? { ...msg, content: pointer.offload(msg.content).content }
          : msg,
      );
    },
  },
});
```

## 机械压缩（`compact`）

零 LLM 成本的内容清理。在 agent 循环中主动调用以保持上下文精简。

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

切换话题或完成子任务时显式清空历史并重置 Janitor 状态。
