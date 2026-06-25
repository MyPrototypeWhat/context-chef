---
"@context-chef/ai-sdk-middleware": major
---

Support AI SDK v7 (provider spec V4).

The middleware now targets `ai@>=7` / `@ai-sdk/provider@>=4`: it implements the V4
language-model middleware spec (`specificationVersion: 'v4'`) and all public types
move from `LanguageModelV3*` to `LanguageModelV4*`. AI SDK v7's `wrapLanguageModel`
rejects a v3-spec middleware, so this is a breaking change that requires AI SDK v7.

**Migration**

- On AI SDK v7 (`ai@7`): upgrade to `@context-chef/ai-sdk-middleware@2`.
- Still on AI SDK v6 (`ai@6`): stay on `@context-chef/ai-sdk-middleware@1` — the 1.x
  line continues to support the v3 spec. No code change is forced on you.

**Removed** (deprecated APIs that were slated for removal in the next major):

- `planCompaction`, `compactHistory`, and the `CompactionPlan` type (the provider-prompt
  altitude variants) — use `planCompactionModelMessages` / `compactModelMessages` /
  `CompactionPlanModelMessages` at the `ModelMessage` altitude instead.
- `onBudgetExceeded` on `ContextChefOptions` — use `onBeforeCompress` instead.

Runtime behavior is unchanged. The only V4 nuance: provider-level `FilePart.data`
became a tagged union (`SharedV4FileData`); the prompt adapter handles it
transparently and the binary/URL payload still round-trips losslessly.

On v7, durable in-loop compaction via `compactModelMessages` inside a
`ToolLoopAgent` `prepareStep` now persists across steps (AI SDK v7 carries
`prepareStep`-returned messages forward into later steps — v6 did not).
