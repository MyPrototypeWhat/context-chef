# Durable compaction → core

**Date:** 2026-06-16
**Status:** Approved design, pending implementation plan
**Packages:** `@context-chef/core` (minor), `@context-chef/ai-sdk-middleware` (patch)

## Problem

`planCompaction` and `compactHistory` were added in commit `a461ef8` (unreleased,
sitting in release PR #38 as `ai-sdk-middleware@1.5.2`). They live in
`packages/ai-sdk-middleware/src/compaction.ts`, but their algorithm is
provider-agnostic: it operates on the core IR (`Message[]`) and only touches AI
SDK types at the in/out boundary.

This is the wrong altitude. The library already factored its compaction engine
into core — `groupIntoTurns`, `compactMessages`, `summarizeHistory`,
`Prompts.getCompactSummaryWrapper` all live in `@context-chef/core`, and
middleware's `summarizeMessages` is already a thin `fromAISDK → core → toAISDK`
shell. The two new helpers broke that contract by putting the logic in the
boundary layer instead of core.

## Goal

Move the durable-compaction engine into core (IR layer, provider-agnostic) and
reduce the middleware functions to thin adapters. **The middleware public API
signatures do not change** — this is an internal refactor, not a breaking change.

Once in core, durable compaction is a general capability of the IR layer (the AI
SDK path gets it out of the box; direct-core adapter users can opt in by
assembling their own `Message[]`), instead of being locked to the AI SDK package.

## Scope

In scope:
- `@context-chef/core`: new `planCompaction` / `compactHistory` over IR.
- `@context-chef/ai-sdk-middleware`: shrink the two functions to thin wrappers.

Out of scope (deliberately, YAGNI):
- `@context-chef/tanstack-ai` does **not** get a durable-compaction surface in
  this change. It depends on core, so it *could* re-export later, but there is no
  current demand.

## Design

### core — new file `packages/core/src/modules/janitor/durableCompaction.ts`

Exports four symbols via core `index.ts`:

```ts
export interface PlanCompactionOptions {
  keepRecentTurns: number;
}

export interface CompactionPlan {
  system: Message[];
  toSummarize: Message[];
  toKeep: Message[];
}

// Pure, synchronous turn-safe split over IR.
export function planCompaction(
  history: Message[],
  options: PlanCompactionOptions,
): CompactionPlan;

// One-shot durable compaction. Takes an injected `compress` callback (NOT a
// model) so core stays provider-agnostic — same pattern as `summarizeHistory`.
export async function compactHistory(
  history: Message[],
  compress: (messages: Message[]) => Promise<string>,
  options: PlanCompactionOptions & SummarizeHistoryOptions,
): Promise<Message[]>;
```

`planCompaction` internals: `ensureValidHistory(history)` (core's own util) →
separate `role === 'system'` → `groupIntoTurns(conversation)` → split at
`turns.length - keepRecentTurns` on the turn's `startIndex`. Everything is
`Message[]` end to end; no AI SDK types.

`compactHistory` internals: `planCompaction` → if `toSummarize` is empty
**return the input `history` reference unchanged** (see no-op contract below) →
`summarizeHistory(plan.toSummarize, compress, summarizeOptions)` → if the summary
is blank, return `history` unchanged → otherwise build a single `user` message
with `content: Prompts.getCompactSummaryWrapper(summary)` (a plain string, since
core `Message.content` is `string`) and return
`[...plan.system, summaryMessage, ...plan.toKeep]`.

### Input contract (must be explicit in JSDoc)

`planCompaction` takes a **flat `Message[]` with any system messages inline**
(`role: 'system'`). This matches what `fromAISDK` produces. It does **not** match
the direct-core adapters (`fromAnthropic` / `fromOpenAI` / `fromGemini`), which
return `{ system, history }` with system already extracted — those callers must
reassemble `planCompaction([...system, ...history], …)` themselves. The JSDoc
states this so the contract is unambiguous after the move.

### No-op reference-identity contract (preserved)

The existing middleware API guarantees that `compactHistory` returns the **same
prompt reference** when there is nothing to compact or the summarizer yields no
text — `compaction.test.ts` asserts this with `toBe(prompt)` (lines 166, 174),
and callers rely on it to skip persistence writes on a no-op.

This guarantee is preserved at both layers:
- core `compactHistory` returns the **exact input `history` reference** on no-op.
- the middleware wrapper short-circuits on that reference:

```ts
const ir = fromAISDK(prompt);
const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
return result === ir ? prompt : toAISDK(result); // no-op → original prompt ref
```

One line, no behavior change, tests stay green.

### ai-sdk-middleware — thin shells in `compaction.ts`

`planCompaction(prompt, options)` and `compactHistory(prompt, model, options)`
keep their **current signatures**. Internals:

```ts
export function planCompaction(prompt, options) {
  const p = corePlanCompaction(fromAISDK(prompt), options);
  return {
    system: toAISDK(p.system),
    toSummarize: toAISDK(p.toSummarize),
    toKeep: toAISDK(p.toKeep),
  };
}

export async function compactHistory(prompt, model, options) {
  const ir = fromAISDK(prompt);
  const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
  return result === ir ? prompt : toAISDK(result);
}
```

`middleware.ts` change: promote the currently module-private
`createCompressionAdapter` to a module-level export (consumed by `compaction.ts`;
**not** added to the package `index.ts` — internal only). `generateText` stays in
middleware — it is the only true AI SDK binding and must never move to core.

Types: `PlanCompactionOptions` is `{ keepRecentTurns }` — provider-agnostic and
identical to core's, so middleware **re-exports core's** type. `CompactionPlan`,
however, is AI-SDK-typed at the middleware boundary (`system`/`toSummarize`/
`toKeep` are `LanguageModelV3Prompt`, the output of `toAISDK`), so middleware
**keeps its own** `CompactionPlan` interface distinct from core's `Message[]`-typed
one.

### No new import cycle

Verified: `middleware.ts` does not import `compaction.ts`; the dependency is the
one-way `compaction.ts → middleware.ts` that already exists. Importing
`createCompressionAdapter` keeps that direction.

### Accepted minor cost

The middleware path runs `ensureValidHistory` twice (once inside `fromAISDK`,
once inside core `planCompaction`). It is idempotent; the redundant pass is
negligible and not specially handled.

## Testing

- **core** — new `packages/core/src/modules/janitor/durableCompaction.test.ts`,
  exercising the algorithm directly on IR `Message[]` fixtures (turn-safe split,
  system preserved verbatim, no-op returns input ref, blank-summary returns input
  ref, `keepRecentTurns = 0` summarizes all, `keepRecentTurns ≥ turn count` keeps
  all, tool-result pairing never orphaned). This is a **fixture rewrite**, not a
  copy of the AI-SDK fixtures — the algorithm assertions currently in the
  middleware test move here.
- **middleware** — slim `compaction.test.ts` down to boundary concerns:
  `fromAISDK/toAISDK` round-trip correctness, delegation to core, and the no-op
  reference short-circuit (`toBe(prompt)` stays).

## Docs & versioning

- `README.md` / `README.zh-CN.md`: move the durable-compaction section into a
  "core general capability" framing; AI SDK path is the out-of-box example.
- Edit the **existing, unconsumed** changeset
  `.changeset/durable-compaction-helpers.md` (do not add a new one) to declare
  `@context-chef/core: minor` + `@context-chef/ai-sdk-middleware: patch`, and
  reword it so core is the home and middleware is the thin wrapper. `workspace:*`
  + `updateInternalDependencies: patch` align the dependency range automatically.

## Sequencing

Do this **before PR #38 merges**. The two helpers are not published yet, so
landing the refactor first means core ships them correctly from day one (as
`core@3.8.0`), the middleware public API is never observed with the logic in the
wrong layer, and PR #38 auto-recalculates to publish `core@3.8.0` +
`ai-sdk-middleware@1.5.2` together.

This work lands on `main` (via this branch); the changeset edit triggers the
changesets action to update release PR #38.

## Phases (≤5 files each, verify between)

1. **core** — `durableCompaction.ts` + core `index.ts` export +
   `durableCompaction.test.ts`. Verify: `pnpm -r typecheck && pnpm -r test`.
2. **middleware** — `compaction.ts` shells + `middleware.ts` exports
   `createCompressionAdapter` + `compaction.test.ts` slimmed. Verify: same.
3. **docs + changeset** — `README.md` + `README.zh-CN.md` + `.changeset` edit.
   Verify: `biome check`.
