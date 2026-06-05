# Skill Recipes

chef gives you skill *primitives* (`loadSkill`, `loadSkillsDir`, `loadSkillsDirs`,
`renderSkill`, `formatSkillListing`, `activateSkill`). **How and where skill
content is delivered is your call.** There are two delivery models.

## 1. Mode (standing instruction) — the system slot

For a skill that should stay active across turns (a "mode"):

```ts
const skill = await loadSkill('skills/triage/SKILL.md');
chef.activateSkill(renderSkill(skill, { args: 'p0 incidents' }));
```

`activateSkill` injects the instructions as a dedicated system message in the
sandwich (after your system prompt, before history). Exactly one is active at a
time. Switching re-caches the slot and everything after it — fine for a mode you
rarely switch.

## 2. Progressive disclosure — host-appended messages

For pulling skills on demand (the model decides it needs one), advertise the
catalogue and let the model request a skill through your own tool:

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

Because each pull is a separate appended message, **multiple skills coexist
naturally** — there is no skill stack in chef and none is needed. Appending also
never mutates the cached prefix, so it is cache-friendly.

## References

A skill body may point at sibling files (`@./schemas/foo.json`,
`./templates/x.md`). chef does **not** read or inline them — that would balloon
tokens and tie prompt assembly to the filesystem. Instead, `renderSkill({
includeBaseDir: true })` writes the skill's directory into the prompt, and your
agent reads referenced files on demand via its own file-read tool. `skill.baseDir`
is also available directly if you want to resolve paths yourself.

## Multi-source loading

```ts
const { skills, errors } = await loadSkillsDirs(
  [builtinDir, userDir, projectDir],
  { precedence: 'last-wins' },
);
chef.registerSkills(skills);
```

Later directories win on name collisions; pass a `namespace` callback to prefix
names per source instead. Directories are de-duplicated by realpath. Loading is
tolerant — a bad file is collected in `errors`, never thrown.
