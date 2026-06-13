# `summarizeHistory` / `summarizeMessages` Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose context-chef's one-shot history-summarization as a public, standalone API — `summarizeHistory` (core, IR-level) and `summarizeMessages` (ai-sdk-middleware, AI-SDK-prompt-level) — so a host that owns its own conversation store (e.g. Cherry Studio's durable compaction) can produce a summary identical to the in-flight `compress` path, **without** re-implementing the prompt, the role-flattening, the attachment/tool-result stripping, or the `<summary>` extraction.

**Architecture:** Extract the pure "produce a summary string from a slice of messages" core out of `Janitor.executeCompression` into a standalone `summarizeHistory(messages, compress, opts)` in core (which `executeCompression` then calls — keeping chef itself DRY and behavior-identical). The middleware adds a thin `summarizeMessages(prompt, model, opts)` wrapper that converts AI-SDK → IR (`fromAISDK`), builds the same `compress` callback the Janitor uses (`createCompressionAdapter`), and delegates to core. Both are additive — no behavior change for existing consumers.

**Tech Stack:** TypeScript, `@context-chef/core` + `@context-chef/ai-sdk-middleware`, Vitest, changesets. Standalone branch off `main`; release via the Version Packages PR.

**Motivation / consumer:** Cherry Studio P2-B stage 2 (durable cherry-driven compaction). Cherry rebuilds full topic history from SQLite each request, so compression must be persisted once and replayed — Cherry summarizes a message slice at history-build time, stores `{summary, boundary}`, and serves `[summary]+[recent]` thereafter. It needs chef's exact summarization (same prompt + stripping + format) as a callable function. This is a concrete consumer, not speculative surface; and the extraction makes `executeCompression` itself reuse the new function (net DRY).

---

## Background facts (verified 2026-06-13, against current `main`)

- `Janitor.executeCompression` (`packages/core/src/modules/janitor/index.ts:640-722`) is where the summary is produced today. The reusable core is lines **660-695**: build instruction (`Prompts.CONTEXT_COMPACTION_INSTRUCTION` + optional `customCompressionInstructions`) → strip (`stripLargeToolResultsForCompression` when `toolResultStubThreshold` set, then `stripAttachmentsForCompression`) → append `{role:'user', content: instruction}` → call `this.config.compressionModel(...)` → `Prompts.formatCompactSummary(raw)`.
- The **circuit breaker** (`this._consecutiveFailures`) and the **fallback summary** (catch branch, lines 698-705), the **wrapper** (`Prompts.getCompactSummaryWrapper`, 707-710), the **`onCompress` emit** (712-716), `_suppressNextCompression`, and the `[summaryMessage, ...toKeep]` assembly are Janitor-instance / orchestration concerns — they **stay** in `executeCompression`. Only the pure produce-summary-text step is extracted.
- `stripLargeToolResultsForCompression(messages, threshold)` and `stripAttachmentsForCompression(messages)` are **private** in `janitor/index.ts`. `summarizeHistory` will live in the same module so it uses them without exporting them.
- `Prompts` is barrel-exported via `export * from './prompts'` (`packages/core/src/index.ts:104`) — so `formatCompactSummary` / `getCompactSummaryWrapper` are already reachable by hosts; this plan does NOT need to touch Prompts exports.
- Middleware: `fromAISDK` / `toAISDK` are barrel-exported (`packages/ai-sdk-middleware/src/index.ts:8`). `createCompressionAdapter(model: LanguageModelV3): (messages: Message[]) => Promise<string>` is **private** in `middleware.ts:343` — it does the role-flattening (`tool`→user-text, assistant tool-calls→described text) needed because `generateText` only accepts system/user/assistant. `summarizeMessages` will live in `middleware.ts` so it reuses it.
- Core `Message` type and the `compress` callback shape `(messages: Message[]) => Promise<string>` are the same the Janitor already uses.

## Design decisions

- **`summarizeHistory` throws on model failure** (no internal fallback, no circuit breaker — those are Janitor-only). `executeCompression` keeps its existing try/catch around the call, so its behavior is byte-identical. Standalone callers (Cherry) catch and decide their own degradation.
- **Returns the raw summary text** (post-`formatCompactSummary`), NOT the wrapped user message. Wrapping with `getCompactSummaryWrapper` is the caller's choice (in-flight wraps; Cherry wraps when it builds its stored `user` marker). Keeps the function single-purpose and avoids forcing the wrapper framing on every consumer.
- **`opts` mirrors the two Janitor config knobs that affect summary production:** `customCompressionInstructions?: string`, `toolResultStubThreshold?: number`. Nothing else.
- **Additive only** → `minor` bump for both packages. No existing API changes.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/modules/janitor/index.ts` | Modify | Add exported `summarizeHistory(...)`; `executeCompression` delegates to it |
| `packages/core/src/index.ts` | Modify | Barrel-export `summarizeHistory` + `SummarizeHistoryOptions` |
| `packages/core/tests/summarizeHistory.test.ts` | Create | Pure-function behavior + parity with executeCompression |
| `packages/ai-sdk-middleware/src/middleware.ts` | Modify | Add exported `summarizeMessages(prompt, model, opts?)` |
| `packages/ai-sdk-middleware/src/index.ts` | Modify | Barrel-export `summarizeMessages` + `SummarizeMessagesOptions` |
| `packages/ai-sdk-middleware/tests/summarizeMessages.test.ts` | Create | AI-SDK→IR→summary, flattening reuse, opts pass-through |
| `.changeset/summarize-history-export.md` | Create | minor / minor |

---

### Task 1: core `summarizeHistory`

**Files:**
- Modify: `packages/core/src/modules/janitor/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/summarizeHistory.test.ts`

- [ ] **Step 1: Write the failing test** (`packages/core/tests/summarizeHistory.test.ts`)

```typescript
import { describe, expect, it, vi } from 'vitest'

import { summarizeHistory } from '../src';
import type { Message } from '../src';

const slice: Message[] = [
  { role: 'user', content: 'plan a trip to Kyoto' },
  { role: 'assistant', content: 'Sure — here is a 3-day itinerary ...' },
];

describe('summarizeHistory', () => {
  it('builds the compression prompt, calls compress, and extracts <summary>', async () => {
    const compress = vi.fn(async (messages: Message[]) => {
      // The instruction is appended as a trailing user message.
      const last = messages[messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.content).toContain('summary'); // CONTEXT_COMPACTION_INSTRUCTION mentions the <summary> contract
      // The original slice precedes it.
      expect(messages.length).toBe(slice.length + 1);
      return '<analysis>scratch</analysis><summary>Kyoto 3-day plan</summary>';
    });

    const out = await summarizeHistory(slice, compress);
    expect(compress).toHaveBeenCalledOnce();
    expect(out).toBe('Kyoto 3-day plan'); // analysis stripped, summary extracted
  });

  it('appends customCompressionInstructions when provided', async () => {
    const compress = vi.fn(async (messages: Message[]) => {
      expect(messages[messages.length - 1].content).toContain('Focus on costs');
      return '<summary>ok</summary>';
    });
    await summarizeHistory(slice, compress, { customCompressionInstructions: 'Focus on costs' });
  });

  it('propagates compress() failures (no internal fallback)', async () => {
    const compress = vi.fn(async () => {
      throw new Error('model down');
    });
    await expect(summarizeHistory(slice, compress)).rejects.toThrow('model down');
  });
});
```

(Confirm the exact `import` surface against the repo's test convention — other core tests import from `'../src'`. Adjust the `Message` import if the barrel differs.)

- [ ] **Step 2: Run — must FAIL** (`summarizeHistory` not exported)

```bash
pnpm --filter @context-chef/core test summarizeHistory
```

- [ ] **Step 3: Add `summarizeHistory` to `janitor/index.ts`**

Place it as a module-level exported function near `executeCompression` (it must be in this file to reach the private `stripLargeToolResultsForCompression` / `stripAttachmentsForCompression`). Add an options interface too:

```typescript
export interface SummarizeHistoryOptions {
  /** Extra instructions appended to (not replacing) the default compaction
   *  prompt — the default <analysis>/<summary> scaffolding is always kept. */
  customCompressionInstructions?: string;
  /** Replace tool-result content longer than this many chars with a one-line
   *  metadata stub before summarizing (saves summarizer tokens). */
  toolResultStubThreshold?: number;
}

/**
 * Produce a compression summary for a slice of conversation `messages`,
 * using the same prompt, attachment/tool-result stripping, and <summary>
 * extraction as the in-flight `compress` path. Returns the raw summary
 * text (post-`formatCompactSummary`) — the caller wraps it (e.g. with
 * `Prompts.getCompactSummaryWrapper`) if it wants the continuation framing.
 *
 * Pure: no circuit breaker, no fallback. THROWS if `compress` throws —
 * callers decide their own degradation. `Janitor.executeCompression`
 * delegates here and keeps its own try/catch + circuit breaker.
 *
 * @param messages   The slice to summarize (conversation only; exclude the
 *                   standing system prompt).
 * @param compress   Model callback: `(messages) => Promise<string>` (e.g.
 *                   the ai-sdk-middleware compression adapter).
 */
export async function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts: SummarizeHistoryOptions = {},
): Promise<string> {
  let instruction = Prompts.CONTEXT_COMPACTION_INSTRUCTION;
  const extra = opts.customCompressionInstructions?.trim();
  if (extra) {
    instruction += `\n\nAdditional Instructions:\n${extra}`;
  }

  const stubbed =
    opts.toolResultStubThreshold !== undefined
      ? stripLargeToolResultsForCompression(messages, opts.toolResultStubThreshold)
      : messages;

  const compressionMessages: Message[] = [
    ...stripAttachmentsForCompression(stubbed),
    { role: 'user', content: instruction },
  ];

  const raw = await compress(compressionMessages);
  return Prompts.formatCompactSummary(raw);
}
```

- [ ] **Step 4: Refactor `executeCompression` to delegate** (behavior-identical)

Replace the instruction-build + try/catch summary-production block (current lines 660-705) with:

```typescript
    let summaryText: string;
    try {
      summaryText = await summarizeHistory(toCompress, this.config.compressionModel, {
        customCompressionInstructions: this.config.customCompressionInstructions,
        toolResultStubThreshold: this.config.toolResultStubThreshold,
      });
      // Reset circuit breaker on success.
      this._consecutiveFailures = 0;
    } catch (error) {
      // Increment circuit breaker. After MAX_CONSECUTIVE_COMPRESSION_FAILURES,
      // compress() will short-circuit to avoid futile retries.
      this._consecutiveFailures++;
      summaryText =
        Prompts.getFallbackCompressionSummary(toCompress.length) +
        `\n(Compression failed: ${error})`;
    }
```

Everything else in `executeCompression` (the no-model branch, the `toCompress.length === 0` guard, `summaryMessage` wrapping, `onCompress` emit, `_suppressNextCompression`, the return) is unchanged. `this.config.compressionModel` is non-null here (guarded above), so passing it as `compress` is safe.

- [ ] **Step 5: Barrel-export from `packages/core/src/index.ts`**

In the `export { ... } from './modules/janitor'` block (the one that already exports `Janitor`, `compactMessages`, `groupIntoTurns`, `CompressionDetails`, etc.), add `summarizeHistory` and `type SummarizeHistoryOptions`.

- [ ] **Step 6: Run core tests — PASS (new + the full existing janitor suite)**

```bash
pnpm --filter @context-chef/core test
```
Expected: the new `summarizeHistory` tests pass AND the existing `janitor/index.test.ts` suite stays green (proving the `executeCompression` refactor is behavior-identical — especially the compression, onCompress-boundary, and circuit-breaker tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/modules/janitor/index.ts packages/core/src/index.ts packages/core/tests/summarizeHistory.test.ts
git commit --signoff -m "feat(core): extract & export summarizeHistory

Pure one-shot summary production (prompt + attachment/tool-result stripping
+ <summary> extraction), extracted from Janitor.executeCompression which now
delegates to it (behavior-identical, DRY). Throws on model failure; the
Janitor keeps its circuit breaker + fallback. Lets external hosts produce a
summary identical to the in-flight compress path."
```

---

### Task 2: middleware `summarizeMessages`

**Files:**
- Modify: `packages/ai-sdk-middleware/src/middleware.ts`
- Modify: `packages/ai-sdk-middleware/src/index.ts`
- Test: `packages/ai-sdk-middleware/tests/summarizeMessages.test.ts`

- [ ] **Step 1: Write the failing test** (`packages/ai-sdk-middleware/tests/summarizeMessages.test.ts`)

Use the repo's existing mock-model pattern (see `tests/middleware.test.ts` for how it stubs a `LanguageModelV3`'s `doGenerate`). The summarizer calls `generateText({ model, ... })` internally via `createCompressionAdapter`, so the mock model's `doGenerate` must return text.

```typescript
import type { LanguageModelV3, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';

import { summarizeMessages } from '../src';

// Minimal V3 mock returning a fixed summary; mirrors tests/middleware.test.ts.
function mockModel(text: string): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: vi.fn(async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    })),
    doStream: vi.fn(),
  } as unknown as LanguageModelV3;
}

const prompt: LanguageModelV3Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'plan a trip' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'here is a plan' }] },
];

describe('summarizeMessages', () => {
  it('converts AI-SDK prompt → IR, summarizes, returns extracted <summary>', async () => {
    const model = mockModel('<analysis>x</analysis><summary>trip plan</summary>');
    const out = await summarizeMessages(prompt, model);
    expect(out).toBe('trip plan');
    expect((model.doGenerate as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('passes toolResultStubThreshold through to core', async () => {
    const model = mockModel('<summary>ok</summary>');
    const out = await summarizeMessages(prompt, model, { toolResultStubThreshold: 5000 });
    expect(out).toBe('ok');
  });
});
```

(Match the exact mock shape to `tests/middleware.test.ts` — if that file exports a helper for building a mock V3 model, reuse it instead of redefining `mockModel`.)

- [ ] **Step 2: Run — must FAIL** (`summarizeMessages` not exported)

```bash
pnpm --filter @context-chef/ai-sdk-middleware test summarizeMessages
```

- [ ] **Step 3: Add `summarizeMessages` to `middleware.ts`**

Place it after `createCompressionAdapter` (so it can call it). Import `summarizeHistory` + `SummarizeHistoryOptions` from `@context-chef/core` (add to the existing core import block alongside `Prompts`, `fromAISDK` is from `./adapter`).

```typescript
export interface SummarizeMessagesOptions {
  customCompressionInstructions?: string;
  toolResultStubThreshold?: number;
}

/**
 * Summarize an AI-SDK prompt slice into a single summary string, using the
 * same pipeline as the in-flight `compress` path (role-flattening via the
 * compression adapter + core `summarizeHistory`). Returns the raw summary
 * text — wrap it with `Prompts.getCompactSummaryWrapper` if you want the
 * "continued conversation" framing.
 *
 * For hosts that own their conversation store and persist the summary
 * themselves (durable compaction) instead of relying on the in-flight
 * middleware. Throws if the model call fails.
 */
export async function summarizeMessages(
  prompt: LanguageModelV3Prompt,
  model: LanguageModelV3,
  opts: SummarizeMessagesOptions = {},
): Promise<string> {
  const ir = fromAISDK(prompt).filter((m) => m.role !== 'system');
  return summarizeHistory(ir, createCompressionAdapter(model), opts);
}
```

Verify against the real types: `fromAISDK` returns `Message[]`; `createCompressionAdapter(model)` returns `(messages: Message[]) => Promise<string>` (matches `summarizeHistory`'s `compress` param). The `.filter(role !== 'system')` mirrors how `createMiddleware`'s `transformParams` separates standing system instructions from the conversation before compression — a host's slice usually has none, but filtering keeps behavior consistent if it does.

- [ ] **Step 4: Barrel-export from `packages/ai-sdk-middleware/src/index.ts`**

Add `export { summarizeMessages, type SummarizeMessagesOptions } from './middleware'` (or extend the existing `./middleware` export line — currently only `createMiddleware` is exported from it).

- [ ] **Step 5: Run middleware tests — PASS (new + existing)**

```bash
pnpm --filter @context-chef/ai-sdk-middleware test
```
Expected: new tests pass; existing `middleware.test.ts` / `adapter.test.ts` / `truncator.test.ts` stay green.

- [ ] **Step 6: Commit**

```bash
git add packages/ai-sdk-middleware/src/middleware.ts packages/ai-sdk-middleware/src/index.ts packages/ai-sdk-middleware/tests/summarizeMessages.test.ts
git commit --signoff -m "feat(ai-sdk-middleware): add summarizeMessages

Thin AI-SDK wrapper over core summarizeHistory: fromAISDK → compression
adapter (role-flattening) → summary text. Lets hosts produce a summary
identical to the in-flight compress path from an AI-SDK prompt slice."
```

---

### Task 3: changeset + full verify + release

- [ ] **Step 1: Changeset** (`.changeset/summarize-history-export.md`)

```markdown
---
'@context-chef/core': minor
'@context-chef/ai-sdk-middleware': minor
---

Expose one-shot history summarization as a standalone API.

- **`summarizeHistory(messages, compress, opts?)`** (core): produces a compression summary for a message slice using the same prompt, attachment/tool-result stripping, and `<summary>` extraction as the in-flight `compress` path. Extracted from `Janitor.executeCompression`, which now delegates to it (behavior-identical). Pure — throws on model failure; the Janitor keeps its own circuit breaker + fallback.
- **`summarizeMessages(prompt, model, opts?)`** (ai-sdk-middleware): thin AI-SDK wrapper — `fromAISDK` → compression adapter (role-flattening) → `summarizeHistory`. Returns the raw summary text (wrap with `Prompts.getCompactSummaryWrapper` for the continuation framing).

For hosts that own their conversation store and persist compression themselves (durable compaction) rather than relying on the in-flight middleware.
```

- [ ] **Step 2: Full build + test + typecheck across the monorepo**

```bash
pnpm -r build && pnpm -r test 2>&1 | grep -E "Test Files|Tests |FAIL|failed" | tail
```
Expected: core + ai-sdk-middleware + tanstack-ai all green. (Rebuild matters — `ai-sdk-middleware` tests resolve `@context-chef/core` from its built `dist`; a stale dist would fail to see `summarizeHistory`. `pnpm -r build` first.)

- [ ] **Step 3: Lint (biome) the changed files**

```bash
pnpm biome check --write packages/core/src/modules/janitor/index.ts packages/ai-sdk-middleware/src/middleware.ts packages/core/tests/summarizeHistory.test.ts packages/ai-sdk-middleware/tests/summarizeMessages.test.ts
```
Re-stage + amend if biome reformats.

- [ ] **Step 4: Commit changeset, push, open PR**

```bash
git add .changeset/summarize-history-export.md
git commit --signoff -m "chore(changeset): summarizeHistory + summarizeMessages (minor)"
git push -u origin <branch>
```
Open the PR; on merge, the changesets Version Packages PR bumps core + ai-sdk-middleware (minor) for release. Cherry then bumps the dep and consumes `summarizeMessages` in P2-B stage 2.

---

## Self-review checklist

- **DRY both ways:** `executeCompression` reuses `summarizeHistory` (chef internal), and Cherry reuses it via `summarizeMessages` (external) — one summarization implementation total.
- **Behavior-identical for existing consumers:** the only runtime change to the existing path is that `executeCompression`'s summary block now calls an extracted function; the surrounding circuit-breaker / fallback / wrapper / onCompress logic is untouched. Pinned by the existing janitor suite staying green.
- **No new coupling in core:** `summarizeHistory` takes a `compress` callback — core stays AI-SDK-free; the AI-SDK knowledge lives only in the middleware wrapper.
- **Additive surface, concrete consumer:** both functions have a named consumer (Cherry P2-B stage 2); not speculative. minor bump is correct (no breaking change).
- **Returns raw text, not wrapped:** keeps the function single-purpose; callers opt into `getCompactSummaryWrapper` (already barrel-exported via `Prompts`).
