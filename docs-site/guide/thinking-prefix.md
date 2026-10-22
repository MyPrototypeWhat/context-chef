# Claude Thinking Prefix Check <Badge type="tip" text="4.3" />

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign every thinking block over everything that came before it: the `system` prompt, the `tools` array and every earlier message. When you send that thinking back on a later turn, the API checks that everything before it is still exactly what the model saw.

- **Accounts created on or after 2026-08-31** are checked by default. A mismatch is a 400: `Invalid signature in thinking block. The block is bound to a different conversation.`
- **Older accounts** are checked only on requests that set `thinking.block_binding.prefix_mismatch_behavior`.
- It only matters when you send thinking blocks back. Earlier Claude models, OpenAI and Gemini have no such check.

Key order and JSON formatting don't count; values do. Moving, editing or removing anything that sits before a replayed thinking block does.

## What ContextChef keeps stable

- **History parsed with `fromAnthropic`** goes back byte-for-byte while nothing has changed it: every thinking block, separate text blocks, parallel tool results, server tool blocks and compaction signatures. See [Adapters](/guide/adapters).
- **A guardrail in the static system prompt** (the default `placement: 'system'`) stays put across turns. Models that reject a native prefill need [`prefillMode: 'instruction'`](/guide/guardrail).
- **`checkPrefixContinuity(prev, next)`** checks your own setup: compile two consecutive turns and it reports the first place the second payload stops repeating the first.

```ts
import { checkPrefixContinuity } from "@context-chef/core";

const first = await chef.compile({ target: "anthropic" });
// ...send it, append the reply and the next user turn to your history...
const second = await chef.compile({ target: "anthropic" });

checkPrefixContinuity(first, second);
// { ok: false, firstDivergence: { path: "messages[3]", before: ..., after: ... } }
```

## What still changes earlier turns

By default ContextChef renders its injections at the tail of every compile and never writes them into your history. The next compile therefore puts them at the new tail, and the turn they sat in last time changes:

- dynamic state (`'last_user'`), announcements on either channel, guardrail `placement: 'last_user'`, memory under `'before_history_tail'` (and any memory change under `'after_system'`, which changes the system prompt), the handoff notice, `skillPlacement: 'tail'`;
- client-side overflow (`summarize()`, `anchored()`), whose summary replaces earlier turns without a signature Anthropic can verify;
- `compact()` tool-result clearing, and offloading a tool result the model has already seen in full.

[`appendOnly`](/guide/append-only) changes that. What the chef adds is appended once and stays where it was sent, a compaction lands once instead of being recomputed, and anything that still rewrites an earlier turn is a reported checkpoint whose invalidated thinking is left out of the request. [`onDemandCompaction`](/guide/append-only#signed-compaction-ondemandcompaction) is the one compaction that keeps the thinking of the turns after it.

## Safety net: `drop_block`

For a request that still has to go out with thinking that no longer matches (`appendOnly` off, or a rewrite you haven't tracked down yet), the request itself can tell the API to drop those blocks instead of rejecting the call. These are fields of your request, not of the chef's payload:

```ts
const payload = await chef.compile({ target: "anthropic" });

await client.beta.messages.create({
  ...request, // model, max_tokens, tools, plus system / messages from `payload`
  thinking: {
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  },
  betas: [...(payload.betas ?? []), "thinking-binding-controls-2026-08-01"],
});
```

- **Which models**: Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5. On Sonnet 5.5 and Haiku 5.5 the field only goes with `thinking: { type: "adaptive" }`; open-source projects report a 400 when it accompanies `between_tools` or `disabled`.
- **What it costs**: the dropped reasoning is gone, and the model works it out again. Anthropic measured 2.5% more output tokens for a single drop at low effort, up to 67.1% when blocks are dropped on every turn at max effort. Without `appendOnly`, the tail injections above drop every earlier turn's thinking on every turn, which is that worst case.
- **What it is**: Anthropic calls it a stopgap. The fix is a history that only grows at the end, which is what `appendOnly` keeps.
