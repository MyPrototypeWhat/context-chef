---
"@context-chef/core": minor
---

`withGuardrails` takes `prefillMode: 'native' | 'instruction'`.

Claude Sonnet 4.6, Sonnet 5, Sonnet 5.5 and Haiku 5.5 reject a request whose last message is a prefilled assistant turn (400: "This model does not support assistant message prefill"). On the Anthropic target, `prefill` was always sent that way, so it could not be used with those models.

- `'native'` (default, unchanged): the prefill is a trailing assistant message the model continues from; OpenAI and Gemini still turn it into an instruction on their own.
- `'instruction'`: no trailing assistant message on any target. An instruction to start the response with the prefill text goes out with the enforce-XML instruction, wherever `placement` puts it: in a system message by default, which on Anthropic stays in the stable top-level `system` across turns, or in the last user turn with `placement: 'last_user'`.

ContextChef does not know which model a payload is for, so the mode is yours to set. The `announce()` docs also note two behaviors Anthropic documents for its newest models and that are not yet verified against the API: Sonnet 5.5 and Haiku 5.5 may ignore a system message placed right after a tool result, and on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 an announcement re-rendered at the new tail changes an earlier turn, which fails the thinking-block check when that turn's thinking is replayed.
