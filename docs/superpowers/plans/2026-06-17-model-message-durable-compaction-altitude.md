# ModelMessage Durable-Compaction Altitude — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ModelMessage[]`-altitude durable-compaction API to `@context-chef/ai-sdk-middleware` (the type `prepareStep`/`generateText` actually hand the host), and deprecate the mis-altitude `V3Prompt` versions — additive, non-breaking, shipped as a minor.

**Architecture:** A new `ModelMessage ↔ IR` adapter (`modelMessageAdapter.ts`) mirrors the existing V3 `adapter.ts` with the same lossless pass-through strategy, handling the three `ModelMessage`-only shapes (string-shorthand content, `ImagePart`, approval parts). Thin durable entry points (`compactModelMessages`, `planCompactionModelMessages`, `summarizeModelMessages`) reuse the **same** core IR engine (`compactHistory`/`planCompaction`/`summarizeHistory`) and `createCompressionAdapter` — no new compaction or flattening logic. Core is untouched.

**Tech Stack:** TypeScript (strict), Vitest, pnpm workspace monorepo, AI SDK v6 (`ai` + `@ai-sdk/provider`), Biome.

**Spec:** `docs/superpowers/specs/2026-06-17-model-message-durable-compaction-altitude-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `packages/ai-sdk-middleware/src/adapter.ts` | V3 `fromAISDK`/`toAISDK` + shared `stringifyToolOutput` | Modify — `export` the helper |
| `packages/ai-sdk-middleware/src/modelMessageAdapter.ts` | `ModelMessage ↔ IR` (`fromModelMessages`/`toModelMessages`) | Create |
| `packages/ai-sdk-middleware/src/compaction.ts` | Durable entries; add ModelMessage `compact`/`plan`; `@deprecated` on V3 pair | Modify |
| `packages/ai-sdk-middleware/src/middleware.ts` | Widen `createCompressionAdapter` to `LanguageModel`; add `summarizeModelMessages`; repoint warning | Modify |
| `packages/ai-sdk-middleware/src/index.ts` | Public exports | Modify |
| `packages/ai-sdk-middleware/tests/modelMessageAdapter.test.ts` | Adapter round-trip coverage | Create |
| `packages/ai-sdk-middleware/tests/compactionModelMessages.test.ts` | ModelMessage compact/plan boundary tests | Create |
| `packages/ai-sdk-middleware/tests/summarizeMessages.test.ts` | Add `summarizeModelMessages` case | Modify |
| `packages/ai-sdk-middleware/README.md` / `README.zh-CN.md` | Headline durable example → ModelMessage; deprecation note | Modify |

**Invariants every task must preserve (regression-covered):** no-op returns the **input reference** (`toBe`); reasoning byte-exact via pass-through; tool-role flattening reused from `createCompressionAdapter`; turn-safe split inherited from core.

---

## Task 0: Worktree setup & baseline green

**Files:** none (environment only)

- [ ] **Step 1: Install deps in the worktree**

Run: `pnpm install`
Expected: completes; `node_modules` populated (worktrees do not inherit the parent's install).

- [ ] **Step 2: Build core (middleware resolves it via `dist`)**

Run: `pnpm --filter @context-chef/core build`
Expected: emits `packages/core/dist/*`; exit 0.

- [ ] **Step 3: Confirm the middleware suite is green before changes**

Run: `pnpm --filter @context-chef/ai-sdk-middleware test`
Expected: all existing tests PASS (adapter, compaction, summarizeMessages, middleware, truncator).

---

## Task 1: Export the shared `stringifyToolOutput`

**Files:**
- Modify: `packages/ai-sdk-middleware/src/adapter.ts:259`

The ModelMessage adapter must reuse this helper, not copy it. It currently reads only `.type`/`.value`, so it works for both `LanguageModelV3ToolResultOutput` and `ModelMessage`'s structurally-identical `ToolResultOutput`.

- [ ] **Step 1: Add the `export` keyword**

Change the declaration at `adapter.ts:259` from:

```ts
function stringifyToolOutput(output: LanguageModelV3ToolResultOutput): string {
```

to:

```ts
export function stringifyToolOutput(output: LanguageModelV3ToolResultOutput): string {
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @context-chef/ai-sdk-middleware typecheck`
Expected: exit 0 (no other change).

- [ ] **Step 3: Commit**

```bash
git add packages/ai-sdk-middleware/src/adapter.ts
git commit -m "refactor(ai-sdk-middleware): export stringifyToolOutput for reuse"
```

---

## Task 2: ModelMessage ↔ IR adapter (TDD)

**Files:**
- Create: `packages/ai-sdk-middleware/src/modelMessageAdapter.ts`
- Test: `packages/ai-sdk-middleware/tests/modelMessageAdapter.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/ai-sdk-middleware/tests/modelMessageAdapter.test.ts`:

```ts
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { fromModelMessages, toModelMessages } from '../src/modelMessageAdapter';

describe('fromModelMessages', () => {
  it('keeps string-shorthand user content as text in IR', () => {
    const ir = fromModelMessages([{ role: 'user', content: 'hello' }]);
    expect(ir[0].content).toBe('hello');
    expect(ir[0]._mmUserContent).toBe('hello');
  });

  it('extracts text and records image + file parts as attachments', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'imgdata', mediaType: 'image/png' },
          { type: 'file', data: 'pdfdata', mediaType: 'application/pdf', filename: 'r.pdf' },
        ],
      },
    ];
    const ir = fromModelMessages(messages);
    expect(ir[0].content).toBe('look');
    expect(ir[0].attachments).toEqual([
      { mediaType: 'image/png', data: 'imgdata' },
      { mediaType: 'application/pdf', data: 'pdfdata', filename: 'r.pdf' },
    ]);
  });

  it('extracts assistant tool calls and reasoning', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'answer' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { a: 1 } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } }],
      },
    ];
    const assistant = fromModelMessages(messages).find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('answer');
    expect(assistant?.thinking).toEqual({ thinking: 'thinking' });
    expect(assistant?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
    ]);
  });

  it('splits a tool message into one IR message per tool-result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'bar', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'r1' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'bar', output: { type: 'json', value: { n: 2 } } },
        ],
      },
    ];
    const ir = fromModelMessages(messages).filter((m) => m.role === 'tool');
    expect(ir).toHaveLength(2);
    expect(ir[0]).toMatchObject({ content: 'r1', tool_call_id: 'c1' });
    expect(ir[1]).toMatchObject({ content: '{"n":2}', tool_call_id: 'c2' });
  });
});

describe('round-trip (ModelMessage → IR → ModelMessage)', () => {
  // Fixtures are valid histories (lead with user; every tool-result has a
  // preceding assistant tool-call) so ensureValidHistory is a no-op and the
  // round-trip is verbatim — same discipline as tests/adapter.test.ts.
  const cases: Record<string, ModelMessage[]> = {
    'string content stays a string': [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ],
    'array content with text + file': [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'file', data: 'd', mediaType: 'image/png' },
        ],
      },
    ],
    'image parts': [
      { role: 'user', content: [{ type: 'image', image: 'imgdata', mediaType: 'image/png' }] },
    ],
    'reasoning byte-exact': [
      { role: 'user', content: 'reason' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'exact reasoning bytes' },
          { type: 'text', text: 'final' },
        ],
      },
    ],
    'tool call + result': [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { q: 'x' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
        ],
      },
    ],
    'assistant tool-approval-request rides through verbatim': [
      { role: 'user', content: 'approve?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'need approval' },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
        ],
      },
    ],
    'tool-approval-response preserved in order after its result': [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: {} }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } },
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        ],
      },
    ],
    'providerOptions on a message': [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ],
  };

  for (const [name, original] of Object.entries(cases)) {
    it(name, () => {
      const roundTripped = toModelMessages(fromModelMessages(original));
      expect(roundTripped).toEqual(original);
    });
  }
});

describe('toModelMessages', () => {
  it('emits a text-part array for synthetic messages (e.g. summary) with no pass-through', () => {
    const result = toModelMessages([{ role: 'user', content: 'summary text' }]);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'summary text' }] }]);
  });

  it('reconstructs from IR fields when content was modified (e.g. cleared tool result)', () => {
    const ir = fromModelMessages([
      { role: 'user', content: 'run' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'run', output: { type: 'text', value: 'long' } },
        ],
      },
    ]);
    const toolIr = ir.find((m) => m.role === 'tool');
    if (!toolIr) throw new Error('expected tool IR message');
    toolIr.content = '[cleared]'; // simulate Janitor edit
    const result = toModelMessages(ir);
    const toolMsg = result.find((m) => m.role === 'tool');
    if (toolMsg?.role === 'tool') {
      const part = toolMsg.content[0];
      if (part.type === 'tool-result') {
        expect(part.output).toEqual({ type: 'text', value: '[cleared]' });
        expect(part.toolName).toBe('run');
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/modelMessageAdapter.test.ts`
Expected: FAIL — `Cannot find module '../src/modelMessageAdapter'`.

- [ ] **Step 3: Create the adapter implementation**

Create `packages/ai-sdk-middleware/src/modelMessageAdapter.ts`:

```ts
import type { LanguageModelV3ToolResultOutput } from '@ai-sdk/provider';
import {
  type Attachment,
  ensureValidHistory,
  type Message,
  type ToolCall,
} from '@context-chef/core';
import type { ModelMessage } from 'ai';

import { stringifyToolOutput } from './adapter';

// Content/part types derived from ModelMessage — no part-type imports needed
// (provider-utils does not export them all stably). Same trick as adapter.ts.
type UserContent = Extract<ModelMessage, { role: 'user' }>['content'];
type AssistantContent = Extract<ModelMessage, { role: 'assistant' }>['content'];
type ToolContent = Extract<ModelMessage, { role: 'tool' }>['content'];
type ProviderOptions = Extract<ModelMessage, { role: 'system' }>['providerOptions'];

/**
 * IR message carrying the original ModelMessage content for lossless round-trip.
 * Parallel to AISDKMessage (the V3 adapter's carrier) but typed to the
 * application-layer ModelMessage shapes, and on distinct `_mm*` fields so the two
 * adapters can never read each other's pass-through by accident.
 */
export interface ModelMessageIR extends Message {
  _mmUserContent?: UserContent;
  _mmAssistantContent?: AssistantContent;
  _mmToolContent?: ToolContent;
  _mmOriginalText?: string;
  _mmProviderOptions?: ProviderOptions;
  _mmToolName?: string;
}

/**
 * Converts AI SDK `ModelMessage[]` (the application/SDK altitude — what
 * `generateText`/`prepareStep` use) into context-chef IR.
 *
 * `content` may be a plain `string` (the SDK shorthand); it is preserved on the
 * `_mm*Content` pass-through so an unmodified message round-trips byte-exact
 * (string stays string). Boundary-sanitized via `ensureValidHistory`.
 *
 * Tool messages: one IR `role:'tool'` message per `tool-result` part (so
 * `groupIntoTurns`/orphan detection works per result). `tool-approval-response`
 * parts have no IR home; they are appended in order to the adjacent result's
 * pass-through so coalescing in `toModelMessages` restores them. A tool message
 * with no tool-result at all is dropped by sanitization (not a real durable
 * input).
 */
export function fromModelMessages(messages: ModelMessage[]): ModelMessageIR[] {
  const ir: ModelMessageIR[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      ir.push({
        role: 'system',
        content: msg.content,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      });
      continue;
    }

    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n');

      const attachments: Attachment[] = [];
      if (typeof msg.content !== 'string') {
        for (const part of msg.content) {
          if (part.type === 'file') {
            attachments.push({
              mediaType: part.mediaType,
              data: typeof part.data === 'string' ? part.data : '',
              ...(part.filename ? { filename: part.filename } : {}),
            });
          } else if (part.type === 'image') {
            attachments.push({
              mediaType: part.mediaType ?? 'image/*',
              data: typeof part.image === 'string' ? part.image : '',
            });
          }
        }
      }

      const m: ModelMessageIR = {
        role: 'user',
        content: text,
        _mmUserContent: msg.content,
        _mmOriginalText: text,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      };
      if (attachments.length) m.attachments = attachments;
      ir.push(m);
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      const attachments: Attachment[] = [];
      let thinking: { thinking: string } | undefined;

      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else {
        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              id: part.toolCallId,
              type: 'function',
              function: {
                name: part.toolName,
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
              },
            });
          } else if (part.type === 'reasoning') {
            thinking = { thinking: part.text };
          } else if (part.type === 'file') {
            attachments.push({
              mediaType: part.mediaType,
              data: typeof part.data === 'string' ? part.data : '',
              ...(part.filename ? { filename: part.filename } : {}),
            });
          }
          // text-result / tool-approval-request parts ride through _mmAssistantContent verbatim.
        }
      }

      const joined = textParts.join('\n');
      const m: ModelMessageIR = {
        role: 'assistant',
        content: joined,
        _mmAssistantContent: msg.content,
        _mmOriginalText: joined,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      };
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (thinking) m.thinking = thinking;
      if (attachments.length) m.attachments = attachments;
      ir.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      let anchor: ModelMessageIR | undefined;
      const pending: ToolContent = [];
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const text = stringifyToolOutput(part.output as LanguageModelV3ToolResultOutput);
          anchor = {
            role: 'tool',
            content: text,
            tool_call_id: part.toolCallId,
            _mmToolContent: [...pending, part],
            _mmOriginalText: text,
            _mmToolName: part.toolName,
          };
          pending.length = 0;
          ir.push(anchor);
        } else if (anchor?._mmToolContent) {
          anchor._mmToolContent.push(part);
        } else {
          pending.push(part);
        }
      }
    }
  }

  return ensureValidHistory(ir) as ModelMessageIR[];
}

function asMM(msg: Message): ModelMessageIR {
  return msg;
}

/**
 * Converts context-chef IR back to AI SDK `ModelMessage[]`.
 *
 * Unmodified messages emit their original content verbatim (via `_mm*` fields),
 * so string content stays a string and reasoning/approval parts round-trip
 * byte-exact. Janitor-modified messages and synthetic messages (e.g. a
 * compression summary, which has no pass-through) are rebuilt from IR fields.
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = asMM(messages[i]);
    const modified = msg._mmOriginalText !== undefined && msg._mmOriginalText !== msg.content;

    if (msg.role === 'system') {
      out.push({
        role: 'system',
        content: msg.content,
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content:
          !modified && msg._mmUserContent !== undefined
            ? msg._mmUserContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content:
          !modified && msg._mmAssistantContent !== undefined
            ? msg._mmAssistantContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      const content: ToolContent = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = asMM(messages[i]);
        const tModified = t._mmOriginalText !== undefined && t._mmOriginalText !== t.content;
        if (!tModified && t._mmToolContent) {
          content.push(...t._mmToolContent);
        } else {
          content.push({
            type: 'tool-result',
            toolCallId: t.tool_call_id ?? '',
            toolName: t._mmToolName ?? t.name ?? 'unknown',
            output: { type: 'text', value: t.content },
          });
        }
        i++;
      }
      out.push({ role: 'tool', content });
      continue;
    }

    i++;
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/modelMessageAdapter.test.ts`
Expected: PASS (all cases).
If `tsc`/vitest complains that `part.output` is not assignable to `LanguageModelV3ToolResultOutput`, the two output unions diverged — keep a thin local stringifier instead of the shared one; this is the one verify-at-implementation point from the spec.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @context-chef/ai-sdk-middleware typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ai-sdk-middleware/src/modelMessageAdapter.ts packages/ai-sdk-middleware/tests/modelMessageAdapter.test.ts
git commit -m "feat(ai-sdk-middleware): ModelMessage <-> IR adapter"
```

---

## Task 3: Widen `createCompressionAdapter` to `LanguageModel`

**Files:**
- Modify: `packages/ai-sdk-middleware/src/middleware.ts:18,385-387`

The ModelMessage entries pass the host's `model` straight through. `prepareStep`/`generateText` give `LanguageModel` (`string id | V3 | V2`), not the provider-layer `LanguageModelV3`. The adapter only forwards to `generateText` (which accepts `LanguageModel`), and the existing in-flight caller passes a `LanguageModelV3` (a subtype), so this is backward-compatible.

- [ ] **Step 1: Import `LanguageModel`**

At `middleware.ts:18`, change:

```ts
import { generateText, type LanguageModelMiddleware, type ModelMessage, pruneMessages } from 'ai';
```

to:

```ts
import {
  generateText,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  pruneMessages,
} from 'ai';
```

- [ ] **Step 2: Widen the parameter type**

At `middleware.ts:385`, change:

```ts
export function createCompressionAdapter(
  model: LanguageModelV3,
): (messages: Message[]) => Promise<string> {
```

to:

```ts
export function createCompressionAdapter(
  model: LanguageModel,
): (messages: Message[]) => Promise<string> {
```

- [ ] **Step 3: Typecheck + full suite (catch any in-flight-caller regression)**

Run: `pnpm --filter @context-chef/ai-sdk-middleware typecheck && pnpm --filter @context-chef/ai-sdk-middleware test`
Expected: exit 0; all tests PASS (the `createJanitor` and `summarizeMessages` callers still pass a `LanguageModelV3`, a subtype).

- [ ] **Step 4: Commit**

```bash
git add packages/ai-sdk-middleware/src/middleware.ts
git commit -m "refactor(ai-sdk-middleware): accept ai's LanguageModel in createCompressionAdapter"
```

---

## Task 4: `compactModelMessages` + `planCompactionModelMessages` (TDD)

**Files:**
- Modify: `packages/ai-sdk-middleware/src/compaction.ts`
- Test: `packages/ai-sdk-middleware/tests/compactionModelMessages.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/ai-sdk-middleware/tests/compactionModelMessages.test.ts`:

```ts
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactModelMessages, planCompactionModelMessages } from '../src/compaction';

/** Minimal V3 model whose summarization call returns a fixed string. A V3 model
 *  is a valid `LanguageModel`, so it exercises the widened model param too. */
function createSummarizerModel(summaryText = 'SUMMARY'): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate(_opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const content: LanguageModelV3Content[] = [{ type: 'text', text: summaryText }];
      const finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
      return {
        content,
        finishReason,
        warnings: [],
        usage: {
          inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        response: { id: 'id', timestamp: new Date(), modelId: 'test-model' },
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

/** N plain user/assistant turns (string shorthand), optional leading system. */
function plainTurns(n: number, withSystem = true): ModelMessage[] {
  const msgs: ModelMessage[] = withSystem ? [{ role: 'system', content: 'You are helpful.' }] : [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `q${i}` });
    msgs.push({ role: 'assistant', content: `a${i}` });
  }
  return msgs;
}

describe('planCompactionModelMessages', () => {
  it('splits on turn boundaries and round-trips each slice as ModelMessage[]', () => {
    const plan = planCompactionModelMessages(plainTurns(3), { keepRecentTurns: 2 });
    expect(plan.system.map((m) => m.role)).toEqual(['system']);
    expect(plan.toSummarize).toHaveLength(4);
    expect(plan.toKeep).toHaveLength(2);
    expect(plan.toKeep[0].role).toBe('user');
  });

  it('never splits an assistant tool-call from its tool result', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'foo', input: { a: 1 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'foo', output: { type: 'text', value: 'ok' } }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const plan = planCompactionModelMessages(messages, { keepRecentTurns: 3 });
    expect(plan.toSummarize.map((m) => m.role)).toEqual(['user']);
    expect(plan.toKeep.map((m) => m.role)).toEqual(['assistant', 'tool', 'user', 'assistant']);
  });
});

describe('compactModelMessages', () => {
  it('returns [...system, summary, ...toKeep] with a wrapped user summary', async () => {
    const messages = plainTurns(4); // system + 8 messages
    const result = await compactModelMessages(messages, createSummarizerModel('Hello'), {
      keepRecentTurns: 2,
    });
    expect(result[0]).toEqual(messages[0]); // system preserved
    const summary = result[1];
    const text =
      summary.role === 'user' && typeof summary.content !== 'string' && summary.content[0].type === 'text'
        ? summary.content[0].text
        : '';
    expect(text).toContain('Hello');
    expect(text).toContain('continued from a previous conversation');
    expect(result.length).toBe(1 + 1 + 2);
  });

  it('returns the INPUT reference unchanged when nothing is old enough', async () => {
    const messages = plainTurns(2);
    const result = await compactModelMessages(messages, createSummarizerModel(), {
      keepRecentTurns: 99,
    });
    expect(result).toBe(messages); // same reference — caller skips persistence
  });

  it('returns the INPUT reference unchanged when the summary is blank', async () => {
    const messages = plainTurns(4);
    const result = await compactModelMessages(messages, createSummarizerModel('   '), {
      keepRecentTurns: 1,
    });
    expect(result).toBe(messages);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/compactionModelMessages.test.ts`
Expected: FAIL — `compactModelMessages`/`planCompactionModelMessages` are not exported.

- [ ] **Step 3: Add the implementation to `compaction.ts`**

In `packages/ai-sdk-middleware/src/compaction.ts`, update the imports at the top:

```ts
import type { LanguageModel, ModelMessage } from 'ai';
import type { LanguageModelV3, LanguageModelV3Prompt } from '@ai-sdk/provider';
import {
  compactHistory as coreCompactHistory,
  planCompaction as corePlanCompaction,
  type PlanCompactionOptions,
} from '@context-chef/core';

import { fromAISDK, toAISDK } from './adapter';
import { fromModelMessages, toModelMessages } from './modelMessageAdapter';
import { createCompressionAdapter, type SummarizeMessagesOptions } from './middleware';
```

Then append the new entries at the end of the file:

```ts
export interface CompactionPlanModelMessages {
  /** System messages, preserved verbatim — standing instructions are never summarized. */
  system: ModelMessage[];
  /** The old conversation slice to summarize (system excluded). Empty when nothing is old enough. */
  toSummarize: ModelMessage[];
  /** The recent conversation turns to keep verbatim. */
  toKeep: ModelMessage[];
}

/**
 * Turn-safe split for durable compaction at the **ModelMessage** altitude — the
 * type `prepareStep`/`generateText` hand you. Converts to IR via
 * {@link fromModelMessages}, splits on turn boundaries via core's
 * `planCompaction`, and converts each slice back via {@link toModelMessages}.
 * Summarize `toSummarize`, then persist `[...system, <summary>, ...toKeep]`.
 */
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

/**
 * One-shot durable compaction at the **ModelMessage** altitude: plan a turn-safe
 * split, summarize the old slice, and return a new `ModelMessage[]` ready to
 * persist — `[...system, <summary>, ...toKeep]`. Use it in your own own-the-store
 * loop, or inside a `ToolLoopAgent` `prepareStep` (`return { messages: await
 * compactModelMessages(messages, model, opts) }`).
 *
 * `model` is `ai`'s `LanguageModel` (string id | V3 | V2) — exactly what
 * `prepareStep`/`generateText` give you. Reuses core's `compactHistory` +
 * `createCompressionAdapter` (tool-role flattening); no model is called directly.
 *
 * Returns the **input `messages` reference unchanged** when there is nothing old
 * enough to compact or the summarizer yields no text, so callers can skip
 * persistence on a no-op via `result === messages`. Throws only if the model call
 * throws.
 */
export async function compactModelMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  options: PlanCompactionOptions & SummarizeMessagesOptions,
): Promise<ModelMessage[]> {
  const ir = fromModelMessages(messages);
  const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
  // core returns the input IR reference on a no-op — preserve the original
  // `messages` reference so callers can skip persistence via `result === messages`.
  return result === ir ? messages : toModelMessages(result);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/compactionModelMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @context-chef/ai-sdk-middleware typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ai-sdk-middleware/src/compaction.ts packages/ai-sdk-middleware/tests/compactionModelMessages.test.ts
git commit -m "feat(ai-sdk-middleware): compactModelMessages + planCompactionModelMessages"
```

---

## Task 5: `summarizeModelMessages` (TDD)

**Files:**
- Modify: `packages/ai-sdk-middleware/src/middleware.ts` (add export near `summarizeMessages`)
- Test: `packages/ai-sdk-middleware/tests/summarizeMessages.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `packages/ai-sdk-middleware/tests/summarizeMessages.test.ts` (inside the existing top-level `describe`, or a new one — match the file's current structure). Add the import `summarizeModelMessages` to the existing `../src/middleware` import line, and add:

```ts
describe('summarizeModelMessages', () => {
  it('summarizes a ModelMessage slice into a string, dropping system messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ];
    const text = await summarizeModelMessages(messages, createSummarizerModel('RECAP'));
    expect(text).toBe('RECAP');
  });

  it('returns empty string for an empty slice without a model call', async () => {
    const text = await summarizeModelMessages([], createSummarizerModel());
    expect(text).toBe('');
  });
});
```

(If `summarizeMessages.test.ts` lacks `createSummarizerModel`/`ModelMessage`, copy the `createSummarizerModel` factory from `tests/compactionModelMessages.test.ts` and add `import type { ModelMessage } from 'ai';`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/summarizeMessages.test.ts`
Expected: FAIL — `summarizeModelMessages` is not exported.

- [ ] **Step 3: Implement next to `summarizeMessages` in `middleware.ts`**

Add the import at the top of `middleware.ts` (with the other local imports, after the `./adapter` import):

```ts
import { fromModelMessages } from './modelMessageAdapter';
```

Then, immediately after the `summarizeMessages` function (end of `middleware.ts`), add:

```ts
/**
 * ModelMessage-altitude sibling of {@link summarizeMessages}: summarize a
 * `ModelMessage[]` slice into a single summary string via the same pipeline
 * (role-flattening + core `summarizeHistory`). System messages are dropped.
 * Empty input returns `''` without a model call; throws if the model call fails.
 */
export async function summarizeModelMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  opts: SummarizeMessagesOptions = {},
): Promise<string> {
  const ir = fromModelMessages(messages).filter((m) => m.role !== 'system');
  return summarizeHistory(ir, createCompressionAdapter(model), opts);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @context-chef/ai-sdk-middleware exec vitest run tests/summarizeMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-middleware/src/middleware.ts packages/ai-sdk-middleware/tests/summarizeMessages.test.ts
git commit -m "feat(ai-sdk-middleware): summarizeModelMessages"
```

---

## Task 6: Export new API; deprecate V3 pair; repoint warning

**Files:**
- Modify: `packages/ai-sdk-middleware/src/index.ts:9-15`
- Modify: `packages/ai-sdk-middleware/src/compaction.ts` (deprecation JSDoc)
- Modify: `packages/ai-sdk-middleware/src/middleware.ts:86` (warning text)

- [ ] **Step 1: Export the new symbols from `index.ts`**

Replace the compaction export block (`index.ts:9-14`) with:

```ts
export {
  type CompactionPlan,
  type CompactionPlanModelMessages,
  compactHistory,
  compactModelMessages,
  type PlanCompactionOptions,
  planCompaction,
  planCompactionModelMessages,
} from './compaction';
```

And update the middleware export line (`index.ts:15`) to add `summarizeModelMessages`:

```ts
export {
  createMiddleware,
  summarizeMessages,
  summarizeModelMessages,
  type SummarizeMessagesOptions,
} from './middleware';
```

- [ ] **Step 2: Add `@deprecated` JSDoc to the V3 pair**

In `compaction.ts`, prepend to the existing JSDoc of `planCompaction` (above `export function planCompaction`):

```
 * @deprecated Use {@link planCompactionModelMessages}. This V3-prompt variant is
 * the provider-protocol altitude — a type you never persist. Removed in the next
 * major.
```

And to `compactHistory`:

```
 * @deprecated Use {@link compactModelMessages}. `LanguageModelV3Prompt` is the
 * provider-protocol altitude (ephemeral, never persisted); durable compaction
 * belongs at the ModelMessage altitude. Removed in the next major.
```

- [ ] **Step 3: Repoint the persistence warning to the durable entry**

In `middleware.ts` (the `onCompressionFired` warning, ~`:86`), change the closing sentence from:

```ts
        '`summarizeMessages` for durable compaction.',
```

to:

```ts
        '`compactModelMessages` for durable compaction.',
```

- [ ] **Step 4: Typecheck + full suite + lint**

Run: `pnpm --filter @context-chef/ai-sdk-middleware typecheck && pnpm --filter @context-chef/ai-sdk-middleware test && pnpm exec biome check packages/ai-sdk-middleware/src`
Expected: exit 0; all tests PASS; Biome clean (no `@deprecated`-usage lint errors, since the package no longer calls the deprecated functions internally — verify no internal caller remains).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-middleware/src/index.ts packages/ai-sdk-middleware/src/compaction.ts packages/ai-sdk-middleware/src/middleware.ts
git commit -m "feat(ai-sdk-middleware): export ModelMessage durable API; deprecate V3 compactHistory/planCompaction"
```

---

## Task 7: Docs (READMEs)

**Files:**
- Modify: `packages/ai-sdk-middleware/README.md`
- Modify: `packages/ai-sdk-middleware/README.zh-CN.md`

(Root `README.md` / `README.zh-CN.md` mirror these; update them the same way if they carry the durable section.)

- [ ] **Step 1: Make the ModelMessage API the headline durable example**

In each README's durable-compaction section, replace the primary `compactHistory(prompt, model, …)` example with the ModelMessage one, including the `prepareStep` use:

````md
### `compactModelMessages(messages, model, options)`

One-shot durable compaction at the ModelMessage altitude — the type
`generateText` and `prepareStep` use. Run it in your own loop (own the store and
write the result back), or inside a `ToolLoopAgent`:

```ts
import { compactModelMessages } from '@context-chef/ai-sdk-middleware';

const agent = new ToolLoopAgent({
  model,
  tools,
  prepareStep: async ({ messages, model }) => ({
    messages: await compactModelMessages(messages, model, { keepRecentTurns: 4 }),
  }),
});
```

Returns the **same `messages` reference** when nothing is old enough to compact,
so you can skip persistence: `if (next !== messages) await save(next)`.
````

- [ ] **Step 2: Demote the V3 functions to a deprecation note**

Under the V3 `compactHistory`/`planCompaction` headings, add:

```md
> **Deprecated.** `compactHistory` / `planCompaction` take and return
> `LanguageModelV3Prompt` — the provider-protocol altitude, which nobody
> persists. Use [`compactModelMessages`](#compactmodelmessagesmessages-model-options)
> / `planCompactionModelMessages` instead. Removed in the next major.
```

- [ ] **Step 3: Lint the docs (if Biome covers md) / visual check**

Run: `pnpm exec biome check packages/ai-sdk-middleware/README.md packages/ai-sdk-middleware/README.zh-CN.md` (skip if Biome is not configured for markdown).
Expected: clean, or no-op.

- [ ] **Step 4: Commit**

```bash
git add packages/ai-sdk-middleware/README.md packages/ai-sdk-middleware/README.zh-CN.md README.md README.zh-CN.md
git commit -m "docs(ai-sdk-middleware): ModelMessage durable API + deprecate V3 prompt variants"
```

---

## Final verification (whole package)

- [ ] **Run the complete suite once more**

Run: `pnpm --filter @context-chef/core build && pnpm --filter @context-chef/ai-sdk-middleware typecheck && pnpm --filter @context-chef/ai-sdk-middleware test && pnpm exec biome check packages/ai-sdk-middleware/src`
Expected: build OK, typecheck exit 0, **all** tests PASS, Biome clean.

## Changeset (deferred — only on "ship")

Per the standing "batch until ship" preference, do **not** add a changeset during implementation. When the author says ship, add one:

```bash
cat > .changeset/model-message-durable-compaction.md <<'EOF'
---
'@context-chef/ai-sdk-middleware': minor
---

Add ModelMessage-altitude durable compaction (`compactModelMessages`,
`planCompactionModelMessages`, `summarizeModelMessages`) — the type
`prepareStep`/`generateText` use. Deprecate the `LanguageModelV3Prompt` variants
`compactHistory`/`planCompaction` (still exported; removed next major).
EOF
```

(`@context-chef/core` is unchanged → no core changeset.)

---

## Self-Review

**1. Spec coverage:**
- New ModelMessage adapter → Task 2. ✓
- `compactModelMessages` / `planCompactionModelMessages` → Task 4. ✓
- `summarizeModelMessages` (recommended sibling) → Task 5. ✓
- Model param at `LanguageModel` altitude + widen `createCompressionAdapter` → Task 3 + Task 4. ✓
- Deprecate `compactHistory`/`planCompaction` only (not `summarizeMessages`); repoint `:86` warning → Task 6. ✓
- No-op reference contract / reasoning byte-exact / tool flatten reuse / turn-safe split → asserted in Task 2 & Task 4 tests; reuse of core engine + `createCompressionAdapter` is structural. ✓
- Shared round-trip fixture matrix across both adapters → **partially**: Task 2 exercises the ModelMessage adapter with its own fixtures; the V3 adapter already has equivalent coverage in `tests/adapter.test.ts`. A single literally-shared fixture file is not built (the two adapters take different input types — V3Prompt vs ModelMessage — so a shared array cannot type-check against both). Drift is instead guarded by parallel case-for-case coverage. *This is a conscious deviation from the spec's "one fixture set" wording; flag at review if a shared parametrized harness is wanted.*
- UIMessage entry → out of scope (spec). ✓
- Docs + deferred changeset → Task 7 + Changeset section. ✓

**2. Placeholder scan:** No TBD/TODO; every code step carries complete code; every run step has an exact command + expected result. ✓

**3. Type consistency:** `fromModelMessages`/`toModelMessages`, `ModelMessageIR`, `_mm*` fields, `CompactionPlanModelMessages`, `compactModelMessages`/`planCompactionModelMessages`/`summarizeModelMessages` are spelled identically across Tasks 2/4/5/6 and the index export. `model: LanguageModel` is consistent in Tasks 3/4/5. ✓

**One open item for the reviewer:** the "shared fixture set across both adapters" (spec) is implemented as parallel coverage, not a single shared array, because the two adapters' input types differ. Confirm that's acceptable, or I'll add a small parametrized harness that feeds semantically-equal V3 and ModelMessage fixtures through each.
