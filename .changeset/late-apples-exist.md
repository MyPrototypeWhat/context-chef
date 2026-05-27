---
"@context-chef/core": minor
---

feat: configurable memory placement (`MemoryConfig.memoryPlacement`) + Gemini parallel-tool-call fix

## `memoryPlacement: 'after_system' | 'before_history_tail'`

New `MemoryConfig.memoryPlacement` controls where the volatile `<memory>` data block lands in the compiled payload. Default `'after_system'` is byte-for-byte compatible with previous behavior. Opt into `'before_history_tail'` when you use **Anthropic prompt caching** with cache breakpoints on history — under the default placement, every memory mutation invalidates the entire history cache because Anthropic / Gemini adapters extract every `role: 'system'` message into the top-level system parameter, and downstream cache breakpoints hash that block.

```typescript
const chef = new ContextChef({
  memory: {
    store: new VFSMemoryStore(dir),
    memoryPlacement: 'before_history_tail',
  },
});
```

| Placement | Top of sandwich | Last user message | Cache behavior |
|---|---|---|---|
| `'after_system'` (default) | INSTRUCTION + `<memory>` data combined into one `role: 'system'` | untouched | Memory text rides into the system parameter — cache breakpoints downstream hash it and miss on every memory mutation |
| `'before_history_tail'` | INSTRUCTION only (stable, cacheable) | `<memory>` data appended via the existing tail-injection mechanism | Memory text never enters the system parameter — earlier cache breakpoints survive memory mutations on every provider |

When `dynamicStatePlacement: 'last_user'` is also active, the tail order inside the last user message is: original content → `<memory>` → `<dynamic_state>` → `<implicit_context>` → anchor line.

**Caveat** — when `compile()` is invoked mid-agent-loop (history tail is a `tool` turn awaiting interpretation), "most recent user" walks back past the tool result(s) to the user turn that kicked off the current tool sequence. The injection lands mid-conversation rather than at the absolute tail. Cache breakpoints placed AFTER that user turn (typical: end-of-history assistant) will see the modified user content and miss. To preserve cache in tool-ending tails, place breakpoints BEFORE the user turn that started the active tool sequence. Same placement convention as `setDynamicState({ placement: 'last_user' })`.

**Additions**:

- `Memory.placement: MemoryPlacement` — public getter exposing the configured placement for observability.
- `MemoryPlacement` type re-exported from `@context-chef/core`.

## Gemini adapter: parallel-tool-call merge (latent bug fix)

`GeminiAdapter.compile()` now collapses consecutive same-role `Content` entries before returning the payload. Previously, any IR sequence with parallel tool calls would emit non-canonical Gemini shape — three parallel `tool` IR messages map to three `role: 'user'` Contents (Gemini's tool-result convention), which is rejected by `generateContent` with:

```
400 INVALID_ARGUMENT: Please ensure that multiturn requests alternate
between user and model
```

The canonical Gemini shape for parallel function responses is ONE user `Content` with multiple `functionResponse` parts ([Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling); same shape the Google Gen AI SDK constructs in its `automatic function calling` path). The new merge produces exactly that shape and additionally guards against any other source of adjacent same-role contents (e.g. stripped-thinking empty model turns, caller-supplied malformed IR).

**Implementation notes**:

- Runs AFTER prefill degradation so the trailing-model pop sees an unmerged view (a pre-merge would conflate the prefill candidate with the preceding model turn).
- Lazy-allocation fast path: when the input is already strictly alternating (the common case for normal conversations), the original array is returned by reference — zero allocation. Allocates on the first detected merge point.
- Pure function: never mutates the input. Result envelopes and `parts` arrays are fresh; inner `Part` objects are treated as immutable leaves.
- Anthropic auto-merges server-side and OpenAI tolerates adjacent same-role, so this merge lives exclusively in the Gemini adapter — mirroring `@tanstack/ai-gemini`'s `mergeConsecutiveSameRoleMessages` and LangChain's `langchain-google-genai`.

Users on `@context-chef/ai-sdk-middleware` and `@context-chef/tanstack-ai` are unaffected by the latent bug — those paths already produce canonical Gemini shape via existing batching (`toAISDK`'s consecutive-tool-message coalescing, TanStack's own merge).

## Internal API tightening — `Assembler.compile()` / `AssembleOptions` marked `@internal`

`AssembleOptions` is no longer re-exported from the package barrel. Both `AssembleOptions` (the interface) and `Assembler.compile()` (the instance method) now carry `@internal` JSDoc tags so TypeScript / TypeDoc tool chains exclude them from generated `.d.ts` and documentation.

This makes explicit what was already true in practice: `Assembler.compile()` is implementation glue for `ContextChef.compile()` and has no external use case. The Assembler class itself remains exported because its static helpers — `orderKeysDeterministically` and `stringifyPayload` — are genuine public utilities for callers that need to hash payloads consistently with the compile pipeline (cache-aware logging, custom adapters, etc.).

**Internal signature changes** (under `@internal`):

- `AssembleOptions.dynamicStateXml` → `AssembleOptions.tailXml` — the field is general-purpose tail injection, not dynamic-state-specific.
- `AssembleOptions.placement` removed — the assembler no longer gates injection on a placement enum; `ContextChef.compile()` composes the tail stitch and supplies it only when injection should happen.
- The hardcoded "Above is the current system state..." anchor line moved out of `injectIntoLastUser` and into `ContextChef.compile()` — appended only when dynamic state or implicit context is actually present in the tail.

**Migration** — external callers of `import { type AssembleOptions } from '@context-chef/core'` (rare; never advertised) will see a TypeScript error after upgrade. Resolution: use `ContextChef.compile()` rather than invoking the assembler directly. If you have a genuine use case for direct assembler access, please open an issue.

## Other additions

- `Prompts.MEMORY_BLOCK_HEADER: 'You recall the following from previous conversations:'` — extracted constant referenced by both `Prompts.getMemoryBlock` and `ContextChef.compile()`'s anchor-suppression logic. Makes the self-anchor contract explicit so future changes to the memory block prefix can't silently break anchor suppression for memory-only tail injections.
