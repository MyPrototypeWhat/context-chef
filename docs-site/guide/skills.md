# Skill (Behavior Bundle)

A `Skill` is a portable bundle of `(name + description + instructions + ...)` that scopes the agent's behavior for a specific phase or domain — a "mode" you can switch without rewriting your prompt. Activating a skill injects its instructions as a dedicated system message between your system prompt and the memory block. Skills can be inline JS objects or loaded from `SKILL.md` files (same frontmatter shape as Claude Code / Mastra / OpenCode).

```typescript
import { ContextChef, type Skill } from "@context-chef/core";

const planning: Skill = {
  name: "planning",
  description: "Plan changes before editing",
  whenToUse: "When the task is non-trivial and requires multiple steps",
  instructions: "Read code, list affected files, write plan to scratchpad.",
  allowedTools: ["read_file", "grep"], // annotation only — chef does NOT enforce
};

const chef = new ContextChef();
chef.registerSkills([planning]);
chef.activateSkill("planning");
// activateSkill also accepts a Skill object directly, or null to deactivate.

const { messages, meta } = await chef.compile({ target: "openai" });
// messages = [...systemPrompt, { role: 'system', content: planning.instructions }, ...rest]
// meta.activeSkillName === 'planning'
```

## Skill placement — `skillPlacement` <Badge type="tip" text="4.1" />

Where the active skill's instructions are delivered. The default `'after_system'` is the behavior above, bit-for-bit: a dedicated `role: 'system'` message right after your system prompt. Those tokens live in the cacheable prefix — free to re-send — but every activation, switch, or deactivation rewrites that prefix and costs one full cache invalidation.

Under `'tail'` the instructions leave the prefix entirely and lead the tail stitch, wrapped in `<skill_instructions skill="NAME">`:

```typescript
const chef = new ContextChef({ skillPlacement: "tail" });
chef.registerSkills([planning, editing]); // two Skill objects, shaped like the one above
chef.setSystemPrompt([{ role: "system", content: basePrompt }]).setHistory(history);

chef.activateSkill("planning");
const a = await chef.compile({ target: "anthropic" });
chef.activateSkill("editing");
const b = await chef.compile({ target: "anthropic" });

// `a` and `b` are byte-identical up to the last user message — activating,
// switching, and deactivating never touch the cached prefix. Only the tail moved:
//   <skill_instructions skill="editing">…</skill_instructions>
```

The trade-off is real in both directions: `'tail'` re-sends the full instruction text uncached on **every** request; `'after_system'` re-sends nothing but pays a cache miss on **every switch**. Pick `'tail'` when the agent switches modes often relative to how long each mode stays active, `'after_system'` for a mode that is set once and lives for the session.

Placement changes delivery only — `meta.activeSkillName`, `getActiveSkill()`, and snapshot/restore behave identically. In the tail, the skill block leads the fixed stitch order (`<skill_instructions>` → `<memory>` → `<dynamic_state>` → `<implicit_context>` → `<announcements>` → anchor) so the model reads "who you are right now" before the state it applies to, and it does **not** trigger the anchor line on its own — it is self-describing inside its own tag. If `cacheAudit` catches a `<skill_instructions` block at or before your last `cache_control` breakpoint, the breakpoint is too late, not the placement.

## Loading from `SKILL.md`

```typescript
import {
  loadSkill,
  loadSkillsDir,
  loadSkillsDirs,
  renderSkill,
  formatSkillListing,
} from "@context-chef/core";

// Load a single skill file
const skill = await loadSkill("./skills/db-debug/SKILL.md");

// Or scan a directory: each subdir/SKILL.md becomes a Skill (tolerant — bad files surface in `errors`)
const { skills, errors } = await loadSkillsDir("./skills");
chef.registerSkills(skills);

// Or merge several sources at once (e.g. builtin + user + project) — later dirs
// win on name collisions, dirs are realpath-deduped, and an optional `namespace`
// callback can prefix names per source:
const merged = await loadSkillsDirs([builtinDir, userDir, projectDir], {
  precedence: "last-wins",
});

// Render a system-prompt-friendly listing (useful for LLM-driven `load_skill` tool)
const listing = formatSkillListing(skills, { format: "plain" });
```

`SKILL.md` parsing is tolerant: block scalars (`>` folded / `|` literal), `- item` lists, and kebab-case keys (`allowed-tools`, `when-to-use`) all load. Any frontmatter key chef doesn't recognize is preserved verbatim on `skill.metadata` for your host to read — chef never interprets it (the same annotation-only stance as `allowedTools`). A *known* field written in a malformed nested shape throws, so a typo'd `allowed-tools` surfaces instead of silently disabling restrictions.

The listing lets the LLM pick a skill itself via a `load_skill` tool. Keep the tool definition **static** — the listing goes in your system prompt, not the tool description, and `skill_name` is a plain string, not an enum of registered names. Tool schemas sit at the very top of every provider's prompt prefix, so a listing-bearing description or a live-name enum rewrites the schema whenever the skill set changes and invalidates the entire prompt cache (the same reasoning as the static memory tool schemas, 4.1). Unknown names are caught at dispatch time instead — `activateSkill` throws with the available names:

```typescript
const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill to specialize for the current task. " +
    "The available skills are listed in the system prompt.",
  parameters: {
    skill_name: { type: "string", description: "A skill name from the listing." },
  },
};

// The listing lives in the (stable) system prompt:
chef.setSystemPrompt([
  { role: "system", content: `${basePrompt}\n\nAvailable skills:\n${listing}` },
]);

// In your dispatch loop — dispatch-gate, like the memory tools:
if (call.name === "load_skill") {
  try {
    chef.activateSkill(call.args.skill_name);
    /* push success tool result, continue loop */
  } catch (err) {
    /* push String(err) as the tool result — the model self-corrects */
  }
}
```

## Rendering arguments (`renderSkill`)

`renderSkill` substitutes `$ARGUMENTS` / `$0..$N` / `$name` / `${VAR}` placeholders in a skill's instructions and returns a new `Skill` (pure — no I/O). Where the rendered skill is delivered is your call: the system slot (a persistent "mode"), or a host-appended message for progressive disclosure of many skills at once.

```typescript
const triage = await loadSkill("./skills/triage/SKILL.md");

// Fill $ARGUMENTS / $0.. / ${SKILL_DIR} before activating:
chef.activateSkill(renderSkill(triage, { args: "p0 incidents" }));
```

## Two delivery models

chef gives you skill *primitives* (`loadSkill`, `loadSkillsDir`, `loadSkillsDirs`, `renderSkill`, `formatSkillListing`, `activateSkill`). **How and where skill content is delivered is your call.** There are two delivery models.

### 1. Mode (standing instruction) — the system slot

For a skill that should stay active across turns (a "mode"):

```ts
const skill = await loadSkill('skills/triage/SKILL.md');
chef.activateSkill(renderSkill(skill, { args: 'p0 incidents' }));
```

`activateSkill` injects the instructions as a dedicated system message in the sandwich (after your system prompt, before history). Exactly one is active at a time. Switching re-caches the slot and everything after it — fine for a mode you rarely switch, and `skillPlacement: 'tail'` covers the case where you switch often.

### 2. Progressive disclosure — host-appended messages

For pulling skills on demand (the model decides it needs one), advertise the catalogue and let the model request a skill through your own tool:

```ts
systemPrompt += formatSkillListing(chef.getRegisteredSkills());

// inside your load-skill tool handler:
const skill = await loadSkill(pathFor(name));
const rendered = renderSkill(skill, {
  args,
  vars: { SKILL_DIR: skill.baseDir! },
  includeBaseDir: true,
});
// append as a hidden user message (visible to the model, hidden from the user):
appendMessage({ role: 'user', isMeta: true, content: rendered.instructions });
```

Because each pull is a separate appended message, **multiple skills coexist naturally** — there is no skill stack in chef and none is needed. Appending also never mutates the cached prefix, so it is cache-friendly.

## Referenced files

A skill body may point at sibling files (`@./schemas/foo.json`, `./templates/x.md`). chef does **not** read or inline them — that would balloon tokens and tie prompt assembly to the filesystem. Instead, `renderSkill({ includeBaseDir: true })` writes the skill's directory into the prompt, and your agent reads referenced files on demand via its own file-read tool. `skill.baseDir` is also available directly if you want to resolve paths yourself.

## Multi-source loading

```ts
const { skills, errors } = await loadSkillsDirs(
  [builtinDir, userDir, projectDir],
  { precedence: 'last-wins' },
);
chef.registerSkills(skills);
```

Later directories win on name collisions; pass a `namespace` callback to prefix names per source instead. Directories are de-duplicated by realpath. Loading is tolerant — a bad file is collected in `errors`, never thrown.

## Further reading

For the design rationale (Skill ⊥ Pruner decoupling, SKILL.md frontmatter shape, mode-wiring recipes, LLM-driven skill loading, reference files) see [`SKILL_SPEC.md`](https://github.com/MyPrototypeWhat/context-chef/blob/main/SKILL_SPEC.md). For argument rendering, multi-source loading, and the two delivery models, see [`docs/skill-interop-design.md`](https://github.com/MyPrototypeWhat/context-chef/blob/main/docs/skill-interop-design.md).
