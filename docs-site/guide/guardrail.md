# Guardrail

`withGuardrails` enforces an XML output contract and sets an assistant prefill so the model's output format can't drift — auto-degraded on providers without native prefill support.

## `chef.withGuardrails(options): this`

Applies output format guardrails and optional prefill.

```typescript
chef.withGuardrails({
  enforceXML: { outputTag: "final_code" }, // wraps output rules in EPHEMERAL_MESSAGE
  prefill: "<thinking>\n1.", // trailing assistant message (auto-degraded for OpenAI/Gemini)
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

Prefill is a trailing assistant message. The Anthropic target supports it natively; OpenAI and Gemini cannot end on an assistant message, so the adapter degrades the prefill to a `[System Note]` instruction folded into the prompt instead. See [Adapters](/guide/adapters) for the full per-provider feature matrix.
