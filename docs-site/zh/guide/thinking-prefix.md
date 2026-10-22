# Claude thinking 前缀校验 <Badge type="tip" text="4.3" />

Claude Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5 的每个 thinking 块，签名都覆盖它前面的全部内容：`system`、`tools` 数组和之前所有消息。之后的请求里把这段 thinking 发回去时，API 会检查它前面的内容是不是和模型当时看到的完全一致。

- **2026-08-31 及以后创建的账号**默认检查，对不上直接返回 400：`Invalid signature in thinking block. The block is bound to a different conversation.`
- **更早的账号**只在请求里设置了 `thinking.block_binding.prefix_mismatch_behavior` 时才检查。
- 只有把 thinking 块发回去时才有影响。更早的 Claude 模型、OpenAI 和 Gemini 没有这项检查。

key 的顺序和 JSON 格式不影响结果，只比较值。凡是挪动、修改或删掉被回放的 thinking 前面的内容，都会让校验失败。

## ContextChef 已经保证不变的部分

- **`fromAnthropic` 解析的历史**只要没被改动，就逐字节原样发回：每个 thinking 块、分开的 text 块、并行工具结果、server tool 块和 compaction 签名都不变。见[适配器](/zh/guide/adapters)。
- **放在静态 system 里的 guardrail**（默认的 `placement: 'system'`）跨轮保持不变。不接受原生 prefill 的模型需要 [`prefillMode: 'instruction'`](/zh/guide/guardrail)。
- **`checkPrefixContinuity(prev, next)`** 用来检查你自己的配置：连续 compile 两轮，它会报告第二轮从哪里开始不再重复第一轮。

```ts
import { checkPrefixContinuity } from "@context-chef/core";

const first = await chef.compile({ target: "anthropic" });
// ……发送出去，把回复和下一条 user 消息追加进你的 history……
const second = await chef.compile({ target: "anthropic" });

checkPrefixContinuity(first, second);
// { ok: false, firstDivergence: { path: "messages[3]", before: ..., after: ... } }
```

## 目前仍会改动之前轮次的功能

默认情况下，ContextChef 每次 compile 都把注入渲染在末尾，而且从不写进你的 history。所以下一次 compile 会把它们放到新的末尾，上一轮它们所在的位置就变了：

- dynamic state（`'last_user'`）、两种通道的 announcement、guardrail `placement: 'last_user'`、`'before_history_tail'` 下的 memory（以及 `'after_system'` 下任何 memory 变化，因为它会改动 system prompt）、handoff 提醒、`skillPlacement: 'tail'`；
- 客户端的 overflow（`summarize()`、`anchored()`）：它们的摘要替换掉之前的轮次，而且没有 Anthropic 能验证的签名；
- `compact()` 清理工具结果，以及 offload 一个模型已经完整看过的工具结果。

[`appendOnly`](/zh/guide/append-only) 解决的就是这个问题：chef 添加的内容只追加一次，留在发送时的位置；压缩只落地一次，不再每轮重算；仍然会改写之前轮次的操作都成为被报告的检查点，失效的 thinking 不会再放进请求。[`onDemandCompaction`](/zh/guide/append-only#签名压缩-ondemandcompaction) 是唯一能让后面轮次保留 thinking 的压缩方式。

## 安全网：`drop_block`

如果某个请求带着对不上的 thinking 仍然必须发出去（没打开 `appendOnly`，或者有一处改写你还没找到），可以在请求里让 API 丢掉这些块，而不是拒绝整个请求。这些是你自己请求里的字段，不在 chef 的 payload 里：

```ts
const payload = await chef.compile({ target: "anthropic" });

await client.beta.messages.create({
  ...request, // model、max_tokens、tools，以及来自 `payload` 的 system / messages
  thinking: {
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  },
  betas: [...(payload.betas ?? []), "thinking-binding-controls-2026-08-01"],
});
```

- **适用模型**：Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5。在 Sonnet 5.5 和 Haiku 5.5 上，这个字段只能和 `thinking: { type: "adaptive" }` 一起用；有开源项目报告，和 `between_tools` 或 `disabled` 一起用会返回 400。
- **代价**：被丢掉的推理就没了，模型要重新推一遍。Anthropic 的实测是：低 effort 下只丢一次，输出 token 多 2.5%；max effort 下每轮都丢，最多多 67.1%。不打开 `appendOnly` 时，上面那些尾部注入会让之前每一轮的 thinking 每轮都被丢掉，正好是这个最坏情况。
- **定位**：Anthropic 自己称它为临时方案。真正的解决办法是让 history 只在末尾增长，这正是 `appendOnly` 做的事。
