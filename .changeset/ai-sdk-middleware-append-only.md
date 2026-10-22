---
"@context-chef/ai-sdk-middleware": minor
---

New `appendOnly` option: each call's prompt repeats the one the session sent before and only appends.

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 reject a request that replays reasoning after an earlier message changed, and every provider's prompt cache misses from the first changed message on. The middleware moved dynamic state with the last user message and recomputed a compression summary on every call over budget, so earlier messages changed on most calls.

With `appendOnly: true`, each session (`providerOptions.contextChef.sessionId`) keeps a record of what its calls sent:

- `dynamicState` is its own user message, appended once after the turn it changed in, with either placement.
- A compression lands once, and its summary stands in for what it covers on every later call. It waits for a user-turn boundary, unless a tool loop would send a request past `contextWindow`.
- Anything that rewrites what an earlier call sent is a checkpoint, reported to the new `onPrefixBreak(event)` option (`PrefixBreakEvent`: `sessionId`, `reason`, `at`, `signed`, `strippedThinking`). Reasoning signed through `@ai-sdk/anthropic` or `@ai-sdk/amazon-bedrock` is removed from that point on, and a reply that held nothing else is left out; other reasoning stays.
- `onCompress` details carry `replacement`: what to write back, in place of `compressedMessages`, to persist the compression.
- Calls in one session run one at a time. Sessions live in the middleware instance, so create it once and reuse it.
- Creating the middleware warns about `compact` / `clear` settings that move with the conversation (`'before-last-…'`, `keepRecent`), about `transformContext`, whose output must be identical on every call, and that `clearAt` is ignored here.

`compactModelMessages` and `planCompactionModelMessages` take `keptReasoning: 'keep' | 'strip'` (`KeptReasoningOptions`). A summary you write yourself is a checkpoint nobody signed, so reasoning kept after it no longer verifies; `'strip'` removes it.

With `appendOnly` off, nothing changes.
