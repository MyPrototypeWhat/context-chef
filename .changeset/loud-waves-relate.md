---
"@context-chef/core": patch
---

Add Pruner blocklist + Skill primitive (two independent additions, no breaking changes).

**Pruner blocklist** — `setBlockedTools(names)` + `checkToolCall(call)` for runtime tool restriction (permission, environment, sandbox, rate-limiting). KV-cache preserved across blocklist changes; enforcement happens at dispatch time, not by mutating the compiled `tools` array.

**Skill primitive** — SKILL.md-compatible behavior bundle. `loadSkill` / `loadSkillsDir` / `formatSkillListing` load and render skills; `chef.registerSkills` + `chef.activateSkill` activate them, injecting instructions as a dedicated `{ role: 'system' }` message between the user system prompt and the memory block.

**Decoupled by design** — `activateSkill` does NOT touch the Pruner. `Skill.allowedTools` is annotation only (Claude Code semantics); wire it to `setBlockedTools` yourself if you want skill-driven tool gating. See `SKILL_SPEC.md` for the full design and recipes.

New public API: `Pruner.setBlockedTools` / `Pruner.getBlockedTools` / `ContextChef.checkToolCall` / `ToolCallCheckResult` / `Skill` / `SkillLoadResult` / `FormatSkillListingOptions` / `loadSkill` / `loadSkillsDir` / `formatSkillListing` / `ContextChef.registerSkills` / `ContextChef.getRegisteredSkills` / `ContextChef.activateSkill` / `ContextChef.getActiveSkill`. New snapshot fields: `ChefSnapshot.activeSkillName` / `ChefSnapshot.skillInstructions`. New meta field: `CompileMeta.activeSkillName`.
