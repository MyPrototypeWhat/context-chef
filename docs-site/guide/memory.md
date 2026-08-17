# Memory

Persistent key-value memory that survives across sessions: the model writes via tool calls, and existing memories are auto-injected into the compiled payload. Memory is modified via tool calls (`create_memory` / `modify_memory`), which are auto-injected into the payload on `compile()`.

```typescript
import { InMemoryStore, VFSMemoryStore } from "@context-chef/core";

const chef = new ContextChef({
  memory: {
    store: new InMemoryStore(), // ephemeral (testing)
    // store: new VFSMemoryStore(dir),   // persistent (production)
  },
});

// In your agent loop, intercept memory tool calls:
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name === "create_memory") {
    const { key, value, description } = JSON.parse(toolCall.function.arguments);
    await chef.getMemory().createMemory(key, value, description);
  } else if (toolCall.function.name === "modify_memory") {
    const { action, key, value, description } = JSON.parse(toolCall.function.arguments);
    if (action === "update") {
      await chef.getMemory().updateMemory(key, value, description);
    } else {
      await chef.getMemory().deleteMemory(key);
    }
  }
}

// Direct read/write (developer use, bypasses validation hooks)
await chef.getMemory().set("persona", "You are a senior engineer", {
  description: "The agent's persona and role",
});
const value = await chef.getMemory().get("persona");

// On compile():
// - Memory tools (create_memory, modify_memory) are auto-injected into payload.tools
// - Existing memories are injected as <memory> XML between systemPrompt and history
```

## Memory placement — `memoryPlacement`

Controls where the volatile `<memory>` data block lands in the compiled payload. Defaults to `'after_system'` (backward compatible). For applications using **Anthropic prompt caching** with cache breakpoints on history, switch to `'before_history_tail'` so memory mutations don't invalidate the history cache.

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(dir),
    memoryPlacement: 'before_history_tail',
  },
});
```

| Placement | Top of sandwich | Last user message | When to use |
|---|---|---|---|
| `'after_system'` (default) | INSTRUCTION + `<memory>` data, combined into one `role: 'system'` message | untouched | Simple agents; you don't rely on cache breakpoints past the system parameter |
| `'before_history_tail'` | INSTRUCTION only (stable, cacheable) | appends the `<memory>` data block to the original user content | You want cache breakpoints on history (or earlier `system` blocks) to survive memory mutations on every turn |

The split keeps the stable usage instruction at the top of the sandwich where it caches cleanly, and ships the volatile data block at the tail of the conversation. Anthropic / Gemini adapters extract every `role: 'system'` message into the top-level `system` parameter — under `'before_history_tail'` the data block stays in `messages` instead, so any cache breakpoint earlier in the message stream no longer hashes the changing memory text.

When dynamic state is also injected at the tail (`dynamicStatePlacement: 'last_user'`), the order inside the last user message is: original content → `<memory>` → `<dynamic_state>` → `<implicit_context>` → anchor line. When dynamic state goes to its own system message (`dynamicStatePlacement: 'system'`), memory still injects at the user tail with no anchor.
