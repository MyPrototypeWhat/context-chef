# Snapshot & Restore

Capture and rollback full context state for branching or error recovery — everything that determines the next compile is part of the snapshot.

```typescript
const snap = chef.snapshot("before risky tool call");

// ... agent executes tool, something goes wrong ...

chef.restore(snap); // rolls back everything: history, dynamic state, janitor state, memory
```

## What a snapshot carries

- **History** and the dynamic state that will be injected on the next compile.
- **Janitor state** — including the compression failure counter (circuit breaker) and, in `'incremental-anchored'` mode, the persistent anchor document. Background compression state is *not* snapshotted.
- **Memory** entries.
- **Guardrail options** <Badge type="tip" text="v4" /> — `withGuardrails` is stored state in v4, so `ChefSnapshot` gains `guardrailOptions` and snapshot/restore round-trips it.
- **The handoff notice flag** <Badge type="tip" text="4.2" /> — `ChefSnapshot.handoffNoticedWindow` records the window the notice had already been issued for. The window lineage round-trips through the janitor state, so without it a restored session would sit on a window it had already noticed with the flag cleared, and repeat the notice every turn.
- Snapshot metadata: the `label` you passed and `createdAt`.

See the runnable [snapshot-restore example](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts) for a full rollback walkthrough.
