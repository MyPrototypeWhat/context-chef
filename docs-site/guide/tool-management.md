# Tool Management (Pruner)

Too many tools cause hallucinations. The Pruner decouples tool registration from routing: prune the tool list per task, block tools at dispatch time without breaking KV cache, or use a two-layer namespace + lazy-loading architecture that keeps the tool list stable across turns.

## Flat Mode

```typescript
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "run_bash", description: "Run a command", tags: ["shell"] },
  {
    name: "get_time",
    description: "Get timestamp" /* no tags = always kept */,
  },
]);

const { tools, removed } = chef.getPruner().pruneByTask("Read the auth.ts file");
// tools: [read_file, get_time]
```

Also supports `allowOnly(names)` and `pruneByTaskAndAllowlist(task, names)`.

## Runtime Blocklist (Permission Gate)

Block specific tools at dispatch time without breaking KV cache. Useful for permission control, environment safety, sandboxing, rate limits, and feature flags. The compiled `tools` array stays unchanged — enforcement happens via `checkToolCall` in your agent loop.

```typescript
// Set policy (rare event — startup, on user role change, prod env, etc.)
chef.getPruner().setBlockedTools(["delete_file", "tail_logs"]);

// In your agent loop, gate every tool call before dispatch:
for (const call of response.tool_calls) {
  const check = chef.checkToolCall({ name: call.function.name });
  if (!check.allowed) {
    history.push({
      role: "tool",
      tool_call_id: call.id,
      content: check.reason, // e.g. 'Tool "delete_file" is currently blocked.'
    });
    continue;
  }
  await executeTool(call);
}
```

`checkToolCall` returns a discriminated union (`ToolCallCheckResult`), so TypeScript guarantees `reason` is present iff the call is rejected. KV cache is preserved across blocklist changes — the LLM continues to see the full tool set; the gate is dispatch-side only.

## Namespace + Lazy Loading (Two-Layer Architecture)

**Layer 1 — Namespaces**: Core tools grouped into stable tool definitions. The tool list never changes across turns.

**Layer 2 — Lazy Loading**: Long-tail tools registered as a lightweight XML directory. The LLM loads full schemas on demand via `load_toolkit`.

```typescript
// Layer 1: Stable namespace tools
chef.registerNamespaces([
  {
    name: "file_ops",
    description: "File system operations",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { path: { type: "string" } },
      },
      {
        name: "write_file",
        description: "Write to a file",
        parameters: { path: { type: "string" }, content: { type: "string" } },
      },
    ],
  },
  {
    name: "terminal",
    description: "Shell command execution",
    tools: [
      {
        name: "run_bash",
        description: "Execute a command",
        parameters: { command: { type: "string" } },
      },
    ],
  },
]);

// Layer 2: On-demand toolkits
chef.registerToolkits([
  {
    name: "Weather",
    description: "Weather forecast APIs",
    tools: [
      /* ... */
    ],
  },
  {
    name: "Database",
    description: "SQL query and schema inspection",
    tools: [
      /* ... */
    ],
  },
]);

// Compile — tools: [file_ops, terminal, load_toolkit] (always stable)
const { tools, directoryXml } = chef.getPruner().compile();
// directoryXml: inject into system prompt so LLM knows available toolkits
```

**Agent Loop integration:**

```typescript
for (const toolCall of response.tool_calls) {
  if (chef.getPruner().isNamespaceCall(toolCall)) {
    // Route namespace call to real tool
    const { toolName, args } = chef.getPruner().resolveNamespace(toolCall);
    const result = await executeTool(toolName, args);
  } else if (chef.getPruner().isToolkitLoader(toolCall)) {
    // LLM requested a toolkit — expand and re-call
    const parsed = JSON.parse(toolCall.function.arguments);
    const newTools = chef.getPruner().extractToolkit(parsed.toolkit_name);
    // Merge newTools into the next LLM request
  }
}
```

> **One level is enough.** The two-layer namespace → tools depth is the empirically optimal hierarchy for tool selection — deeper nesting hurts accuracy without saving meaningful context (arXiv:2607.17598). Don't nest namespaces inside namespaces.

## Deferred tool loading — `deferLoading` <Badge type="tip" text="v4" />

Set `deferLoading: true` on a `ToolDefinition` to annotate it for Anthropic's server-side Tool Search: the flag passes through `payload.tools` verbatim on the Anthropic target, letting the API surface the tool's full schema on demand instead of loading it up front. It is an annotation only — other targets ignore it (OpenAI has an equivalent native tool-search mechanism of its own).

Two consumers, one flag. Claude discovers deferred tools on demand via tool search; under the `mid-conversation-tool-changes` beta a deferred tool additionally stays withheld until a `tool_addition` block surfaces it mid-conversation. Deferred definitions are stripped before the cache key is computed, so adding them never invalidates an existing cache entry. Chef passes the flag through verbatim — converting it to the provider's wire field (`defer_loading`) is your tool-conversion step, same as the rest of the definition, and `tool_addition` / `tool_removal` content blocks are not passed through (chef's IR is text-content based). To tell the model *in words* that the tool set moved, use announcements below.

## Announcements — telling the model what changed <Badge type="tip" text="4.2" />

Capabilities change mid-session: a permission is granted, a toolkit is loaded, a rate limit withdraws `web_search`. The payload changes shape, but nothing tells the model *what* changed — it keeps calling the tool that vanished, or ignores the one that just appeared. `announce()` states the change and keeps stating it until you retract it.

```typescript
chef.announce("tools:added", "Tools newly available: read_file, grep");
chef.announce(
  "tools:removed",
  "web_search has been withdrawn; calls to it will be rejected",
);

chef.getAnnouncements();
// [{ id: 'tools:added', content: '…', channel: 'auto' }, { id: 'tools:removed', … }]

chef.retractAnnouncement("tools:added"); // → true; the next compile carries no trace of it
```

Every standing announcement renders into one block, in insertion order:

```xml
<announcements>
<announcement id="tools:added">
Tools newly available: read_file, grep
</announcement>

<announcement id="tools:removed">
web_search has been withdrawn; calls to it will be rejected
</announcement>
</announcements>
```

**State, not event.** An announcement is a statement of the *current* capability set, re-rendered into every `compile()` — not a one-shot message appended to history. That is the point: chef's injections never persist into your history, so a retracted announcement disappears completely from subsequent payloads instead of lingering as an obsolete turn the model keeps re-reading. `announce()` upserts by `id` — re-announcing the same id replaces content and channel while keeping the original insertion position, so the block stays stable as it is updated. `retractAnnouncement(id)` returns whether anything was removed.

### Channels

| Channel | Where it renders | Notes |
|---|---|---|
| `'user_tail'` | joins the tail stitch of the last user message — after `<dynamic_state>` / `<implicit_context>`, before the anchor line | Works on every provider. Unlike skill instructions and memory data, announcements *do* trigger the "Above is the current system state" anchor — they are system state |
| `'system'` | one combined `_positional` system message placed right after the conversational tail (and still in front of any assistant prefill) | Operator precedence, and the cached prefix stays intact |
| `'auto'` (default) | routes by **target**: `'system'` on the Anthropic target, `'user_tail'` everywhere else | See the caveat below |

Channels are per-announcement, so a mixed set splits across both delivery paths within a single compile.

**The auto-routing caveat.** `'auto'` routes by *target*, not by model — chef never sees your model id. Mid-conversation `role: "system"` messages are native on Fable 5 / Mythos 5 / Opus 4.8 / Opus 5, but **not on Sonnet 5**. If you compile for the Anthropic target and call Sonnet 5, pass the channel explicitly:

```typescript
chef.announce("tools:added", "Tools newly available: grep", { channel: "user_tail" });
```

Mechanism, not policy — chef will not guess your model for you.

The `'system'` channel rides `Message._positional`: a `role: 'system'` message flagged positional stays *at its position* in the stream instead of being hoisted into the provider's top-level system parameter. Per adapter: Anthropic emits a mid-conversation system message (falling back to hoisting, with a one-time warning, if it would precede every user/tool message); OpenAI Chat Completions keeps system messages inline anyway, so the flag is a no-op; the Responses adapter emits an inline `message` item instead of folding the text into `instructions`; Gemini has no system role in `contents` and degrades it to a `user` entry verbatim.

**Wording matters.** State facts, do not command. "Tools newly available: read_file, grep" and "web_search has been withdrawn; calls to it will be rejected" read as system state. "You must now use read_file" reads as an instruction competing with your system prompt — and the model will weigh it against everything else you told it.

**Lifecycle.** Announcements survive `clearHistory()` — they describe the current capability set, which a fresh conversation still needs; retract them explicitly when the change no longer holds. They ride `ChefSnapshot` and round-trip through `snapshot()` / `restore()`; restoring a snapshot taken before 4.2 (no `announcements` field) yields an empty set rather than leaving the previous ones live. With `cacheAudit: true`, an `<announcements>` block caught at or before your last `cache_control` breakpoint is flagged — announcements always render at the conversational tail, so move the breakpoint earlier.

### Detecting the delta (userland)

There is no automatic tool-delta detection. Chef renders what you announce; deciding *what changed* is policy and stays in your loop:

```typescript
let previousTools = new Set<string>();

function syncToolAnnouncements(next: string[]) {
  const added = next.filter((name) => !previousTools.has(name));
  const removed = [...previousTools].filter((name) => !next.includes(name));

  if (added.length) {
    chef.announce("tools:added", `Tools newly available: ${added.join(", ")}`);
  } else {
    chef.retractAnnouncement("tools:added"); // no longer new — stop repeating it
  }

  if (removed.length) {
    chef.announce(
      "tools:removed",
      `Withdrawn; calls to these will be rejected: ${removed.join(", ")}`,
    );
  } else {
    chef.retractAnnouncement("tools:removed");
  }

  previousTools = new Set(next);
}

// Pairs with the runtime blocklist above — the gate rejects, the announcement explains:
chef.getPruner().setBlockedTools(["delete_file"]);
chef.announce("tools:blocked", "delete_file is disabled in this environment");
```

Call it wherever your tool list is decided — right before you build the request, or from a `compile:done` handler if the Pruner owns the list (`payload.tools`), remembering that an announcement made there lands on the *next* compile, not the one that just finished.
