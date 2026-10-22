# 护栏（Guardrail）

`withGuardrails` 强制 XML 输出契约并设置 assistant prefill，让模型的输出格式不再跑偏 —— 在不支持原生 prefill 的 provider 上自动降级。

## `chef.withGuardrails(options): this`

应用输出格式护栏和可选的 prefill。

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
  prefillMode: "native", // default; "instruction" never sends a trailing assistant message
});
```

## v4 语义

options 现在会被*存储*并在 `compile()` 时应用，因此与 `setDynamicState` 的调用顺序不再重要（4.0 之前，在 `withGuardrails` 之后调用 `setDynamicState` 会静默丢弃护栏）。

- **顺序无关** —— `withGuardrails` 在 `setDynamicState` 之前还是之后调用，输出相同。
- **替换语义** —— 每次调用会**替换**上一次的 options（不累积）。
- **`withGuardrails(null)` 清除**存储的 options。
- **独立尾部消息** —— 护栏消息作为独立消息落在三明治最末端 —— 离生成最近，不再合并进动态状态消息。
- **持久化** —— 存储的 options 会随 `ChefSnapshot` 持久化（`guardrailOptions`），快照/恢复完整往返。

```ts
// v3 — order mattered, this silently dropped the guardrail:
chef.withGuardrails({ enforceXML: { outputTag: 'answer' } });
chef.setDynamicState(state); // guardrail gone

// v4 — same code works in any order; to remove a guardrail, be explicit:
chef.withGuardrails(null);
```

## Provider 降级

在默认的 `prefillMode: 'native'` 下，prefill 是一条尾部 assistant 消息。Anthropic target 原样发送；OpenAI 和 Gemini 不能以 assistant 消息结尾，适配器会把 prefill 降级为折叠进 prompt 的指令。完整的 per-provider 特性矩阵见[适配器](/zh/guide/adapters)。

## `prefillMode: 'instruction'` <Badge type="tip" text="4.3" />

Claude Sonnet 4.6、Sonnet 5、Sonnet 5.5 和 Haiku 5.5 会拒绝最后一轮是 assistant prefill 的请求（400："This model does not support assistant message prefill"）。用这些模型时，把 prefill 改为指令发送：

```ts
chef.withGuardrails({
  enforceXML: { outputTag: 'answer' },
  prefill: '<answer>',
  prefillMode: 'instruction',
});
```

这种模式下，任何 target 都不会出现尾部 assistant 消息。一条「回复必须以 prefill 文本开头」的指令会和 enforce-XML 指令一起，送到 `placement` 指定的位置：默认是一条 system message（在 Anthropic 上属于 top-level `system`，只要 options 不变，跨轮保持稳定），设置 `placement: 'last_user'` 时则是最后一条 user 消息。ContextChef 不知道 payload 是发给哪个模型的，所以模式由你来选。

## `appendOnly` 下 <Badge type="tip" text="4.3" />

打开 [`appendOnly`](/zh/guide/append-only) 后，guardrail 不再跟着末尾移动：

- `placement: 'system'` 把指令放在 system prompt 的最后一部分。在 Anthropic 上它们本来就会被提到那里；在 Chat Completions 上，它们不会再随着 history 变长而往后挪。options 变化和任何 system prompt 变化一样，是一次 `system` 检查点。
- `placement: 'last_user'` 把指令作为一条独立的 user 消息发送，只在 options 变化时追加一次，不会并进你的消息。
- 在没有原生 prefill 的 OpenAI 和 Gemini 上，没设置 `prefillMode` 时等于 `'instruction'`：prefill 指令和其他 guardrail 指令一起只发一次，而不是每轮并进当时的最后一条 user 消息。显式设置 `'native'` 会照办，并 warn 一次。在 Anthropic 上，原生 prefill 和以前一样是末尾的 assistant 消息。
