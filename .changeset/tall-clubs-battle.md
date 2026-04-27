---
"@context-chef/tanstack-ai": patch
---

Add `skill` option to inject the active Skill's instructions, mirroring the existing `dynamicState` pattern.

```typescript
contextChefMiddleware({
  contextWindow: 128_000,
  skill: planningSkill,                  // static
  // or
  skill: () => myActiveSkill,           // dynamic — re-evaluated per request
  // or
  skill: async () => fetchActiveSkill(), // async resolver supported
});
```

Skill instructions are appended to the TanStack `systemPrompts: string[]` channel (the idiomatic place for additional system instructions), positioned after user system prompts and before any `dynamicState` injection, matching `@context-chef/core`'s `compile()` ordering (SKILL_SPEC §6.3). Empty or whitespace-only `instructions` are skipped to avoid emitting an empty entry and creating a needless cache breakpoint.

Decoupled from tool restriction: `skill.allowedTools` is annotation only — the middleware does NOT consult it (Claude Code semantics). Wire it to `Pruner.setBlockedTools` yourself in user code if you want skill-driven tool gating.

No breaking changes.
