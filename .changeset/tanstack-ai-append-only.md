---
"@context-chef/tanstack-ai": minor
---

New `appendOnly` option: each model call's request repeats the one the conversation sent before and only appends.

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 reject a request that replays thinking after an earlier message changed, and every provider's prompt cache misses from the first changed message on. The middleware replaced its dynamic-state block on every iteration and recomputed a compression summary on every call over budget, so earlier messages changed on most calls.

With `appendOnly: true`, each conversation (`threadId`) keeps a record of what its calls sent:

- `dynamicState` is its own user message, appended once after the turn it changed in, with either placement; `systemPrompts` is left alone.
- A compression lands once, and its summary stands in for what it covers on every later call. It waits for a user-turn boundary, unless a tool loop would send a request past `contextWindow`.
- Anything that rewrites what an earlier call sent is a checkpoint, reported to the new `onPrefixBreak(event)` option (`PrefixBreakEvent`: `sessionId`, `reason`, `at`, `signed`, `strippedThinking`). Thinking that carries a signature (`@tanstack/ai-anthropic`) is removed from that point on, and a reply that held nothing else is left out; unsigned thinking stays.
- The work happens in each model call's `onConfig` firing; `init` passes through. Within a `chat()` run the middleware reads back what the engine carried from its previous firing, so no other middleware may change the messages it returns.
- In a run with tools, the structured-output call, which goes out without them, is a one-off: no checkpoint for the conversation. In a run without tools it is the run's model call like any other. A reply to a request the record didn't keep (such a one-off, or a firing that failed) never has its signed thinking replayed, and its usage isn't counted.
- `onCompress` details carry `replacement`: what to write back, in place of `compressedMessages`, to persist the compression.
- Calls in one conversation run one at a time, and one aborted while it waits leaves the queue. A summarizer of your own must not call back through this middleware on the same `threadId`: its call would wait behind the call waiting for its summary. Conversations live in the middleware instance, so create it once and reuse it.
- Creating the middleware warns about `compact` / `clear` settings that move with the conversation (`compact.toolCalls: 'before-last-…'`, `keepRecent`), about `transformContext`, whose output must be identical on every call, and that `clearAt` is ignored here.

`compactTanStackMessages` and `planCompactionTanStackMessages` take `keptReasoning: 'keep' | 'strip'` (`KeptReasoningOptions`). A summary you write yourself is a checkpoint nobody signed, so thinking kept after it no longer verifies; `'strip'` removes it.

With `appendOnly` off, nothing changes.
