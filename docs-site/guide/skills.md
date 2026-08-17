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

The listing is typically used as the description of a `load_skill` tool, letting the LLM pick a skill itself:

```typescript
const loadSkillTool = {
  name: "load_skill",
  description:
    "Load a skill to specialize for the current task. Available:\n" + listing,
  parameters: {
    skill_name: {
      type: "string",
      enum: chef.getRegisteredSkills().map((s) => s.name),
    },
  },
};

// In your dispatch loop:
if (call.name === "load_skill") {
  chef.activateSkill(call.args.skill_name);
  /* push tool result, continue loop */
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

`activateSkill` injects the instructions as a dedicated system message in the sandwich (after your system prompt, before history). Exactly one is active at a time. Switching re-caches the slot and everything after it — fine for a mode you rarely switch.

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
