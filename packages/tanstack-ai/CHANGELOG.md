# @context-chef/tanstack-ai

## 0.3.1

### Patch Changes

- [`ac49b81`](https://github.com/MyPrototypeWhat/context-chef/commit/ac49b81cb0cc92be5789326238fb6593f5567fc8) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - feat: physical-path truncation marker + compress tool-result stub

  Two cooperating improvements that make tool-result handling cheaper and easier
  to wire into existing agents.

  **`Offloader` exposes the underlying physical path in the truncation marker.**
  `VFSStorageAdapter` gains an optional `getPhysicalPath(filename)` method;
  `FileSystemAdapter` implements it. When the adapter returns a path, the
  marker advertises it as the primary retrieval handle (`Full output saved to:
/path/to/file`) and demotes the URI to an alternative — the model can pull
  the original content back with its existing file-read tool, no custom
  URI-aware tool required. Adapters that don't map to a filesystem (DB,
  in-memory) leave the method unset and the marker falls back to the
  `context://vfs/` URI alone.

  **`Janitor` gains `toolResultStubThreshold`** (also exposed on both
  middlewares as `compress.toolResultStubThreshold`). When set, tool-result
  content longer than the threshold is replaced with a one-line metadata stub
  — `[Tool name returned N chars; omitted before summarization]` — _only_
  inside the to-be-summarized portion. Recent (preserved) tool results are
  untouched. Tool name is resolved from the preceding assistant turn's
  `tool_calls[].function.name` via `tool_call_id`. tool_use ↔ tool_result
  pairing is structurally preserved so the summarizer doesn't see orphan
  calls. Default: undefined (disabled). Recommended starting value: `5000`.

  This second change relaxes the prior "compact + compress incompatibility"
  warning around clearing tool-result: the in-compress stub path operates on
  compress's own boundary, so the "preserve recent / summarize old" split
  stays coherent without two windows competing.

- Updated dependencies [[`ac49b81`](https://github.com/MyPrototypeWhat/context-chef/commit/ac49b81cb0cc92be5789326238fb6593f5567fc8)]:
  - @context-chef/core@3.3.1

## 0.3.0

### Minor Changes

- [`382bdc9`](https://github.com/MyPrototypeWhat/context-chef/commit/382bdc97fdc45b35bb76fcacacd7a421f39cbaf5) Thanks [@MyPrototypeWhat](https://github.com/MyPrototypeWhat)! - feat(middleware): per-tool truncate overrides via `perTool`

  Adds an opt-in `truncate.perTool` field to both middleware packages. Each entry is either a bare string (preserve the tool's result entirely — original text goes into the prompt unchanged and the storage adapter is bypassed) or an object `{ name, threshold?, headChars?, tailChars? }` that overrides one or more truncation params for a single tool. Tools not listed fall back to the top-level defaults; duplicate names follow last-wins semantics.

  Lookup key is `part.toolName` in the AI SDK middleware (per-part filtering, so a single tool message can mix preserved and truncated parts) and `ModelMessage.name` in the TanStack AI middleware (tool messages without `name` silently fall through to the defaults). Wildcards are not supported and `storage` cannot be overridden per-tool. `perTool` only affects mechanical truncation — preserved messages can still be summarized later by `compress`.

## 0.2.4

### Patch Changes

- Updated dependencies [[`6500178`](https://github.com/MyPrototypeWhat/context-chef/commit/6500178af18821e3cf59ba4e3688f19f88efa8cd)]:
  - @context-chef/core@3.3.0

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
