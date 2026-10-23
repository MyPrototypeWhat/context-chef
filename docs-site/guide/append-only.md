# Append-Only Prefix <Badge type="tip" text="4.3" />

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign every thinking block over everything before it. Send that thinking back after anything before it changed, and the API rejects the request, by default on accounts created on or after 2026-08-31 (see [Claude Thinking Prefix Check](/guide/thinking-prefix)). By default ContextChef changes earlier turns on every compile: dynamic state, announcements, memory and its other injections are rendered at the tail and move to the new tail next time, and a client-side summary replaces earlier turns. With those models the previous turn's thinking can then no longer be sent back. On every provider, the prompt cache misses from the first moved injection on.

`appendOnly` keeps what was sent where it was sent. Each payload repeats the one before it and only adds to the end. Anything that has to rewrite what was already sent becomes a reported *checkpoint*, never a silent edit.

```ts
const chef = new ContextChef({ appendOnly: true, janitor: { contextWindow: 200_000, compressionModel } });
```

It is off by default, and off it changes nothing.

## What it guarantees

Three rules:

1. **What the chef adds is an event, appended once.** Dynamic state, announcements, skill instructions, memory, the guardrail and the handoff notice each become their own message, appended after the turn in which they changed and sent there unchanged on every later request. A change appends a new revision (`<dynamic_state rev="2">`). A source that goes away appends a *tombstone*, a block saying it was withdrawn. Your history is never written to: the chef keeps a *ledger* of what it appended where, and replays it into every compile.
2. **What the model can pull is not pushed.** Memory is stated once per window, as a snapshot, and after that only the changes the model doesn't already know about are appended. What the model reads through the `context` tool arrives as an ordinary tool result.
3. **Every rewrite is a reported checkpoint.** A *checkpoint* is a compile whose payload stops repeating the previous one at some message: you edited the history, the system prompt or tools changed, a compaction landed, the history was cleared, or the chef has no record of what it sent. The compile reports where, through the `prefix:break` event and `meta.prefix`. On Anthropic it also leaves out the thinking that can no longer be verified from that point on, so the request is accepted. That thinking is never sent again.

Between two compiles with no checkpoint, the second payload starts with the first one, message for message. The one exception is a request nobody has answered yet: no signed thinking depends on it, so the events appended to it move with the end of the history on a retry, and freeze once a reply follows.

## Turning it on

```ts
import { ContextChef } from "@context-chef/core";

const chef = new ContextChef({
  appendOnly: true, // or { clearAt: true }, see below
  janitor: { contextWindow: 200_000, compressionModel },
});

chef.on("prefix:break", ({ reason, at, signed, strippedThinking }) => {
  console.info(`checkpoint (${reason}) at message ${at}`, { signed, strippedThinking });
});

const payload = await chef.setHistory(history).compile({ target: "anthropic" });
payload.meta?.prefix;
// { stable: 12 } — the first 12 messages repeat the previous payload
```

`meta.prefix` is present only with `appendOnly`:

- `stable`: how many messages of the window are identical to the previous payload's.
- `break`: present when this compile applied a checkpoint, as `{ reason, at, signed, strippedThinking }`. `at` is the window index of the first message it changed (0 for a compaction, a system prompt change or a tool change). `strippedThinking` counts the thinking blocks left out because of it, on Anthropic. The `prefix:break` event carries the same fields plus `windowId`.

| `reason` | What happened |
|---|---|
| `compaction` | an overflow strategy summarized the start of the window, or the model asked for a new window (`new_context`) |
| `history` | your history no longer matches what was sent: a message edited or removed, a tool result cleared or offloaded after the model saw it, a summary you wrote yourself |
| `system` / `tools` | the system prompt or the tool list changed, including memory or a skill under an explicit `'after_system'` and new guardrail options under `placement: 'system'` |
| `ledger` | the chef has no record of what was sent: a chef created without its saved ledger, or `clearHistory()` |

`signed: true` means the provider signed the replacement ([`onDemandCompaction`](#signed-compaction-ondemandcompaction)): nothing is stripped, and the turns after it keep their thinking.

"On Anthropic" in this guide means the `'anthropic'` target, or an adapter whose `anthropicWire` is `true`. `AnthropicAdapter` sets it, and an adapter that wraps it should pass it on (see [Adapters](/guide/adapters)). A wrapper that doesn't is treated as another provider: nothing is stripped, and the request after a checkpoint is rejected.

## What changes for each injection

| Source | With `appendOnly` |
|---|---|
| Dynamic state, `'last_user'` | its own user message after the turn it changed in, never merged into your message |
| Dynamic state, `'system'` | a system message that stays in place in the conversation; on Anthropic it is never moved into the top-level `system` |
| Implicit context (`before-assemble`'s `inject`) | a user message, appended when it changes. Context that differs every turn grows the window every turn; a tool the model calls may suit it better |
| Announcements | `'system'` (and `'auto'` on Anthropic): a system message. `'user_tail'` (and `'auto'` elsewhere): a user message. `retractAnnouncement()` appends a tombstone; the earlier statement stays where it was sent |
| Skill instructions | an unset `skillPlacement` means `'tail'`: a system message per activation or switch, and a tombstone for `activateSkill(null)`. An explicit `'after_system'` keeps them in the system prompt, and every change is a `system` checkpoint |
| Memory | an unset `memoryPlacement` means `'before_history_tail'`: events, see [Memory](#memory). An explicit `'after_system'` keeps memory in the system prompt, and every change is a `system` checkpoint |
| Guardrail, `placement: 'last_user'` | a user message, appended when the options change |
| Guardrail, `placement: 'system'` | the last part of the system prompt; new options are a `system` checkpoint |
| Guardrail prefill | Anthropic: a trailing assistant message, as before (nothing signed depends on it). OpenAI and Gemini: an unset `prefillMode` means `'instruction'`, sent once with the other guardrail instructions; an explicit `'native'` is honored and warned once |
| Handoff notice | once per window, on the channel an `'auto'` announcement takes |

Events never go between an assistant's tool calls and their results. One that changes while tool calls are waiting for results reaches the model right after the results. Everything appended in one compile is joined into one user message and one system message at most (with `clearAt`, plus one turn-scoped system message), and the line after the state blocks tells the model that each block supersedes the earlier ones of its kind. When no user turn comes before them, as in an empty history or a compile right after a reply, the system events go out as a user message instead, so Anthropic can't move them into the top-level `system`.

### Turn-scoped reminders: `clearAt`

Every revision stays in the window, so state that changes often keeps costing tokens. On Anthropic, `appendOnly: { clearAt: true }` turns the system-channel sources (skill instructions, `'system'` dynamic state, system-channel announcements) into turn-scoped reminders. Each request carries their current state with `clear_at: 'next_user_message'`. Once a user message follows (tool results count), the API clears the reminder, and it stays in place costing no tokens. The chef adds the `mid-conversation-system-clear-at-2026-08-21` beta to `payload.betas`. Other targets ignore the option.

- A source that goes quiet just stops being repeated, with two exceptions that still get a tombstone: a retried request whose reminder still states the source, and a source stated earlier as an ordinary event (on the user channel, or before `clearAt` was on), since that statement would outlive every reminder.
- A reminder needs a user turn right before it. A request without one, such as an empty history or a compile right after a reply, goes without.

### Memory

- The window starts with one snapshot of what the `selector` picks. After that only the changes the model doesn't know about are appended, as a delta: your own `getMemory().set()` and `delete()`, and TTL expiry. A write the model made through `chef.handleTool` is not pushed back, because its tool result already told the model.
- A checkpoint forgets which writes were the model's, so one may be stated once more after it.
- A change to an entry the selector doesn't pick isn't pushed. Its removal is, once the model has seen or written the entry.
- For pure pull, use `selector: () => []` with `tools: 'unified'`, and the model reads `context://memory/*` itself. The unified instruction still tells the model memory is "shown to you automatically below", which is no longer true then.
- `meta.injectedMemoryKeys` lists the keys the snapshot or delta appended in this compile, a removed key included, and is empty when nothing was appended.
- A memory hook or `memory:changed` listener that rewrites the key the model just wrote is recorded as part of the model's write, so that one change isn't pushed until the key changes again. Writes to other keys are pushed as usual.

## Compaction

A client-side summary replaces earlier turns, and the thinking of every turn kept after it was signed over the turns it replaced. So an unsigned compaction is a checkpoint, and on Anthropic the kept turns lose their thinking.

Under `appendOnly` a compaction **lands once**. Its result, the summary plus the pinned messages it put back, becomes the *head* of the window: on every later compile it stands in for the messages it summarized, and the window isn't summarized again until it is over budget again.

**When it lands.** An unsigned compaction waits for a user-turn boundary: a compile whose history doesn't end in tool results, or in tool calls still waiting for theirs. Compacting in the middle of a tool turn would strip the thinking that turn still needs. Two cases can't wait:

- the request would be larger than the raw context window, `janitor.contextWindow` itself rather than the trigger;
- the model asked for a new window (`requestNewContext()`, `new_context`).

Then the whole window, the turn in progress included, collapses into one summary. Pinned messages still go back after it, and a tool call still waiting for its result stays. At a turn boundary, a request past the raw context window is compacted in the same compile: `background()` runs its strategy there and then instead of starting a job.

**What a strategy sees.** Overflow reads the window: the head, your messages after it, and the chef's events among them, so the summarizer sees the events too. An `onBeforeCompress` hook can still return a rewritten history, but under `appendOnly` it reaches the payload only when a compaction lands.

### Signed compaction: `onDemandCompaction`

Anthropic's on-demand compaction (beta `compact-2026-09-04`) summarizes a request the model already answered into a block the provider signs. The block replaces what it summarized, and the turns kept after it keep their thinking. It is the only client-side compaction that strips nothing under the thinking check (server-side compaction with `server()` doesn't touch what you sent either), and the only one that doesn't wait for a tool turn to end. It needs `appendOnly` on the Anthropic target, from the second request on.

```ts
import { ContextChef, onDemandCompaction, summarize } from "@context-chef/core";

const chef = new ContextChef({
  appendOnly: true,
  janitor: { contextWindow: 200_000 },
  overflow: {
    strategy: onDemandCompaction({
      compact: ({ payload, compaction, betas }, signal) =>
        client.beta.messages.create(
          { ...payload, model, max_tokens, thinking, compaction, betas },
          { signal },
        ),
      keepRecentTurns: 1,
      fallback: summarize({ compressionModel }),
    }),
  },
});
```

- `compact` gets a request ready to send. `payload` is the window up to the cut, byte for byte as it was sent, with the system prompt and tools of the last payload; `betas` already includes `compact-2026-09-04`. Send it as you send compiled payloads, with the conversation's own model and thinking settings, and return the response. A response whose `stop_reason` isn't `'compaction'` counts as a failed compression for the circuit breaker, and the window stays as it is.
- `keepRecentTurns` (default 1) is how many replies to keep after the block, each with everything up to the next one; `0` summarizes the whole window. `instructions` replaces the provider's summarization prompt, up to 16,384 characters.
- **Give it a `fallback`.** The fallback runs wherever nothing can be signed: other targets, the first request (nothing was sent yet), a window an `onBeforeCompress` hook rewrote, too few turns to keep. Past the raw context window it also runs when the signed attempt failed. Like any unsigned strategy, it runs only at a turn boundary or to collapse a tool turn that can't wait. Without a fallback, a window past the raw context window that can't be compacted signed counts as a failed compression and goes out as it is.
- Compose it as `onDemandCompaction({ fallback })`, not `chain(onDemandCompaction(…), summarize(…))`: a chain is not signed, so it waits for tool turns to end like any unsigned strategy. `background(onDemandCompaction(…))` works: the request is rendered when the job starts, and the job lands only while the window still renders it the same way.
- The block goes first in every later request, and each of those payloads carries `compact-2026-09-04` in `payload.betas`. Without `appendOnly`, add that beta yourself when you replay a block you resumed with `fromAnthropic`.
- System messages, images and documents in the summarized span are gone. The chef states its own events again after the block. Pinned messages in the span can't go back between the block and the turns it keeps, so the chef restates them as a `<pinned_messages>` event at the end of the window.
- It doesn't combine with `server()`: a request with server-side `context_management` can't ask for it, and one that replays its block can't be compacted by the server. The chef warns once at construction when both are configured.

The compaction request carries the cache breakpoints the window had when it was sent. If you move your breakpoint to the newest message on every turn, the compaction request, the largest of the session, goes out without a cache hit. Adding `cache_control` to the last block of `payload.messages` in your `compact` should let it reuse the cache entry the earlier request wrote; this hasn't been verified against the API.

## Persisting a conversation

`snapshot()` and `restore()` carry the ledger (`ChefSnapshot.prefixLedger`) and the record of the model's memory writes (`ChefSnapshot.modelMemoryWrites`) with the rest of the chef's state. Restoring them is not a checkpoint: the next compile repeats what was sent.

**A chef created per request must save its snapshot and restore it on the next request.** A chef without its ledger can't know what the previous request sent. Its first compile reports a `ledger` checkpoint at 0, which on Anthropic strips all the thinking in the history, on every request. The chef warns once when it meets a history with more than two replies that carry thinking or reasoning this way.

```ts
async function handleRequest(conversationId: string, history: Message[]) {
  const chef = new ContextChef({
    appendOnly: true,
    store: backend, // memory shared across requests and conversations
    memory: {},
    janitor: { contextWindow: 200_000, compressionModel },
  });
  chef.registerSkills(skills); // before restore(), so a saved active skill re-resolves by name
  const saved = await db.load(conversationId); // a ChefSnapshot, stored as JSON
  if (saved) chef.restore({ ...saved, modules: { ...saved.modules, memory: null } });
  // After restore(), which replaces them with the saved ones: the system prompt, tools,
  // guardrails, dynamic state, announcements and skill activation.
  chef.setSystemPrompt(systemPrompt).registerTools(tools);

  const payload = await chef.setHistory(history).compile({ target: "anthropic" });
  await db.save(conversationId, chef.snapshot()); // 1. before the request goes out

  // Send it, add the reply to the conversation's history exactly as it came back
  // (the next request's history must hold it), and run its tool calls
  // (chef.handleTool for the chef's own).
  await runTurn(chef, payload);
  await db.save(conversationId, chef.snapshot()); // 2. after every handleTool call
}
```

- **Restore first, then configure.** `restore()` replaces the system prompt, tools, guardrails, dynamic state, announcements and active skill with the saved ones. Set any of them before it and the saved values win, are saved again, and a new prompt or tool list never takes effect. Register skills before it, so a saved active skill is found by name.
- **Memory is left out of the restore** (`memory: null`) because it lives in the shared store. Restoring the snapshot's copy would roll the store back to the moment of the save, and a memory write made since, by this conversation or any other, would be lost. Everything else is restored, the overflow runner's state (window, circuit breaker, reported usage) and the handoff notice flag included. When the chef's state lives only in the snapshot, restore the whole snapshot.
- **The first save** means a request that went out always has its record, even if something throws after its reply is stored. Without it the next request restores an older ledger and replays thinking over a prefix it wasn't signed over, with nothing reported. If one request compiles more than once, save after each compile.
- **The second save** records the memory writes the model made through `handleTool`, so they aren't pushed back to it on the next request. If the process dies between the two saves, the cost is one memory note stated again, never a broken conversation.
- Memory's turn counter is part of the memory you leave out, so it starts over on every request, and on a per-request chef a turn-based TTL (a number, or `{ turns }`) effectively never expires. With a shared store, use `{ ms }` TTLs.

**Persisting a compaction** is optional: the head lives in the ledger, and your history can keep every message. Write it into your store when you want the store itself to shrink. Then write back `details.replacement` exactly and in order, in place of the messages it replaced, which are the first `count` messages of your history:

```ts
janitor: {
  contextWindow: 200_000,
  compressionModel,
  onCompress: (_summary, count, details) => {
    if (details.replacement) store = [...details.replacement, ...store.slice(count)];
  },
},
```

`replacement` is the summary (or the signed block), the pinned messages put back after it, and whatever it kept of an earlier head. The next compile reads the history as one that took the compaction in, and reports nothing. Anything else no longer matches what was summarized: the summary alone when pinned messages came back with it, a summary of your own, or the summary as a system message is a `history` checkpoint, and your history is sent as it is. Under `appendOnly`, `compressedMessages` and `count` leave out the chef's events, which your store never had.

Slicing by `count` assumes your store already holds every earlier `replacement`. Miss one write-back, and the next compaction summarizes that earlier summary again: `count` then counts the summary and the pinned messages it put back rather than the messages of yours they stood for, so the slice is off. Your store keeps messages that were already summarized, or loses ones that weren't, and the next compile reports a `history` checkpoint. After a missed write-back, or when you start persisting in the middle of a conversation, don't slice: keep your full history, since the head lives in the ledger anyway.

With `onDemandCompaction` the replacement is the block alone. Writing it back takes the pinned messages it summarized out of your history with the rest of the span, and the chef withdraws its restatement of them. If you rely on pinned messages, keep your full history instead of writing an on-demand compaction back.

- `clearHistory()` starts the ledger over: the next compile reports a `ledger` checkpoint.
- `fromAnthropic` skips the mid-conversation system messages of a parsed request by default, which changes the history where they were. `fromAnthropic(messages, system, { keepPositionalSystem: true })` keeps them in place; use it for the system messages your own code wrote. See [Adapters](/guide/adapters).

## Checking it: `pipelineChecks`

With `pipelineChecks: true`, every payload is compared with the one the chef sent before it. Unless the compile reported a checkpoint, it must repeat that payload (up to its last reply while that request is unanswered, everything but a trailing prefill once a reply followed) and send every thinking signature it sent. A payload that doesn't is reported through `pipeline:invariant` and the logger, never thrown. A slot handler that rewrites earlier messages, for instance, is reported there but not prevented.

- A compile that reports a checkpoint isn't compared.
- The comparison needs the previous payload from the same chef, so the first compile after `restore()` isn't checked: a chef created per request is checked from its second compile within a request.
- It costs a JSON copy of each payload and up to two adapter renders of part of it, on top of the other checks. Keep it for development and tests.

## OpenAI and Gemini

The same ledger, events and checkpoints, without what only Anthropic has:

- Checkpoints are reported, and nothing is stripped: there is no signature to fail.
- `clearAt` is ignored, and no betas are added.
- A system event is a system message in place on Chat Completions, an input `message` item on Responses, and user content on Gemini, joined with the user turn next to it.
- The guardrail prefill defaults to an instruction (see the table above). A custom adapter that turns a prefill into an instruction should set `nativePrefill: false`.
- Use one target per conversation: the system prompt and tools are compared as the last request sent them, so switching targets is a checkpoint.

What you get there is a prefix that only grows, so the provider's prefix cache keeps hitting, and compactions that land once instead of being recomputed.

## AI SDK and TanStack AI

Both middlewares take `appendOnly` too. Each conversation gets a ledger in the middleware, which never writes to your messages, and the middleware applies the same rules to what it adds and to its compression.

```ts
// Vercel AI SDK
const model = withContextChef(baseModel, {
  appendOnly: true,
  contextWindow: 200_000,
  compress: { model: summarizerModel },
  onPrefixBreak: ({ sessionId, reason, at, strippedThinking }) => {
    console.info(`[${sessionId}] checkpoint (${reason}) at message ${at}`, { strippedThinking });
  },
});

await generateText({
  model,
  messages,
  providerOptions: { contextChef: { sessionId: conversationId } },
});
```

```ts
// TanStack AI: create the middleware once and reuse it
const contextChef = contextChefMiddleware({
  appendOnly: true,
  contextWindow: 200_000,
  compress: { adapter: summarizerAdapter },
  onPrefixBreak: (event) => console.info(event),
});

const stream = chat({ adapter, messages, threadId: conversationId, middleware: [contextChef] });
```

- **One session per conversation.** Pass `providerOptions.contextChef.sessionId` with the AI SDK, or `threadId` with TanStack AI, which otherwise generates a new one per run, so every run starts empty. Conversations sharing a session rewrite each other's history on every call. Calls in one session run one at a time: a call waits for the previous call's compile, summarization included, so a summarizer that hangs holds up its session.
- **Sessions live in the middleware instance.** Create it once and reuse it. One created per request starts every session empty, and every call is then a `ledger` checkpoint. A process restart, or an eviction past `maxSessions` (default 256), costs one. Each session keeps the last history it compiled.
- **Events are user messages.** The middleware doesn't know the provider, and a provider SDK may move a mid-conversation system message into the system prompt. So `dynamicState` becomes a user message with either placement, and `clearAt` is ignored (with a warning).
- **Compression lands once**, timed as in the chef. `onCompress` is only needed for your store to outlive the process: write `details.replacement`, in your message format, back in place of `compressedMessages`, exactly as [above](#persisting-a-conversation).
- **Settings that move with the conversation** (`compact.reasoning: 'before-last-message'`, a `'before-last-…'` `compact.toolCalls` setting, `clear` with `keepRecent`) rewrite messages earlier calls sent, so nearly every call is a checkpoint. Once a compression has landed, such a rewrite that reaches a summarized message also drops the summary, and the conversation is summarized again on every call. They are warned when the middleware is created. Use `'all'`, which rewrites each message once before it is first sent, or the provider's own context editing.
- `clear` runs before compression, so the summarizer sees the placeholders.
- **`transformContext` runs after the session recorded the request.** Whatever it adds or changes must come out identical, in the same place, on every call. Otherwise reasoning signed over an earlier call is replayed over a different prefix, and nothing reports it. Put content that changes per call in `dynamicState`. This is warned when the middleware is created.
- **Only Anthropic-family signed reasoning is stripped** at a checkpoint: reasoning parts signed through `@ai-sdk/anthropic` or `@ai-sdk/amazon-bedrock`, and TanStack thinking blocks that carry a signature (`@tanstack/ai-anthropic`). A reply that held nothing else is left out. Other providers' reasoning stays, and the checkpoint is only reported.
- **What counts as a change.** The system prompt is compared by its text, and the tools by what reaches the model; a cache breakpoint moving onto either is no change. A call with a different tool set (`activeTools`, `prepareStep`) is a `tools` checkpoint. Messages are compared through ContextChef's own message format (text, tool calls, reasoning text, attachment media types): a change only to provider metadata, an inline provider-executed tool result, or a file's bytes is not detected.
- **`onPrefixBreak`** receives `{ sessionId, reason, at, signed, strippedThinking }`. `at` indexes the call's messages, after its system messages with the AI SDK.
- **No signed compaction here.** The middleware can't render the provider's own request, so `onDemandCompaction` always runs its fallback.
- **Durable compaction.** `compactModelMessages`, `compactTanStackMessages` and their `planCompaction…` versions take `keptReasoning: 'strip'`. A summary you write yourself is a checkpoint nobody signed, so reasoning kept after it no longer verifies; `'strip'` returns a history you can send as it is.

### TanStack AI specifics

- The work happens in each model call's `onConfig` firing (`beforeModel`, `structuredOutput`); `init` passes the config through. `getState` and `transformContext` run there only.
- Within one `chat()` run the engine carries what `onConfig` returned into the next iteration, and the middleware reads it back as your conversation plus what came since. No other middleware may change the messages it returns (copying them is fine). If you call the middleware hooks yourself, pass one context object per run: a new one per firing reads as a new run, and events repeat.
- Persist the client's conversation, not the engine's messages. The engine's messages hold the chef's events; sent back in a later run, an event goes out twice, and no checkpoint reports it.
- The structured-output call goes out without tools. In a run with tools that makes it a one-off: no checkpoint for the conversation, and it carries none of the conversation's signed thinking. In a run without tools it is the run's model call like any other: kept, compressed when over budget, its usage counted. The reply to a request the ledger didn't keep (such a one-off, or a firing that failed and went out as the engine had it) was signed over a prefix the conversation never had: its signed thinking is never replayed, and its usage is not counted.
- Truncation runs again on your conversation on every call. Its output is the same each time, so the request stays stable, but an oversized result is written to the offload store again on every call.

## Limits

- **Not yet run against the live API.** Everything above is tested locally against the documented rules. Some questions need a real request to answer, for example whether Anthropic accepts a tool loop whose last turn lost its thinking, or how each AI SDK provider sends a user event that follows tool results. They are listed under "Needs an API key" in [TODO.md](https://github.com/MyPrototypeWhat/context-chef/blob/main/TODO.md).
- **A request can still exceed the raw context window** when the summarizer declines (nothing left to compress, a single turn larger than the window), when `onDemandCompaction` has no fallback and its signed attempt fails, and when the compaction itself fails. An open circuit breaker holds back only a request that fits: one past the raw window gets another attempt on every compile, so a summarizer that keeps failing is called each time.
- **Old revisions cost tokens.** Without `clearAt`, state that changes often leaves every revision in the window until a compaction absorbs it, so compaction comes sooner. Keep state coarse, or let the model pull it through a tool. The budget also still counts reminders that `clear_at` already cleared.
- **A fresh chef that meets few-shot examples**, assistant replies ahead of the question, reports a `ledger` checkpoint on its first compile. It doesn't warn: the examples carry no thinking to lose. A trailing prefill doesn't count as a reply.
- **Slot handlers can rewrite the window.** `after-assemble` handlers, the deprecated `transformContext` option among them, and `after-adapt` handlers run after the ledger: `pipelineChecks` reports what they rewrite, but can't prevent it. What `onBeforeCompile` or a `before-assemble` handler injects is an implicit-context event, appended when it changes.
- For a request that has to go out before you can fix the cause, the [`drop_block` safety net](/guide/thinking-prefix#safety-net-drop-block) still applies.
