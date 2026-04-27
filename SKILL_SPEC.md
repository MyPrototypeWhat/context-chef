# Skill Primitive — Design Spec

**Status**: Draft (design phase, not yet implemented)
**Owner**: ContextChef core
**Tracking**: extends TODO.md "Pruner — State-Scoped Tool Whitelists" (semantically replaced)

---

## 1. Motivation

As agent skill prompts grow past ~200 lines, agents drift: forgetting steps, calling tools meant for other phases, skipping required states. Industry has converged on a **Skill** primitive — a portable bundle of `(name + description + instructions + ...)` that scopes behavior for a phase or domain.

Separately, real applications need a way to **block specific tools** at runtime — for permission control, environment safety, sandboxing, rate-limiting, or feature flags. This is a different concern from skills.

This spec covers **two completely independent additions** to ContextChef:

1. **Skill** — a behavior-bundle primitive (instructions + metadata)
2. **Pruner blocklist** — a runtime tool-call gate (= original TODO #5, redesigned)

Each ships independently. Neither depends on the other. Either can be used alone.

### Industry Survey (background)

| System | Skill format | Tool restriction model |
|---|---|---|
| Claude Code | SKILL.md frontmatter | `allowed-tools` is **additive permission grant** (joined into `alwaysAllowRules`, NOT a hard whitelist) — see `SkillTool.ts:794-800` |
| OpenCode | SKILL.md frontmatter | Skill carries no tool field; restriction lives at agent-level `permission` matrix (hard filter) |
| open-agents | SKILL.md frontmatter | `allowed-tools` field exists but is **dead code** — declared, never enforced |
| Mastra | SKILL.md + assets | Skill is fully decoupled from tools; tools live independently in Workspace config |

**Key takeaway**: in Claude Code (the most influential implementation), `allowedTools` is **NOT a hard whitelist** — it just pre-approves tools to skip user permission prompts. ContextChef adopts the same semantics: `Skill.allowedTools` is annotation only, chef does NOT enforce it. Hard tool restriction is the Pruner's job, exposed as a separate `setBlockedTools` API.

---

## 2. Design Principles

1. **Skill ⊥ Pruner** — Skill (behavior bundle) and Pruner blocklist (tool gate) are fully independent modules. Neither imports the other; neither knows the other exists.
2. **Pruner uses blocklist, not allowlist** — `setBlockedTools(names)` blocks specific tools. Default is permissive (no block = all allowed). Allowlist semantics ("only X, Y, Z") are policy that lives in user code, not in Pruner.
3. **Skills are plain JS objects** — `SKILL.md` files are a distribution format, not a requirement. Inline `Skill` objects are first-class.
4. **`Skill.allowedTools` is annotation only** — chef does NOT read this field for enforcement. It exists to align with Claude Code conventions and to give developers a place to attach tool hints. If a developer wants enforcement, they call Pruner separately.
5. **Cache-preserving by default** — Pruner blocklist does NOT modify the compiled tools array. `compile()` always returns the full tool set; `checkToolCall` is the dispatch-time gate. KV cache survives blocklist changes.
6. **Decoupled from tool execution** — chef does not wrap or intercept tool execute functions. Developer adds one line `chef.checkToolCall(call)` in their dispatch loop.
7. **No magic discovery** — no hardcoded `~/.context-chef/skills/` lookup. Developer calls `loadSkillsDir(myPath)`.
8. **Single active skill** — no skill stack. v1 supports one active skill at a time.
9. **No agent-framework drift** — no skill chaining, no LLM-driven auto-activation, no path-conditional triggers.

---

## 3. Architecture (Two Fully Independent Modules)

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│ Module A: Pruner Blocklist       │    │ Module B: Skill                  │
│ (= original TODO #5, redesigned) │    │ (new primitive)                  │
│                                  │    │                                  │
│ Public API:                      │    │ Public API:                      │
│  Pruner.setBlockedTools(names)   │    │  Skill type                      │
│  Pruner.getBlockedTools()        │    │  loadSkill / loadSkillsDir       │
│  ContextChef.checkToolCall(call) │    │  formatSkillListing              │
│                                  │    │  ContextChef.registerSkills      │
│                                  │    │  ContextChef.activateSkill       │
│                                  │    │  ContextChef.getActiveSkill      │
│                                  │    │                                  │
│ Cache impact:                    │    │ Cache impact:                    │
│   NONE on compile() output       │    │   skill switch invalidates       │
│   (gate is dispatch-side only)   │    │   instructions slot only         │
└──────────────────────────────────┘    └──────────────────────────────────┘
       ↑                                          ↑
       │  No imports                              │  No imports
       │  No references                           │  No references
       └──────────────────────────────────────────┘
                 Modules do not know
                 the other exists.
```

**Composition is user-land code only.** If a developer wants the Skill's `allowedTools` annotation to actually restrict tool execution, they wire it themselves:

```typescript
// User code — chef does NOT do this automatically
const skill = chef.getActiveSkill();
const allToolNames = chef.getPruner().getAllTools().map(t => t.name);
chef.getPruner().setBlockedTools(
  allToolNames.filter(name => !skill.allowedTools?.includes(name))
);
```

This is mechanism not policy at the strictest sense: chef provides both pieces, the developer decides if and how they connect.

---

## 4. Module A — Pruner Blocklist (= TODO #5)

This module is independent of Skill. Its purpose is runtime tool-call gating for any policy: permission, environment, sandbox, rate-limiting, feature flags, or manual mode-switching.

### 4.1 API

```typescript
class Pruner {
  // PUBLIC. Sets the blocklist: which tools are forbidden right now.
  // Pass [] to clear (no tools blocked).
  // Does NOT mutate the compiled tools array — gate is dispatch-side only.
  setBlockedTools(names: string[]): this;

  // PUBLIC. Read-only inspector.
  getBlockedTools(): string[];   // returns [] if nothing is blocked
}

class ContextChef {
  // PUBLIC. The interception checkpoint developers call in their agent loop.
  checkToolCall(toolCall: { name: string }): { allowed: boolean; reason?: string };
  //
  // Implementation:
  //   const blocked = this.getPruner().getBlockedTools();
  //   if (blocked.includes(toolCall.name)) {
  //     return { allowed: false, reason: `Tool "${toolCall.name}" is blocked.` };
  //   }
  //   return { allowed: true };
}
```

That's the full surface. No allowlist, no `pruneByX` methods affecting compile output, no state-machine vocabulary.

### 4.2 Cache Behavior

**`setBlockedTools` does NOT mutate the compiled `tools` array** in `compile()` output. The LLM continues to see the full tool set. Enforcement happens at dispatch time via `checkToolCall`.

This means:
- KV cache is preserved across blocklist changes
- The LLM may attempt to call a blocked tool (it doesn't know it's blocked); `checkToolCall` returns the rejection, and the developer surfaces it as a tool error message for the LLM to react to next turn

If a developer wants the LLM to know about blocks proactively (avoid the wasted-turn cost), they should inject a hint themselves — typically via `chef.setDynamicState({ blocked_tools: [...] })` with `placement: 'last_user'`. Chef does NOT do this automatically.

### 4.3 Use Cases

```typescript
// Permission: read-only user
if (!user.canWrite) {
  chef.getPruner().setBlockedTools(['write_file', 'edit_file', 'delete_file']);
}

// Environment: prod blocks destructive
if (process.env.NODE_ENV === 'production') {
  chef.getPruner().setBlockedTools(DESTRUCTIVE_TOOLS);
}

// Rate limit / circuit breaker
if (callCount.get('tail_logs') > 100) {
  chef.getPruner().setBlockedTools([
    ...chef.getPruner().getBlockedTools(),
    'tail_logs',
  ]);
}

// User preference
if (!user.settings.webSearchEnabled) {
  chef.getPruner().setBlockedTools([
    ...chef.getPruner().getBlockedTools(),
    'web_search',
  ]);
}

// Sandbox / public demo
if (isPublicDemo) {
  chef.getPruner().setBlockedTools(NON_READONLY_TOOLS);
}
```

These are all naturally blocklist-shaped. For "mode-based agent that should narrow to N tools," see §7.3.

### 4.4 Agent Loop Integration

```typescript
for (const toolCall of response.tool_calls) {
  const check = chef.checkToolCall(toolCall);
  if (!check.allowed) {
    history.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: check.reason,  // LLM gets a structured rejection it can react to
    });
    continue;
  }
  const result = await myToolRegistry[toolCall.name].execute(toolCall.args);
  history.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
}
```

**Chef does NOT wrap tools, does NOT intercept execute.** One explicit check per dispatch.

### 4.5 Snapshot Compatibility

`PrunerSnapshot` gains optional `blockedTools?: string[]`. `restoreState` uses `?? []` for backward compat with snapshots from older versions.

### 4.6 Out of Scope (Module A)

- Public allowlist API — deliberately not provided. Allowlist is a policy shape ("I want only these N"); developers express it as "block (allTools − allowed)" in their own code, or by filtering tools array before passing to LLM. See §7.3.
- `pruneByAllowlist` / `pruneByBlocklist` methods that modify compile output — removed entirely. Pruner never touches the tools array; cache preservation is unconditional.
- `onToolCallReceived` config hook — YAGNI; users wrap their own logic around `checkToolCall`.
- State machine concepts (`transitions`, `initial`, `transitionTo`) — Skill (Module B) is the named-state concept; raw blocklist is for everything else.
- Async `checkToolCall` — sync is enough; if developer needs async checks (rate limiting via remote service), they add their own around the call.
- Auto-injection of "blocked tools" hint into the prompt — Pruner does not touch message assembly. Developer uses `setDynamicState` if they want to inform the LLM.

---

## 5. Module B — Skill Type + Loaders

This module is independent of Module A. A Skill that declares `allowedTools` is just attaching annotation; chef does not enforce it. To get enforcement, the developer must wire to Module A in user code.

### 5.1 Skill is a Plain JS Object (file is optional)

`Skill` is a TypeScript object. Loaders are convenience for the file-based distribution case. Inline declarations are fully supported and idiomatic for small apps:

```typescript
// No file, no loader, no markdown — fully valid usage:
const planning: Skill = {
  name: 'planning',
  description: 'Plan changes before editing',
  instructions: 'Read code, list affected files, write plan to scratchpad.',
  allowedTools: ['read_file', 'grep'],   // annotation only — see §5.4
};

const editing: Skill = {
  name: 'editing',
  description: 'Apply planned changes',
  instructions: 'Apply the plan one step at a time. Run tests after each change.',
  allowedTools: ['edit_file', 'run_tests'],
};

chef.registerSkills([planning, editing]);
chef.activateSkill('planning');
```

`SKILL.md` is for cases where skills should be:
- Versioned in git separately from app code
- Shared across teams, projects, or organizations
- Edited by non-developers (PMs, designers writing skill instructions)

### 5.2 SKILL.md File Format

```markdown
---
name: db-debug
description: Diagnose database query and connection issues
whenToUse: When the user reports slow SQL, connection errors, or ORM exceptions
allowedTools: [query_db, tail_logs, read_file, grep]
---

Diagnostic steps:
1. First confirm DB connectivity: `pg_isready` or `SELECT 1`
2. Check slow query log: `tail_logs --service=postgres --filter=slow`
3. Pull related code to inspect ORM config...

References:
- ./docs/db-schema.md
- ./docs/common-issues.md
```

### 5.3 Field Schema

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | yes | string | Unique within a registered set |
| `description` | yes | string | Short — appears in formatSkillListing |
| `whenToUse` | no | string | Longer guidance for LLM activation decisions |
| `allowedTools` | no | string[] | **Annotation only** — chef does NOT enforce. See §5.4 |
| `model` / `temperature` | — | — | NOT supported — agent runtime concern |
| `paths` | — | — | NOT supported — path-conditional activation is policy |
| `version` / `license` | — | — | NOT supported — open-agents shipped these as dead code |

### 5.4 The `allowedTools` Field — Semantics

**`Skill.allowedTools` is annotation only. ContextChef does not enforce it.**

This matches Claude Code's semantics (`SkillTool.ts:794-800`), where `allowed-tools` is added to the `alwaysAllowRules` permission set — meaning these tools are pre-approved (no prompt), but tools NOT in the list can still be called (they just go through normal permission flow).

In ContextChef:
- `activateSkill('plan')` does NOT call `Pruner.setBlockedTools`
- `checkToolCall` does NOT consult the active skill
- The field exists for: documentation, distribution alignment with SKILL.md ecosystem, and as a hint developers can read and act on

To get hard enforcement, the developer wires it themselves (one line):

```typescript
const skill = chef.activateSkill('planning').getActiveSkill()!;
const allToolNames = chef.getPruner().getAllTools().map(t => t.name);
chef.getPruner().setBlockedTools(
  allToolNames.filter(name => !skill.allowedTools?.includes(name))
);
```

Or for cache-aggressive narrowing (filter the tools array passed to LLM):

```typescript
const skill = chef.activateSkill('planning').getActiveSkill()!;
const allTools = chef.getPruner().getAllTools();
const narrowed = skill.allowedTools
  ? allTools.filter(t => skill.allowedTools!.includes(t.name))
  : allTools;
const response = await llm({ tools: narrowed, messages: chef.compile().messages });
```

### 5.5 Types

```typescript
export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  instructions: string;          // Markdown body (frontmatter stripped)
  allowedTools?: string[];       // ANNOTATION only — see §5.4
  baseDir?: string;              // Auto-populated to the skill file's directory
                                 // (when loaded from disk). Available for resolving
                                 // reference paths in user code.
}

export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
}
```

### 5.6 Loader API

```typescript
// Load a single SKILL.md file. Throws on parse error.
export async function loadSkill(filePath: string): Promise<Skill>;

// Scan a directory for skills.
// Convention: dirPath/<skill-name>/SKILL.md (one level deep, not recursive)
// Tolerant: skips invalid skills, returns errors alongside successes.
export async function loadSkillsDir(dirPath: string): Promise<SkillLoadResult>;

// Format skills as a system-prompt-friendly listing.
export function formatSkillListing(
  skills: Skill[],
  options?: {
    maxChars?: number;          // truncation budget (default: no limit)
    format?: 'plain' | 'xml';   // default: 'plain'
    includeWhenToUse?: boolean; // default: true
  }
): string;
// 'plain' format example:
//   - db-debug: Diagnose database query and connection issues. Use when slow SQL or connection errors.
//   - frontend-refactor: ...
```

### 5.7 Conventions

- `baseDir` is the absolute path of the directory containing the SKILL.md file (only set when loaded via `loadSkill` / `loadSkillsDir`). Developer uses it to resolve relative reference paths.
- `loadSkillsDir` does NOT recurse. Each skill is a top-level subdirectory containing exactly one SKILL.md.
- Frontmatter parser: lenient — unknown fields are preserved on a `metadata` field (future extension), not dropped.

### 5.8 Out of Scope (Module B)

- Auto-discovery of well-known paths (`~/.context-chef/skills/`).
- Remote skill loading (URLs, git, npm).
- Reference file auto-loading — `baseDir` is the contract; developer reads files themselves.
- Schema validation beyond required fields — strict validation rejects perfectly usable skills.
- **Auto-wiring of `allowedTools` to Pruner** — see §5.4. This is the deliberate decoupling.

---

## 6. ContextChef Skill API

This is the public surface for using Skills with ContextChef. **It does NOT touch Pruner.**

### 6.1 API

```typescript
class ContextChef {
  // Optional skill registry (convenience for activateSkill by name).
  registerSkills(skills: Skill[]): this;
  getRegisteredSkills(): Skill[];

  // Single-active-skill activation.
  activateSkill(skill: Skill | string | null): this;
  //   Skill object  → activate directly
  //   string        → look up by name in registered skills (throws if not found)
  //   null          → deactivate (clear instructions slot)
  getActiveSkill(): Skill | undefined;
}
```

### 6.2 Activation Internals

```typescript
activateSkill(arg) {
  const skill = resolveSkill(arg);  // Skill | undefined
  this._activeSkill = skill;
  this._skillInstructions = skill?.instructions ?? '';
  return this;
  // NOTE: does NOT touch this.getPruner(). Skill and Pruner are independent.
}
```

That's the entire body. Two fields, no side-effects on other modules.

### 6.3 Instructions Placement in `compile()`

Insertion point in the message sandwich:

```
[
  ...userSystemPrompt,
  ...skillInstructionsAsSystemMessage,   ← NEW slot, between user system and memory
  ...memoryMessages,
  ...compressedHistory,
  ...dynamicState,
]
```

Format: a separate `{ role: 'system', content: skillInstructions }` message (NOT appended to user system prompt). Reasoning:
- Cleaner cache breakpoint between user-controlled system prompt and chef-managed skill content
- Easier for the LLM to attribute the instructions
- Survives `compile()` metadata reasoning

`compile()` `meta` gains:
```typescript
meta: {
  ...,
  activeSkillName?: string,  // present when a skill is active
}
```

### 6.4 Snapshot Compatibility

`ContextChefSnapshot` gains:
```typescript
{
  ...,
  activeSkillName?: string,    // re-resolved against registered skills on restore
  skillInstructions?: string,  // verbatim, in case skill registry is empty on restore
}
```

`restore()` uses `?? undefined` for backward compatibility.

### 6.5 What activateSkill Does NOT Do

- Does NOT call `Pruner.setBlockedTools` — Pruner stays untouched. See §5.4 for the wiring recipe.
- Does NOT auto-load skill references — developer reads files via `skill.baseDir`.
- Does NOT inject skill listing — developer calls `formatSkillListing()` and chooses where (system prompt? user message? not at all?).
- Does NOT switch model / temperature — those are agent runtime concerns.
- Does NOT register a `load_skill` tool — see §7.4 for the lazy-load recipe (developer-side).

---

## 7. Walkthroughs

### 7.1 Pruner Blocklist Only (no Skill)

The simplest, no-Skill use case: read-only user.

```typescript
const chef = new ContextChef();
chef.getPruner().registerTools([...allTools]);

if (!user.canWrite) {
  chef.getPruner().setBlockedTools(['write_file', 'edit_file', 'delete_file']);
}

// agent loop:
const { tools, messages } = chef.compile();
const response = await llm({ tools, messages });

for (const call of response.tool_calls) {
  const check = chef.checkToolCall(call);
  if (!check.allowed) {
    history.push({ role: 'tool', tool_call_id: call.id, content: check.reason });
    continue;
  }
  // execute
}
```

No Skill. No instructions injection. Just blocklist + dispatch gate.

### 7.2 Skill Only (no Pruner blocklist)

The simplest skill use case: switch behavior style without restricting tools.

```typescript
const formalWriting: Skill = {
  name: 'formal',
  description: 'Use formal, precise language',
  instructions: 'Avoid contractions. Use technical terms accurately. Prefer passive voice for technical descriptions.',
  // No allowedTools — this skill is purely about style
};

chef.registerSkills([formalWriting]);
chef.activateSkill('formal');

const { messages, tools } = chef.compile();
// → messages contains the formal-writing instructions as a system message
// → tools is unchanged (no Pruner involvement)
```

### 7.3 Combined: Mode-Based Agent (Skill + Pruner, developer-wired)

The most common combination. Developer reads Skill annotation and feeds to Pruner.

```typescript
const skills = [
  {
    name: 'planning',
    description: 'Plan before editing',
    instructions: 'Read code, list affected files, write plan to scratchpad.',
    allowedTools: ['read_file', 'grep', 'list_dir'],
  },
  {
    name: 'editing',
    description: 'Apply planned changes',
    instructions: 'Apply the plan one step at a time. Run tests after each change.',
    allowedTools: ['edit_file', 'run_tests', 'read_file'],
  },
];
chef.registerSkills(skills);

function switchMode(modeName: string) {
  const skill = chef.activateSkill(modeName).getActiveSkill()!;

  // Wire annotation → enforcement (this is YOUR code, not chef's)
  const allToolNames = chef.getPruner().getAllTools().map(t => t.name);
  chef.getPruner().setBlockedTools(
    allToolNames.filter(name => !skill.allowedTools?.includes(name))
  );
}

// agent loop:
while (running) {
  const stage = inferStage(history);
  switchMode(stage);
  // ... compile, llm call, dispatch with checkToolCall
}
```

### 7.4 LLM-Driven Skill Loading (lazy-load recipe)

```typescript
// 1. Expose a skill loader as a tool the LLM can call
const skillListingDescription =
  'Load a skill to specialize for a task. Available skills:\n' +
  formatSkillListing(chef.getRegisteredSkills(), { format: 'plain' });

const loadSkillTool = {
  name: 'load_skill',
  description: skillListingDescription,
  parameters: {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        enum: chef.getRegisteredSkills().map(s => s.name),
      },
    },
    required: ['skill_name'],
  },
};

// 2. Add load_skill to your tools array
const allTools = [...myTools, loadSkillTool];

// 3. Handle it in the dispatch loop
for (const call of response.tool_calls) {
  if (call.name === 'load_skill') {
    chef.activateSkill(call.args.skill_name);
    history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: `Skill "${call.args.skill_name}" activated. Follow its instructions.`,
    });
    continue;
  }
  // normal dispatch
}
```

Chef does NOT bundle this tool — wiring varies (AI SDK Tool format, OpenAI tool format, etc.) and the recipe is short.

### 7.5 Reference Files (developer-side)

```typescript
const skill = await loadSkill('./skills/db-debug/SKILL.md');
// skill.baseDir = '/abs/path/to/skills/db-debug'

// Option A: eager — pull references into system prompt
const refContent = await fs.readFile(path.join(skill.baseDir!, 'docs/db-schema.md'), 'utf8');
chef.setSystemPrompt(originalSystem + '\n\n## DB Schema\n' + refContent);

// Option B: lazy — let LLM read via existing read_file tool
//   Skill instructions tell the LLM "read ./docs/db-schema.md if needed"
//   Skill.baseDir is documented in instructions so LLM knows the root
```

---

## 8. Out of Scope (deliberate)

| Pattern | Rejected because |
|---|---|
| Auto-wiring `Skill.allowedTools` → `Pruner.setBlockedTools` | The whole point of decoupling. Developer wires explicitly. |
| Public `setAllowedTools(string[])` allowlist API | Allowlist is a policy shape; expressed as `setBlockedTools(allTools − allowed)` in user code, or by filtering the tools array directly |
| `pruneByX()` methods that mutate compile output | Pruner never touches tools array; cache preservation is a hard guarantee |
| Auto-discovery (`~/.context-chef/skills/`) | Path is policy; one line of developer code suffices |
| Path-conditional activation (Claude Code's `paths:`) | Magical; developer wires `if (file.endsWith('.ts'))` directly |
| Remote skill loading (URLs, git) | Platform concern, not context-library concern |
| Skill stack / multi-activation | No proven need; revisit if real demand |
| Skill chaining / sub-skills | Agent framework territory (LangGraph, XState) |
| LLM-scoring / embedding match for activation | Too heavy; chef is upstream of model calls |
| Reference file auto-loading | Token explosion + cache invalidation traps; developer decides eager vs lazy |
| Model / temperature switching per skill | Agent runtime concern |
| `userInvocable` + `disableModelInvocation` two-axis flags | Claude Code's own report: "easy to confuse" |
| Permission matrix (`{tool: {pattern: allow|ask|deny}}`) | OpenCode-grade overkill for a context library; string array is enough |
| Tool wrapping (`chef.guard(tool)`) | Couples chef to a specific tool runtime format |
| Workspace-style god-object | Mastra's mistake; violates single-responsibility for context lib |
| `onToolCallReceived` config hook | YAGNI; wrap `checkToolCall` if you need custom logic |

---

## 9. Open Questions (need decision before PR-3)

### Q1: Skill instructions placement format

**Options**:
- (a) Appended to user's system prompt as one big string
- (b) Separate `{ role: 'system', content: ... }` message after user's system

**Recommendation**: (b), per §6.3. Cleaner cache breakpoint, easier LLM attribution.

### Q2: Frontmatter parse error in `loadSkillsDir`

**Options**:
- (a) Fail fast — entire batch fails on first error
- (b) Tolerant — collect errors, return successful skills + error list (current spec)

**Recommendation**: (b). Skill systems must tolerate partial failure (one bad file shouldn't kill the rest).

### Q3: Should `formatSkillListing` enforce a default budget?

**Options**:
- (a) No default (user opts in to truncation)
- (b) Default ~2000 chars (sensible safety)

**Recommendation**: (a). Developer knows their context window better than chef does.

### Q4: Multi-skill listing for "lazy-load" pattern — chef-supported or developer-DIY?

**Options**:
- (a) Chef provides `chef.formatActiveSkillListing()` (just sugar over `formatSkillListing(getRegisteredSkills())`)
- (b) Developer calls `formatSkillListing(chef.getRegisteredSkills())` themselves

**Recommendation**: (b). One less API; nothing is hidden.

(Note: the previous Q1 about `activateSkill(null)` and Pruner state is no longer relevant — `activateSkill` does not touch Pruner.)

---

## 10. Implementation Plan (PR Sequence)

| PR | Module | Scope | LOC est. | Depends |
|---|---|---|---|---|
| **PR-1** | A (Pruner) | `setBlockedTools` + `getBlockedTools` + `ContextChef.checkToolCall` + tests + snapshot compat | ~120 + tests | none |
| **PR-2** | B (data) | `Skill` type + `loadSkill` + `loadSkillsDir` + `formatSkillListing` + tests | ~300 + tests | none |
| **PR-3** | B (chef API) | `registerSkills` + `activateSkill` + instructions injection in `compile()` + meta field + snapshot compat | ~100 + tests | PR-2 only |
| **PR-4** | docs | README section, recipes (lazy-load, references, mode wiring, non-mode restriction), migration note | docs only | PR-1, PR-2, PR-3 |

**All three implementation PRs are independent.** They can be developed and shipped in any order or fully in parallel:
- **PR-1 alone** delivers tool restriction for non-skill use cases (permission, env, rate limit). Already useful.
- **PR-2 alone** delivers `Skill` types and loaders that can be used by external code without ContextChef integration.
- **PR-3 depends only on PR-2** (needs the `Skill` type). Does NOT need PR-1 — the activation logic doesn't touch Pruner.

---

## 11. Relationship to TODO.md

This spec replaces the following item from `TODO.md`:

- **Pruner — State-Scoped Tool Whitelists** (Medium priority)
  - The proposed `registerStates / transitionTo / pruneByState` state-machine design is dropped. Named-state-with-tools is what `Skill` does (Module B); raw blocklist is what `setBlockedTools` does (Module A); neither is a state machine.
  - The proposed `onToolCallReceived` config hook is dropped in favor of a simpler `checkToolCall` method.
  - The proposed `setAllowedTools` API is replaced by `setBlockedTools` — semantics inverted (blocklist instead of allowlist) for clearer separation from Skill annotation conventions.
  - The original use case (preventing tool drift in skill prompts) is solved by the combination of Module A + Module B (developer wires per §7.3), not by chef magic.

---

## 12. References

- Claude Code `allowedTools` semantics (additive permission, NOT whitelist):
  - `restored-src/src/tools/SkillTool/SkillTool.ts:794-800`
  - `restored-src/src/skills/loadSkillsDir.ts:385-389`
- OpenCode permission matrix (separate from skills):
  - `packages/opencode/src/skill/skill.ts:224`
  - `packages/opencode/src/permission/permission.ts:145-149`
- open-agents `allowed-tools` dead code:
  - `packages/agent/skills/types.ts:48` (declared, never enforced)
- Mastra Skill/Tool decoupling:
  - [Mastra Skills docs](https://mastra.ai/docs/workspace/skills)
  - [Changelog 2026-02-04](https://mastra.ai/blog/changelog-2026-02-04)
- Anthropic prompt caching behavior:
  - [docs.anthropic.com/en/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
