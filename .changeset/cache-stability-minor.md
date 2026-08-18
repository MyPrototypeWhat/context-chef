---
"@context-chef/core": minor
---

Cache stability: keep the prompt prefix byte-stable across compiles.

- **Static memory tool definitions**: `modify_memory` no longer embeds an enum of live keys and is always emitted (previously it appeared only when keys existed and its schema changed on every key mutation — invalidating the entire provider prompt cache, since tools are the topmost prefix segment). Current keys are still surfaced via the injected memory block; dispatch-time validation is unchanged. `payload.tools` is now deep-equal and reference-stable across compiles.
- **`withGuardrails({ placement: 'last_user' })`**: delivers the enforce-XML instruction through the last-user-message tail injection instead of a system message. On Anthropic, all system-role messages are hoisted into the top-level `system` prefix — the new placement keeps guardrail changes from invalidating cache breakpoints. `prefill` behavior unchanged.
- **`auditAnthropicCachePlacement(payload)`** + **`ChefConfig.cacheAudit`**: deterministic, Anthropic-only audit that flags volatile content (memory data, dynamic state, implicit context, guardrail instructions) sitting inside the cached prefix (at or before the last `cache_control` breakpoint), with a per-issue suggested fix. `cacheAudit: true` warns each distinct issue once per chef instance.
- **`createTokenizerAdapter(encode)`**: zero-dependency glue that turns any `(text) => tokens` encoder (gpt-tokenizer, js-tiktoken, …) into a correct `JanitorConfig.tokenizer` — counting content, thinking, redacted-thinking data, AND tool-call names/arguments (the field most hand-rolled adapters miss). Approximate cross-provider counts are safe under the default `triggerRatio: 0.7` headroom.
- **Skill loader validation**: `SkillLoadResult` gains a `warnings` array; `loadSkill` / `loadSkillsDir(s)` report mechanical issues (missing/thin description, oversized instructions, malformed `allowedTools`, dangling relative resource links) without ever blocking a load.
