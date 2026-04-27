---
"@context-chef/ai-sdk-middleware": patch
---

Add `skill` option to inject the active Skill's instructions as a dedicated system message, mirroring the existing `dynamicState` pattern.

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

Skill instructions are inserted as `{ role: 'system', content: skill.instructions }` between the user-provided system messages and the conversation history, matching `@context-chef/core`'s `compile()` ordering (SKILL_SPEC §6.3). Empty or whitespace-only `instructions` are skipped to avoid emitting an empty system message and creating a needless cache breakpoint.

Decoupled from tool restriction: `skill.allowedTools` is annotation only — the middleware does NOT consult it (Claude Code semantics). Wire it to `Pruner.setBlockedTools` yourself in user code if you want skill-driven tool gating.

No breaking changes.
