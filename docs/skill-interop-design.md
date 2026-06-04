# Skill Primitive — Interop & Delivery Design

**Status:** proposal · companion to [`SKILL_SPEC.md`](../SKILL_SPEC.md)
**Date:** 2026-06-04
**Scope:** additive evolution of Module B (Skill). The shipped v1 API (`Skill`, `loadSkill`, `loadSkillsDir`, `formatSkillListing`, `ContextChef.activateSkill`) stays. Nothing here removes or breaks it.

---

## 1. Motivation

Mature agent runtimes converge on a richer skill model than chef's v1. Ingesting `SKILL.md` files authored for those runtimes, and matching their ergonomics, exposes six gaps:

| # | Gap | chef today | Common elsewhere |
|---|---|---|---|
| 1 | Argument substitution | body injected verbatim (`middleware.ts:204` `content: resolved.instructions`) | `$ARGUMENTS` / `$0..$N` / `${VAR}` rendered into the body |
| 2 | Multiple skills in context | single slot (`_activeSkill`, principle #8) | N skills coexist as N appended messages |
| 3 | Frontmatter tolerance | minimal parser **throws** on indentation / block scalar / nesting (`skill/index.ts:204-211`) | full frontmatter parses, extra fields kept |
| 4 | Multi-source loading | `loadSkillsDir` scans one dir | builtin + user + project merged |
| 5 | Declarative metadata | unknown keys dropped | extra fields (`argument-hint`, `version`, `model`, …) retained |
| 6 | Reference resolution | `baseDir` stored, not loaded (`skill/index.ts:29`) | base-dir surfaced in the prompt; the agent reads referenced files on demand via its own file-read tool |

**The framing that resolves all six:** chef is a general-purpose context library, not built for any single consumer. chef's job is to expose the *primitives* this behavior is built from — and to **not hardcode delivery**, because delivery (where skill content lands, when, via what message) is the host's operation.

### The core architectural realization

Skill content can be delivered under two different models, for two different skill *semantics*:

| | chef (system slot) | append model |
|---|---|---|
| Content | raw `skill.instructions` (`middleware.ts:204`) | rendered body + `Base directory: …` header |
| Position | **before** history, mid-sandwich (§6.3) | **after** history, appended |
| Role | `system` | a `user` message flagged machine-generated (hidden from the user, visible to the model) |
| Rendering | none | `$ARGUMENTS` / `${SKILL_DIR}` / `${SESSION_ID}` substituted |
| Switch cost | replacing the single slot (`index.ts:551`) re-caches everything after it | append never mutates the prefix → cache-safe |
| Semantics | **mode / standing instruction** ("enter PDF-editing mode") | **progressively pulled content** ("the model decided it needs `pdf`") |

Neither model is wrong. The system slot is *better* for a rarely-switched mode (authoritative, persistent, one breakpoint). The append model is *better* for progressive disclosure of many skills (cache-friendly, N coexist). chef currently **hardcodes the first**, which forces a host that wants the second to bypass chef's skill API entirely — which is what happens in practice.

> §6.5 already pushes *listing placement* and the load-skill tool to the host ("developer chooses where", "developer-side recipe"). This proposal extends that same philosophy to the **active-instructions delivery** so the stance is consistent.

---

## 2. Principles — what holds, what refines

**Unchanged** (from `SKILL_SPEC.md` §2): Skill ⊥ Pruner · skills are plain objects · `allowedTools` is annotation-only · cache-preserving by default · no agent-framework drift · no magic discovery.

**Refined:**

- **#8 "Single active skill."** chef still has **no skill stack** — `activateSkill` remains exactly one slot. Multi-skill-in-context is *not* a chef API; it is a property of host-driven append delivery (§3.3). We are not adding stack / ordering / precedence / lifecycle semantics. "Multiple active" = "the host appended several rendered skills as messages."
- **New: delivery is the host's.** chef provides (a) the system-slot convenience for the *mode* semantics, and (b) delivery-agnostic primitives (parse, render, listing) so the host can implement progressive disclosure itself. chef does not own where skill content lands.

---

## 3. Changes

Four units, all additive, independent PRs in any order. Phase 1 is the interop-critical core; Phase 2 is one utility.

### 3.1 Lenient + rich frontmatter, with metadata passthrough — Phase 1 (#3 + #5)

Today `parseYamlSubset` throws on any indented line (`skill/index.ts:204-211`), so an externally-authored `SKILL.md` with a `description: >` block scalar or extra fields fails to load. **Decision (§5 Q-A): extend the hand-rolled parser, stay zero-dependency.** A market scan (2026-06) found exactly one tiny + zero-dep + block-scalar lib (`yaml.min`), but it is ~2 months old at v1.0.0 with negligible adoption — too much bus-factor risk for a *core* dependency that every chef consumer inherits. Every full YAML parser also coerces scalars (`version: 1.0` → number), which erodes metadata fidelity. Hand-rolling keeps core's "only `zod`" footprint and lets us keep **all scalars as strings (no coercion)** — byte-exact passthrough.

**Requirements**
- Extend the parser to accept block scalars (`>` folded, `|` literal), in addition to the existing quoted strings and inline arrays. Scope is `SKILL.md` frontmatter only — **no** anchors, multi-doc, or nested mappings. A block scalar runs while following lines are indented past the key; dedent (or EOF) ends it. Folded `>` joins lines with spaces (blank line → newline); literal `|` preserves newlines.
- **No type coercion.** Every scalar is kept as a string. There is no Norway problem and no `version: 1.0`→number surprise; `metadata` values are exactly what the author wrote (modulo block-scalar folding). Known fields are already strings/arrays, so this is also simpler than coercing.
- Stay lenient: an unrecognized shape (e.g. a nested mapping) is skipped rather than throwing, so one odd key never blocks a load. `loadSkill` still throws only on no-closing-fence or missing `name`/`description`.
- Keep typed known fields: `name`, `description`, `whenToUse`, `allowedTools`.
- Accept the kebab-case spelling as aliases for the known fields (`allowed-tools` → `allowedTools`, `when-to-use` → `whenToUse`) so externally-authored files map cleanly. This is a fixed requirement, not an open question.
- **Collect every other key into `skill.metadata: Record<string, unknown>`, uninterpreted.** This is the same "store as annotation, chef does not consult it" stance already taken with `allowedTools`. Fields like `argument-hint`, `version`, `user-invocable`, `disable-model-invocation`, `model`, `paths` all land in `metadata`; chef neither reads nor enforces them. The host reads what it cares about.

**Type change**
```ts
export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  instructions: string;
  allowedTools?: string[];
  baseDir?: string;
  /**
   * Unknown frontmatter keys, verbatim (raw key spelling). chef NEVER reads
   * this — it is host-facing annotation, the same stance as `allowedTools`.
   */
  metadata?: Record<string, unknown>;
}
```

### 3.2 `renderSkill` — substitution primitive — Phase 1 (#1, and #6's templating)

A pure function that produces a *rendered* copy of a skill's instructions. It covers the two substitution families common to skill runtimes — argument substitution and `${VAR}` templating — minus the host-only parts.

```ts
export interface RenderSkillOptions {
  /** Raw argument string. Drives the $-family below. Parsed quote-aware
   *  (quotes respected; whitespace-split fallback). */
  args?: string;
  /** Positional→name map for $name placeholders; host supplies (e.g. from metadata). */
  argumentNames?: string[];
  /** Key→value map for ${NAME} template placeholders (e.g. SKILL_DIR, SESSION_ID). */
  vars?: Record<string, string>;
  /** Prepend `Base directory for this skill: {baseDir}\n\n`. Default false. */
  includeBaseDir?: boolean;
  /** When `args` is non-empty and no $-placeholder matched, append `\n\nARGUMENTS: {args}`. Default true. */
  appendArgsIfNoPlaceholder?: boolean;
}

export function renderSkill(skill: Skill, opts?: RenderSkillOptions): Skill;
```

**Locked semantics (§5 Q-B):**
- `$ARGUMENTS` → the full raw `args` string.
- `$ARGUMENTS[i]` and shorthand `$i` → **0-based** parsed token `i` (`$0` = first arg); missing → `''`.
- `$name` → positional value via `argumentNames` (`argumentNames[k]` ← token `k`); missing → `''`. Matched on word boundary (`$name` but not `$nameX` / `$name[`).
- `${NAME}` → `vars[NAME]` when present; **left untouched** otherwise (predictable).
- `args === undefined` → the $-family is left untouched entirely; `args === ''` → $-placeholders resolve to empty.
- **No escape mechanism** in v1: a literal `$ARGUMENTS` in output is not expressible. Documented limitation.

> The `$0`-based positional indexing matches the de-facto `$ARGUMENTS[0]` convention rather than shell's `$1`-first; it is internally consistent (`$0` ≡ `$ARGUMENTS[0]`).

**Explicitly not chef's job** (host operation):
- inline shell execution (`` !`cmd` ``) in skill bodies.
- slash parsing and deciding where `args` come from.
- Supplying `SESSION_ID` (chef has no session) — the host passes it via `vars` if `${SESSION_ID}` is used. Likewise `argumentNames` is host-supplied (chef does not read `metadata` to find it).

The host then delivers the rendered skill via the system slot (`activateSkill(rendered)`) **or** by appending it as a message it builds itself.

### 3.3 Delivery decoupling — Phase 1 (docs + contract) (#2, #6)

- `activateSkill` + the middleware system slot are **kept**, re-documented as the **"mode" convenience** for standing-instruction skills.
- The parse / `renderSkill` / `formatSkillListing` primitives are **delivery-agnostic**. The progressive-disclosure recipe (no new API):
  1. advertise `formatSkillListing(chef.getRegisteredSkills())` in the system prompt;
  2. the model pulls a skill via the host's own load-skill tool;
  3. host: `loadSkill → renderSkill(skill, { args, includeBaseDir: true }) → wrap as a hidden user message → append`;
  4. multiple pulls coexist naturally; no stack API.
- **References stay lazy (#6).** chef does **not** inline referenced files. `renderSkill({ includeBaseDir: true })` surfaces the skill's directory in the prompt; the agent reads referenced files on demand through its own file-read tool. This matches how mature runtimes handle references and keeps chef out of the filesystem-at-render-time business. A short recipe documents this.
- **No `skillToMessage` helper.** Wrapping a string in a message with a chosen role/hidden-flag is a one-liner and squarely host territory; provide it as a recipe in docs, not API surface.

### 3.4 `loadSkillsDirs` — Phase 2 (#4)

Multi-source merge utility. Still **no auto-discovery** — the caller passes the directory list, preserving principle #7.

```ts
export interface LoadSkillsDirsOptions {
  /** 'last-wins' (default) or 'first-wins' on name collision. */
  precedence?: 'last-wins' | 'first-wins';
  /** Prefix merged skill names as `${namespace}:${name}` per source. Optional. */
  namespace?: (dir: string) => string | undefined;
}

/** Scan multiple dirs, dedup by realpath, resolve name collisions by precedence,
 *  optionally namespace. Tolerant: aggregates per-dir errors like loadSkillsDir. */
export function loadSkillsDirs(
  dirs: string[],
  opts?: LoadSkillsDirsOptions,
): Promise<SkillLoadResult>;
```

---

## 4. Cache & snapshot impact

- `renderSkill` runs **before** delivery (pure, pre-activation). The system-slot cache behavior is unchanged; the append path is cache-friendly as analyzed in §1.
- `metadata` is not persisted in the snapshot — `ContextChefSnapshot` already stores `skillInstructions` verbatim (§6.4), and metadata is host-read annotation. No snapshot schema change.
- No change to `compile()` ordering or the `activeSkillName` meta field.

---

## 5. Decisions (resolved)

- **Q-A — parser strategy → extend hand-rolled, zero dependency.** Add block-scalar (`>` / `|`) support to the existing parser; keep all scalars as strings (no coercion). The only tiny+zero-dep alternative (`yaml.min`) is too new (v1.0.0, ~2 months) for a core dep; full YAML libs coerce scalars and are larger. `yaml.min` documented as a fallback if block-scalar handling proves fiddlier than budgeted.
- **Q-B — `renderSkill` semantics** (locked in 3.2): `$ARGUMENTS` = full raw string; `$ARGUMENTS[i]` / `$i` 0-based, missing → `''`; `$name` via `argumentNames`; `${NAME}` substituted when provided else left untouched; `args` undefined → $-family untouched; **no `$` escaping in v1**.
- **Q-C — references stay lazy; no eager inlining in chef.** `renderSkill({includeBaseDir})` surfaces the directory; the host/agent reads files via its own tool. `loadSkillsDirs` (3.4) ships this cycle.
- **Q-D — metadata keys → raw.** Unknown keys land in `metadata` with their original frontmatter spelling (`argument-hint` stays `argument-hint`). Known-field kebab aliases handled in 3.1.
- **Q-E — `loadSkillsDirs` defaults → `last-wins` precedence, realpath dedup, namespace opt-in** (off by default). Plan may refine the namespace callback shape.

---

## 6. Phasing

All units ship this cycle as independent PRs (any order):

**Phase 1 (core, interop):**
1. Rich frontmatter parse — extend the zero-dep parser for block scalars + `metadata` field + kebab aliases (3.1).
2. `renderSkill` (3.2).
3. Delivery-decoupling docs + recipes, incl. the lazy-reference note (3.3).

**Phase 2 (utility):**
4. `loadSkillsDirs` (3.4).

---

## 7. Out of scope (reaffirmed)

Everything in `SKILL_SPEC.md` §8 still stands. This proposal additionally keeps these host-side, never in chef:

| Stays in the host | Why |
|---|---|
| inline shell execution in skill bodies | side-effecting; runtime concern |
| slash parsing / arg sourcing | host decides where args come from |
| appending skills as messages / hidden-message framing | delivery is the host's operation |
| the agent tool loop, the load-skill tool | runtime, not context-assembly |
| reading referenced files (`@path`, relative refs) | the agent's file-read tool does this; chef only exposes `baseDir` |
| compaction survival of pulled skills | host/runtime state |
| skill stack / ordering / conflict resolution | framework territory; multi falls out of append delivery |
| interpreting `model` / `user-invocable` / `disable-model-invocation` | passthrough in `metadata`; host reads |

---

## 8. Walkthroughs

**W1 — mode-style skill with arguments (system slot)**
```ts
const skill = await loadSkill('skills/triage/SKILL.md');
chef.activateSkill(renderSkill(skill, { args: 'p0 incidents' }));
// → rendered instructions injected as the mid-sandwich system message
```

**W2 — progressive disclosure (host-driven append)**
```ts
// system prompt advertises the catalogue
systemPrompt += formatSkillListing(chef.getRegisteredSkills());

// host load-skill tool, when the model calls it:
const skill = await loadSkill(pathFor(name));
const rendered = renderSkill(skill, {
  args,
  vars: { SKILL_DIR: skill.baseDir! },
  includeBaseDir: true,
});
appendHiddenUserMessage(rendered.instructions); // host wraps + appends
// the agent reads any referenced files itself via its file-read tool
// multiple pulls coexist; chef has no stack and needs none
```

**W3 — ingest an externally-authored SKILL.md**
```yaml
---
name: pdf
description: >
  Multi-line folded description that the v1 parser would have rejected.
argument-hint: "[file]"
version: 2.1.0
allowed-tools: [Read, Bash]
---
```
Loads without throwing. `description` is the folded string; `argument-hint` and `version` are in `skill.metadata` (raw keys, string values); `allowed-tools` maps to `allowedTools`. chef interprets none of the extras.
