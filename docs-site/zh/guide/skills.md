# Skill（行为打包）

`Skill` 是一份可移植的 `(name + description + instructions + ...)` 打包，用来在某个阶段或领域里给 agent "切人格" —— 一种不用重写 prompt 就能切换的"模式"。激活后，instructions 作为单独的 system message 注入到你的 system prompt 和 memory 块之间。Skill 可以是内联 JS 对象，也可以从 `SKILL.md` 加载（与 Claude Code / Mastra / OpenCode 同 frontmatter 格式）。

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

## Skill 位置 —— `skillPlacement` <Badge type="tip" text="4.1" />

控制激活的 skill instructions 投递到哪里。默认 `'after_system'` 就是上面这套行为，逐字节兼容：紧跟 system prompt 的一条独立 `role: 'system'` 消息。这些 token 位于可缓存前缀里 —— 重发不要钱 —— 但每一次激活、切换、停用都会改写前缀，代价是一次完整的缓存失效。

改成 `'tail'` 后，instructions 彻底离开前缀，改为领衔 tail 拼接段，用 `<skill_instructions skill="NAME">` 包裹：

```typescript
const chef = new ContextChef({ skillPlacement: "tail" });
chef.registerSkills([planning, editing]); // two Skill objects, shaped like the one above
chef.setSystemPrompt([{ role: "system", content: basePrompt }]).setHistory(history);

chef.activateSkill("planning");
const a = await chef.compile({ target: "anthropic" });
chef.activateSkill("editing");
const b = await chef.compile({ target: "anthropic" });

// `a` 和 `b` 在最后一条 user message 之前逐字节相同 —— 激活、切换、停用都不碰
// 缓存前缀，变的只有 tail：
//   <skill_instructions skill="editing">…</skill_instructions>
```

两个方向的代价都是真实的：`'tail'` 会在**每一次请求**里不走缓存地重发完整 instructions；`'after_system'` 什么都不用重发，但**每次切换**都要吃一次缓存 miss。切换模式的频率相对于每个模式的存活时长更高，就选 `'tail'`；一次设定、整个会话都不换的模式，留在默认值。

位置只影响投递方式 —— `meta.activeSkillName`、`getActiveSkill()`、snapshot/restore 的行为完全不变。在 tail 里，skill 块位于固定拼接顺序的最前面（`<skill_instructions>` → `<memory>` → `<dynamic_state>` → `<implicit_context>` → `<announcements>` → anchor），让模型先读"你现在是谁"，再读它要作用的状态；它**不会**单独触发 anchor 那行文案 —— 它在自己的标签里已经自说明了。如果 `cacheAudit` 在你最后一个 `cache_control` 断点处或之前抓到 `<skill_instructions` 块，说明断点放晚了，不是 placement 的问题。

## 从 `SKILL.md` 加载

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

`SKILL.md` 解析是容忍的：块标量（`>` 折叠 / `|` 字面）、`- item` 列表、kebab key（`allowed-tools`、`when-to-use`）都能加载；chef 不认识的 key 原样保留在 `skill.metadata` 上交给 host 读取 —— chef 从不解释，仅作注解（与 `allowedTools` 一致）。已知字段若写成畸形嵌套结构会直接抛错，而不是静默失效（打错的 `allowed-tools` 会暴露，而非悄悄关掉限制）。

listing 让 LLM 通过 `load_skill` tool 自己挑 skill。tool 定义要保持**静态**——listing 放进 system prompt 而不是 tool description，`skill_name` 用普通 string 而不是注册名的 enum。tool schema 位于所有 provider prompt 前缀的最顶端，带 listing 的 description 或 live-name enum 会在 skill 集合变化时改写 schema、让整个 prompt cache 失效（与 4.1 的 memory 工具静态 schema 同一套推理）。未知名字改在 dispatch 时拦截——`activateSkill` 会抛错并列出可用名字：

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

// listing 放在（稳定的）system prompt 里：
chef.setSystemPrompt([
  { role: "system", content: `${basePrompt}\n\nAvailable skills:\n${listing}` },
]);

// dispatch 循环 —— dispatch-gate，与 memory 工具同一姿势：
if (call.name === "load_skill") {
  try {
    chef.activateSkill(call.args.skill_name);
    /* push 成功的 tool result，继续循环 */
  } catch (err) {
    /* 把 String(err) 作为 tool result 推回 —— 模型会自我纠正 */
  }
}
```

## 渲染参数（`renderSkill`）

`renderSkill` 把 skill instructions 里的 `$ARGUMENTS` / `$0..$N` / `$name` / `${VAR}` 占位符替换掉，返回一个新的 `Skill`（纯函数，无 I/O）。渲染后的 skill 怎么投递由你决定：system 槽（常驻"模式"），或 host 追加成消息以同时渐进式挂载多个 skill。

```typescript
const triage = await loadSkill("./skills/triage/SKILL.md");

// Fill $ARGUMENTS / $0.. / ${SKILL_DIR} before activating:
chef.activateSkill(renderSkill(triage, { args: "p0 incidents" }));
```

## 两种交付模型

chef 提供的是 skill *原语*（`loadSkill`、`loadSkillsDir`、`loadSkillsDirs`、`renderSkill`、`formatSkillListing`、`activateSkill`）。**skill 内容怎么投递、投递到哪里由你决定。** 有两种交付模型。

### 1. 模式（常驻指令）—— system 槽

适合需要跨轮持续生效的 skill（一种"模式"）：

```ts
const skill = await loadSkill('skills/triage/SKILL.md');
chef.activateSkill(renderSkill(skill, { args: 'p0 incidents' }));
```

`activateSkill` 把 instructions 作为专属 system message 注入三明治（在你的 system prompt 之后、history 之前）。同一时间只有一个激活。切换会让该槽及其后的所有内容重新缓存 —— 对很少切换的模式来说没问题；切换很频繁时用 `skillPlacement: 'tail'`。

### 2. 渐进式披露 —— host 追加消息

适合按需拉取 skill（模型自己决定需要哪个）：把目录广而告之，让模型通过你自己的工具请求 skill：

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

因为每次拉取都是一条单独追加的消息，**多个 skill 自然共存** —— chef 里没有 skill 栈，也不需要。追加也永远不会 mutate 缓存前缀，所以对缓存友好。

## 引用文件

skill 正文可能指向同目录文件（`@./schemas/foo.json`、`./templates/x.md`）。chef **不会**读取或内联它们 —— 那会让 token 膨胀，还把 prompt 组装绑死在文件系统上。正确做法是 `renderSkill({ includeBaseDir: true })` 把 skill 的目录写进 prompt，你的 agent 用自己的文件读取工具按需读取。也可以直接用 `skill.baseDir` 自己解析路径。

## 多源加载

```ts
const { skills, errors } = await loadSkillsDirs(
  [builtinDir, userDir, projectDir],
  { precedence: 'last-wins' },
);
chef.registerSkills(skills);
```

后面的目录在同名冲突时获胜；也可以传 `namespace` 回调按来源加前缀。目录按 realpath 去重。加载是容忍的 —— 坏文件收进 `errors`，从不抛出。

## 延伸阅读

设计动机（Skill ⊥ Pruner 解耦、SKILL.md frontmatter 格式、mode 接线配方、LLM 自主加载 skill、reference 文件）见 [`SKILL_SPEC.md`](https://github.com/MyPrototypeWhat/context-chef/blob/main/SKILL_SPEC.md)。参数渲染、多源加载、两种交付模型见 [`docs/skill-interop-design.md`](https://github.com/MyPrototypeWhat/context-chef/blob/main/docs/skill-interop-design.md)。
