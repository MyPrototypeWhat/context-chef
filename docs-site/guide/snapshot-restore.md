# Snapshot & Restore

Capture and rollback full context state for branching or error recovery — everything that determines the next compile is part of the snapshot.

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

## What a snapshot carries

- **System prompt**, **history** and the dynamic state that will be injected on the next compile.
- **Tools** — what the pruner holds: the registered tools, namespaces and lazy-loaded toolkits, and the blocked tools.
- **Janitor state** — including the compression failure counter (circuit breaker) and, in `'incremental-anchored'` mode, the persistent anchor document. Background compression state is *not* snapshotted.
- **Memory** entries.
- **The active skill** — its name, which `restore()` looks up again in the skill registry, and its instructions as they were, which survive even when the registry is empty. The registry itself is not in the snapshot: call `registerSkills` before `restore()`.
- **Announcements** — every standing one, in insertion order.
- **Guardrail options** <Badge type="tip" text="v4" /> — `withGuardrails` is stored state in v4, so `ChefSnapshot` gains `guardrailOptions` and snapshot/restore round-trips it.
- **The handoff notice flag** <Badge type="tip" text="4.2" /> — `ChefSnapshot.handoffNoticedWindow` records the window the notice had already been issued for. The window lineage round-trips through the janitor state, so without it a restored session would sit on a window it had already noticed with the flag cleared, and repeat the notice every turn.
- **The append-only ledger** <Badge type="tip" text="4.3" /> — with `appendOnly`, `ChefSnapshot.prefixLedger` records what the chef appended where and what it last sent, and `modelMemoryWrites` which memory writes were the model's. Restoring them is not a checkpoint. A chef created per request must save its snapshot after each compile and again after the request's tool calls, and restore it on the next request: without the ledger, every request starts with a `ledger` checkpoint that strips the history's thinking on Anthropic. With memory in a shared store, restore it without its memory part (restoring that part would roll the shared store back to the moment of the save): `chef.restore({ ...saved, modules: { ...saved.modules, memory: null } })`. Register skills before `restore()`, and set the system prompt, tools and state after it, since it replaces them with the saved ones. See [Append-Only Prefix](/guide/append-only#persisting-a-conversation).
- Snapshot metadata: the `label` you passed and `createdAt`.

See the runnable [snapshot-restore example](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts) for a full rollback walkthrough.
