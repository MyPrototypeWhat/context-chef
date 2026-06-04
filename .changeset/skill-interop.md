---
"@context-chef/core": minor
---

Skill primitive — interop & delivery (additive, no breaking changes):

- Frontmatter parsing now accepts block scalars (`>` folded / `|` literal) and
  block-sequence values (`- item` lists) instead of throwing on indentation.
  Still zero-dependency (hand-rolled, strings-only — no YAML type coercion).
- Unknown frontmatter keys pass through verbatim on `Skill.metadata` (chef does
  not interpret them). Kebab-case aliases `allowed-tools` / `when-to-use` map to
  `allowedTools` / `whenToUse`.
- New `renderSkill(skill, opts)` — pure `$ARGUMENTS` / `$0..$N` / `$name` /
  `${VAR}` substitution with optional base-directory header.
- New `loadSkillsDirs(dirs, opts)` — multi-source merge with precedence,
  realpath dedup, and optional namespacing.

Delivery stays host-side; referenced files are read by the host/agent, not
inlined by chef. See docs/skill-interop-design.md.
