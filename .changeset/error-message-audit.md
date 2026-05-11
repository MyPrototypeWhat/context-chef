---
'@context-chef/core': patch
'@context-chef/tanstack-ai': patch
---

Improve error messages at user-facing boundaries.

- `ContextChef.getMemory()`: message previously claimed "requires a memoryStore in ChefConfig" — but the actual config field is `memory: { store: ... }`, not `memoryStore`. Users who hit this error and grep'd the docs found nothing. Now points at the correct field name with a usage hint.
- `tanstack-ai`'s `compactConfig` rejection: previously `Unrecognized toolCalls compact mode: "X"` left users to grep the source for valid values. Now lists all four (`'none'`, `'all'`, `'before-last-message'`, `'before-last-N-messages'`).
- `loadSkill` parse errors: missing `name` / `description` errors now include a minimal SKILL.md frontmatter snippet so the fix is obvious from the error alone. The "indented values are not supported" error now points to inline-array / quoted-string workarounds.

No runtime behavior changes — only error message text. Existing tests asserting on these messages keep passing because the original problem-statement phrases are preserved verbatim and only enriched with examples.

**Consumer-visible side effect for `loadSkill` errors only**: the missing-`name` and missing-`description` messages now contain literal `\n` newlines (the example snippet). Code that does `error.message.split('\n')[0]` to summarize, or relies on these messages being single-line for log formatting, will see the extra lines. Multi-line messages flow through `loadSkillsDir`'s `result.errors[].message` field; if you JSON-serialize that for transport or UI, the newlines become `\\n` and the snippet renders less readably than in a terminal log. The other rewritten messages (`getMemory`, `compactConfig`, "indented values") remain single-line.

