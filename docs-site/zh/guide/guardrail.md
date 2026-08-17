# 护栏（Guardrail）

`withGuardrails` 强制 XML 输出契约并设置 assistant prefill，让模型的输出格式不再跑偏 —— 在不支持原生 prefill 的 provider 上自动降级。

## `chef.withGuardrails(options): this`

应用输出格式护栏和可选的 prefill。

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
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

prefill 是一条尾部 assistant 消息。Anthropic target 原生支持；OpenAI 和 Gemini 不能以 assistant 消息结尾，适配器会把 prefill 降级为折叠进 prompt 的 `[System Note]` 指令。完整的 per-provider 特性矩阵见[适配器](/zh/guide/adapters)。
