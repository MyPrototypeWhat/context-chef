# ModelMessage durable-compaction altitude

**Date:** 2026-06-17
**Status:** Draft design, pending author review
**Packages:** `@context-chef/ai-sdk-middleware` (minor) — additive, non-breaking

## Problem

The durable-compaction host API is typed at the wrong altitude. `compactHistory`
and `planCompaction` in `packages/ai-sdk-middleware/src/compaction.ts` take and
return `LanguageModelV3Prompt` (from `@ai-sdk/provider`). That is the
**provider-protocol** layer — the type a middleware's `transformParams` briefly
sees and a provider consumes. It is ephemeral; nobody persists it.

"Durable compaction" means "summarize, then write the result back to **your
persisted message store**." But your store holds `UIMessage[]` (useChat / DB) or
`ModelMessage[]` (the `messages` you pass to `generateText`/`streamText`, and the
ones `prepareStep` hands you). It never holds a `LanguageModelV3Prompt`. So a
durable API that consumes and returns `V3Prompt` is self-contradictory — it asks
you to persist a value you never had.

The mismatch is already documented in the codebase and it already bites:

- `middleware.ts:280` notes that `LanguageModelV3Message` and `ModelMessage`
  "share identical runtime structure but differ at the TypeScript level
  (e.g. ImagePart, FilePart.data)."
- `adapter.ts:59` (`fromAISDK`) extracts user text with
  `msg.content.filter((p) => p.type === 'text')`. `ModelMessage` user/assistant
  `content` may be a **plain `string`** (the SDK's shorthand). A bare cast of
  `ModelMessage[]` to `LanguageModelV3Prompt` therefore throws here the moment
  any message uses string content.
- AI SDK ships **no** public `ModelMessage → LanguageModelV3Prompt` converter
  (only the reverse-semantics `convertToModelMessages`: `UIMessage → ModelMessage`).

The concrete trigger: a host wants the ModelMessage altitude at two call sites —
inside a `ToolLoopAgent`'s `prepareStep` (`PrepareStepFunction` gives
`messages: ModelMessage[]`, `model: LanguageModel`, accepts
`{ messages?: ModelMessage[] }`, and may be async), and in its own own-the-store
loop around `generateText`. There is no safe, supported way to feed either into
the current `V3Prompt`-typed API.

Note on "durable": returning `{ messages }` from `prepareStep` overrides only
*that step's* request — it is not itself persistence. "Durable" means the caller
owns the message store and writes the result back. The ModelMessage altitude is
what both call sites need; the API does not make `prepareStep` durable by itself.

The compaction **engine** already lives at the right altitude — core's
provider-agnostic IR `compactHistory`/`planCompaction` in
`packages/core/src/modules/janitor/durableCompaction.ts`. This change is purely
about adding the correct host-facing **boundary** in the middleware package. Core
is not touched.

## Decisions

1. **Compat: additive, `ai-sdk-middleware` minor, non-breaking.** Add a
   `ModelMessage[]` altitude alongside the existing V3 functions; mark the two V3
   persist-back functions (`compactHistory`, `planCompaction`) `@deprecated`.
   (Author's call: "统一 minor，反正也没人用" —
   1.5.2 shipped 2026-06-16, near-zero adoption, so deprecating costs nothing and
   a major bump is unwarranted.)
2. **Scope: `ModelMessage[]` only this change.** UIMessage entry is out of scope
   (see below). *Recommended default — flip at review if you want UIMessage now.*
3. **Naming: `*ModelMessages` suffix.** `compactModelMessages`,
   `planCompactionModelMessages`. Explicit about altitude, reads clearly next to
   the deprecated V3 names. *Recommended default — flip at review.*

## Design

### New adapter — `packages/ai-sdk-middleware/src/modelMessageAdapter.ts`

A `ModelMessage ↔ IR` adapter mirroring the V3 `fromAISDK`/`toAISDK`, with the
same lossless pass-through strategy (store original content on the IR message;
detect Janitor edits via `_originalText`). New parallel pass-through carrier:

```ts
import type { ModelMessage } from 'ai';

interface ModelMessageIR extends Message {
  _userContent?: UserContent;        // ModelMessage's, incl. string shorthand
  _assistantContent?: AssistantContent;
  _toolContent?: ToolContent;
  _originalText?: string;
  _providerOptions?: SharedV3ProviderOptions;
  _toolName?: string;
}

export function fromModelMessages(messages: ModelMessage[]): ModelMessageIR[];
export function toModelMessages(ir: Message[]): ModelMessage[];
```

Deltas vs the V3 adapter — exactly the three `ModelMessage`-only shapes:

- **string-shorthand content.** When `content` is a `string`, IR `content` is
  that string and `_userContent`/`_assistantContent` stores the original string.
  On the way back, an unmodified message hands the original string straight back
  (a `string` is a valid `ModelMessage` content), so the shape round-trips
  exactly rather than being re-expanded into a text-part array.
- **`ImagePart` (`type: 'image'`).** Recorded as an attachment for Janitor's
  presence checks, same as `type: 'file'`; the real payload rides through
  `_userContent`/`_assistantContent` verbatim.
- **approval parts** (`ToolApprovalRequest` in assistant content,
  `ToolApprovalResponse` in tool content). No IR concept; preserved verbatim via
  the pass-through fields and covered by a round-trip test (must not be dropped).

Reused, not duplicated: IR types and `ensureValidHistory` from core;
`stringifyToolOutput` is promoted to a shared helper (exported from `adapter.ts`
or a small shared module) and imported here — no second copy. `reasoning` parts
ride through `_assistantContent` byte-exact, identical to the V3 path.

`fromModelMessages` ends with `ensureValidHistory(...)` (same boundary
sanitization as `fromAISDK`).

Implementation notes: content/part types are derived via
`Extract<ModelMessage, { role: '…' }>['content']` (no part-type imports — same
trick as `adapter.ts`). Before sharing `stringifyToolOutput`, verify
`ToolResultOutput` (provider-utils) and `LanguageModelV3ToolResultOutput`
(`@ai-sdk/provider`) are structurally identical; if they diverge, keep a thin
ModelMessage-specific stringifier instead of forcing a shared one.

### New durable entries — in `compaction.ts`

```ts
export interface CompactionPlanModelMessages {
  system: ModelMessage[];
  toSummarize: ModelMessage[];
  toKeep: ModelMessage[];
}

export function planCompactionModelMessages(
  messages: ModelMessage[],
  options: PlanCompactionOptions,
): CompactionPlanModelMessages {
  const plan = corePlanCompaction(fromModelMessages(messages), options);
  return {
    system: toModelMessages(plan.system),
    toSummarize: toModelMessages(plan.toSummarize),
    toKeep: toModelMessages(plan.toKeep),
  };
}

export async function compactModelMessages(
  messages: ModelMessage[],
  model: LanguageModel, // `ai`'s type (string id | V3 | V2) — what prepareStep hands you
  options: PlanCompactionOptions & SummarizeMessagesOptions,
): Promise<ModelMessage[]> {
  const ir = fromModelMessages(messages);
  const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
  // core returns the input IR reference on a no-op — preserve the original
  // `messages` reference so callers can skip persistence via `result === messages`.
  return result === ir ? messages : toModelMessages(result);
}
```

Both are thin `from → core → to` shells, exactly like the V3 wrappers, and reuse
the **same** core engine and `createCompressionAdapter` (tool-role flattening) —
no new compaction or flattening logic.

**Model altitude.** `model` is typed `LanguageModel` (from `ai`:
`GlobalProviderModelId | LanguageModelV3 | LanguageModelV2`), the exact type
`prepareStep`/`generateText` hand the host — not the provider-layer
`LanguageModelV3` the deprecated V3 functions take. `createCompressionAdapter` is
widened `LanguageModelV3 → LanguageModel`; it only forwards to `generateText`
(which already accepts `LanguageModel`), and the existing in-flight caller passes
a `LanguageModelV3` (a subtype), so the widening is backward-compatible.

`summarizeModelMessages(messages, model, opts): Promise<string>` is a natural
third sibling (mirrors `summarizeMessages`) and is nearly free atop the adapter. I
recommend including it so the ModelMessage altitude is complete
(compact / plan / summarize); flag at review if you'd rather drop it.

### Deprecate the two V3 persist-back functions (not `summarizeMessages`)

`compactHistory` and `planCompaction` return `LanguageModelV3Prompt` *for you to
persist* — the literally self-contradictory pair (durable + a type nobody
persists). They keep their current signatures and behavior, stay exported, and
gain `@deprecated` JSDoc pointing to `compactModelMessages` /
`planCompactionModelMessages`. They have no internal callers (the in-flight path
uses `janitor.compress`), so deprecation is signposting only — zero behavior
change, tests stay green.

`summarizeMessages` is **not** deprecated. Its output is a neutral `string`, and
it is actively recommended by a runtime warning (`middleware.ts:86`), `types.ts`,
and both READMEs — deprecating it would have those recommend a deprecated
function. Instead it gains a `summarizeModelMessages` sibling (host-native input),
and the docs phase repoints the `:86` warning toward `compactModelMessages` as the
one-shot durable path.

### Invariants preserved (regression-covered)

- **No-op reference contract.** `compactModelMessages` returns the **input
  `messages` reference** when there is nothing to compact or the summary is
  blank — same `result === ir ? input : convert` short-circuit as the V3 wrapper.
- **Reasoning byte-exact round-trip.** Via `_assistantContent` pass-through,
  unchanged from the V3 adapter.
- **Tool-role flattening reused.** `createCompressionAdapter` maps `role:'tool'`
  and assistant `tool_calls` to plain user/assistant text before summarizing — no
  new flattener.
- **Turn-safe split.** Inherited from core `planCompaction` /`groupIntoTurns`;
  cuts land only on atomic-turn boundaries, never orphaning a tool result.

## Out of scope: UIMessage entry

Deliberately deferred (YAGNI; no concrete demand yet). It is not free:

- AI SDK has no `ModelMessage → UIMessage` converter, so a UIMessage entry cannot
  reuse the ModelMessage path symmetrically.
- A *faithful* UIMessage compaction is doable but is its own code path: split
  `UIMessage[]` on turn boundaries (UIMessages carry tool calls/results as inline
  parts, not `role:'tool'` messages, so `groupIntoTurns` doesn't apply directly),
  convert only the old slice via `convertToModelMessages` to summarize, then
  return `[summaryUIMessage, ...keptUIMessages]` with the kept tail preserved
  verbatim (ids/metadata intact). Separate grouping logic + its own tests.

Documented here so the decision is explicit, not forgotten.

## Testing

New `modelMessageAdapter.test.ts` — round-trip correctness for:
**string-shorthand content, `tool_calls`, tool results, file parts, image parts,
reasoning parts, approval parts.** Assert reasoning is byte-exact and that
unmodified string content returns as a string. To guard against the two adapters
drifting, the shared round-trip cases run from one fixture set against **both**
`fromAISDK/toAISDK` and `fromModelMessages/toModelMessages`.

New cases in `compaction.test.ts` (or a sibling) for the ModelMessage entries:
no-op returns the **input reference** (`toBe(messages)`), blank-summary returns
input reference, turn-safe split, `keepRecentTurns = 0` summarizes all,
delegation to core. Algorithm-level assertions stay in core's
`durableCompaction.test.ts` (unchanged).

## Versioning

One package changes: `@context-chef/ai-sdk-middleware` → **minor** (new public
API). Core is untouched, so no core changeset. Per the standing "batch until ship"
preference, I will **not** write the changeset until you say ship — flag if you
want it now.

## File layout & phases (≤5 files each, verify between)

1. **Adapter** — `modelMessageAdapter.ts` + shared `stringifyToolOutput` export
   from `adapter.ts` + `modelMessageAdapter.test.ts`.
   Verify: build core, then `pnpm --filter @context-chef/ai-sdk-middleware typecheck && test`.
2. **Durable entries** — `compaction.ts` (add ModelMessage compact/plan/summarize,
   `@deprecated` on V3 `compactHistory`/`planCompaction`, widen
   `createCompressionAdapter`) + `index.ts` exports + compaction tests. Verify: same.
3. **Docs** (+ changeset only on ship) — README durable-compaction section gains
   the ModelMessage/`prepareStep` example. Verify: `biome check`.

Worktree note: run `pnpm install` first; build `@context-chef/core` before the
middleware test run (it resolves core via `dist`).

## Alternatives considered

- **Breaking — retype V3 `compactHistory`/`planCompaction` to `ModelMessage[]`
  in place.** Single clean surface, no suffix. Rejected: breaks published 1.5.2
  and needs a major bump for a 1-day-old API — not worth it.
- **Normalize `ModelMessage → V3` then reuse `fromAISDK`/`toAISDK`.** Rejected:
  loses string-shorthand and image-part fidelity (V3 has no `ImagePart`), so the
  round-trip would silently reshape host input. A dedicated adapter preserves the
  original shape via pass-through.
- **One generic adapter parameterized by a dialect descriptor.** Rejected as
  over-engineering; the deltas are three small, localized cases. Two focused
  adapters sharing leaf helpers is clearer and lower-risk.
