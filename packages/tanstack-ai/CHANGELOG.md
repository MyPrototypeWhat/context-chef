# @context-chef/tanstack-ai

## 0.2.3

### Patch Changes

- [`ac6460f`](https://github.com/MyPrototypeWhat/context-chef/commit/ac6460f2ba0ffc64c1adeeb273e7be58193b83cd) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Add `skill` option to inject the active Skill's instructions, mirroring the existing `dynamicState` pattern.

  ```typescript
  contextChefMiddleware({
    contextWindow: 128_000,
    skill: planningSkill, // static
    // or
    skill: () => myActiveSkill, // dynamic — re-evaluated per request
    // or
    skill: async () => fetchActiveSkill(), // async resolver supported
  });
  ```

  Skill instructions are appended to the TanStack `systemPrompts: string[]` channel (the idiomatic place for additional system instructions), positioned after user system prompts and before any `dynamicState` injection, matching `@context-chef/core`'s `compile()` ordering (SKILL_SPEC §6.3). Empty or whitespace-only `instructions` are skipped to avoid emitting an empty entry and creating a needless cache breakpoint.

  Decoupled from tool restriction: `skill.allowedTools` is annotation only — the middleware does NOT consult it (Claude Code semantics). Wire it to `Pruner.setBlockedTools` yourself in user code if you want skill-driven tool gating.

  No breaking changes.

## 0.2.2

### Patch Changes

- Updated dependencies [[`05d713c`](https://github.com/MyPrototypeWhat/context-chef/commit/05d713cf885277835013c407dc3326839933b360)]:
  - @context-chef/core@3.2.1

## 0.2.1

### Patch Changes

- [`2e13c66`](https://github.com/MyPrototypeWhat/context-chef/commit/2e13c662be94e288371291d6fb8f54e11eacd3c1) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - Bump `@context-chef/core` peer to pick up the new media-aware compression strategy (attachments are now stripped to `[image]` / `[document]` text placeholders before reaching the compression model). No source changes in this package — multimodal compression behavior is driven entirely by core.

- Updated dependencies [[`2e13c66`](https://github.com/MyPrototypeWhat/context-chef/commit/2e13c662be94e288371291d6fb8f54e11eacd3c1)]:
  - @context-chef/core@3.2.0

## 0.2.0

### Minor Changes

- [`246175c`](https://github.com/MyPrototypeWhat/context-chef/commit/246175c31f713af6d7a50c303391f8409595871a) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - ### New Package: `@context-chef/tanstack-ai`

  TanStack AI `ChatMiddleware` powered by context-chef. Drop in as a single middleware to get transparent history compression, tool result truncation, and token budget management.

  #### Features

  - **History Compression** — automatically compresses older messages when conversation exceeds the token budget, with optional LLM-based summarization via a cheap adapter
  - **Tool Result Truncation** — large tool outputs are truncated while preserving head and tail, with optional VFS storage for full content retrieval
  - **Token Budget Tracking** — extracts `promptTokens` from `onUsage` callbacks and feeds it back to the compression engine automatically
  - **Compact (Mechanical Pruning)** — zero-LLM-cost removal of tool call/result pairs and empty messages with configurable retention modes
  - **Dynamic State Injection** — injects runtime state as XML into the last user message or system prompt on every call
  - **Transform Context Hook** — custom post-processing for RAG injection or prompt manipulation

  #### Adapter

  - `fromTanStackAI()` / `toTanStackAI()` — lossless round-trip converters between TanStack AI `ModelMessage[]` and context-chef `Message[]` IR
  - Preserves multimodal `ContentPart[]` content and `providerMetadata` on tool calls through round-trip via `_originalContent` / `_originalToolCalls` pass-through fields

### Patch Changes

- Updated dependencies [[`246175c`](https://github.com/MyPrototypeWhat/context-chef/commit/246175c31f713af6d7a50c303391f8409595871a)]:
  - @context-chef/core@3.1.1
