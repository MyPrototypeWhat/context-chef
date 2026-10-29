# Guardrail

`withGuardrails` enforces an XML output contract and sets an assistant prefill so the model's output format can't drift — auto-degraded on providers without native prefill support.

## `chef.withGuardrails(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
  prefillMode: "native", // default; "instruction" never sends a trailing assistant message
});
```

## v4 semantics

Options are now *stored* and applied at `compile()`, so call order relative to `setDynamicState` no longer matters (pre-4.0, calling `setDynamicState` after `withGuardrails` silently discarded the guardrail).

- **Order-independent** — `withGuardrails` before or after `setDynamicState` gives the same output.
- **Replace semantics** — each call **replaces** the previous options (no accumulation).
- **`withGuardrails(null)` clears** the stored options.
- **Own tail message** — the guardrail message lands at the very end of the sandwich as its own message — closest to generation, no longer merged into the dynamic-state message.
- **Persisted** — the stored options are persisted in `ChefSnapshot` (`guardrailOptions`); snapshot/restore round-trips them.

```ts
// v3 — order mattered, this silently dropped the guardrail:
chef.withGuardrails({ enforceXML: { outputTag: 'answer' } });
chef.setDynamicState(state); // guardrail gone

// v4 — same code works in any order; to remove a guardrail, be explicit:
chef.withGuardrails(null);
```

## Provider degradation

With the default `prefillMode: 'native'`, the prefill is a trailing assistant message. The Anthropic target sends it as is; OpenAI and Gemini cannot end on an assistant message, so the adapter degrades the prefill to an instruction folded into the prompt instead. See [Adapters](/guide/adapters) for the full per-provider feature matrix.

## `prefillMode: 'instruction'` <Badge type="tip" text="4.3" />

Claude Sonnet 4.6, Sonnet 5, Sonnet 5.5 and Haiku 5.5 reject a request that ends with a prefilled assistant turn (400: "This model does not support assistant message prefill"). For those models, send the prefill as an instruction:

```ts
chef.withGuardrails({
  enforceXML: { outputTag: 'answer' },
  prefill: '<answer>',
  prefillMode: 'instruction',
});
```

No target gets a trailing assistant message in this mode. An instruction to start the reply with the prefill text goes out together with the enforce-XML instruction, wherever `placement` puts it: a system message by default (on Anthropic, part of the top-level `system`, which stays stable across turns as long as the options don't change), or the last user turn with `placement: 'last_user'`. ContextChef doesn't know which model a payload is for, so the mode is yours to pick.

## Under `appendOnly` <Badge type="tip" text="4.3" />

With [`appendOnly`](/guide/append-only), the guardrail stops moving with the tail:

- `placement: 'system'` makes the instructions the last part of the system prompt. On Anthropic they were already hoisted there; on Chat Completions they no longer move down as the history grows. New options are a `system` checkpoint, like any system prompt change.
- `placement: 'last_user'` sends the instructions as their own user message, appended once when the options change, never merged into your message.
- On OpenAI and Gemini, which have no native prefill, an unset `prefillMode` means `'instruction'`: the prefill instruction goes out once with the other guardrail instructions, instead of being folded into whichever user message is last. An explicit `'native'` is honored and warned once. On Anthropic a native prefill stays a trailing assistant message, as before.
