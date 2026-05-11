---
'@context-chef/core': patch
'@context-chef/tanstack-ai': patch
---

Error message UX patch — clearer text, consistent empty-registry rendering, and one real config-field-name fix.

**Real bug fix**

- `ContextChef.getMemory()`: previously claimed `requires a memoryStore in ChefConfig`, but the actual config field is `memory: { store: ... }` — not `memoryStore`. Users hitting this error and grep'ing the docs found nothing. Now points at the correct field name plus a hint about the three built-in store implementations (`InMemoryStore`, `VFSMemoryStore`, custom `MemoryStore`).

**Clearer error text**

- `tanstack-ai`'s `compactConfig` rejection: previously `Unrecognized toolCalls compact mode: "X"` left users to grep the source for valid values. Now lists all four (`'none'`, `'all'`, `'before-last-message'`, `'before-last-N-messages'`) with the N-substitution example.
- `loadSkill` parse errors: missing `name` / `description` errors now embed a minimal SKILL.md frontmatter snippet so the fix is obvious from the error alone. The "indented values are not supported" error now points to inline-array / quoted-string workarounds. The missing-`description` snippet reuses the user's parsed `name` (sanitized: long names or `---` literals fall back to `my-skill` to avoid generating a malformed example).

**Consistent empty-registry rendering**

Five throw sites across the library now render an empty options list as `(none)` rather than producing `Available: ` (trailing empty space) or `Registered: [].` — matches the pattern already used by `ContextChef.activateSkill`:

- `Pruner.extractToolkit` — empty toolkit registry
- `Pruner.resolveNamespace` (unknown namespace) — empty namespace registry
- `Pruner.resolveNamespace` (unknown action) — namespace with no tools
- `AdapterRegistry.get` — empty adapter registry

**Consumer-visible side effect for `loadSkill` errors only**

The missing-`name` and missing-`description` `loadSkill` errors now contain literal `\n` newlines (the example snippet). Code that does `error.message.split('\n')[0]` to summarize, or relies on these messages being single-line for log formatting, will see the extra lines. Multi-line messages flow through `loadSkillsDir`'s `result.errors[].message` field; if you JSON-serialize that for transport or UI, the newlines become `\\n` and the snippet renders less readably than in a terminal log. The other rewritten messages (`getMemory`, `compactConfig`, `Pruner` / `AdapterRegistry` empty fallbacks, "indented values") all remain single-line.
