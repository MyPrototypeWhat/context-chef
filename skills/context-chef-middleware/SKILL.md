---
name: context-chef-middleware
description: "Helps developers integrate @context-chef/ai-sdk-middleware into their Vercel AI SDK (v6+) projects. Use this skill when the user wants to add transparent context management to an AI SDK app, wrap a model with automatic history compression, truncate large tool results, manage token budgets, or inject dynamic state into AI SDK prompts. Also trigger when the user mentions 'context-chef middleware', 'AI SDK middleware', 'ai-sdk context', or asks about compressing history / truncating tool results / managing tokens in a Vercel AI SDK project."
argument-hint: "[feature-focus]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# Integrate @context-chef/ai-sdk-middleware

Help the developer add [@context-chef/ai-sdk-middleware](https://github.com/MyPrototypeWhat/context-chef) — a drop-in AI SDK middleware for transparent history compression, tool result truncation, and token budget management — into their existing Vercel AI SDK project.

The key selling point: **zero code changes** to existing `generateText` / `streamText` calls. Just wrap the model once.

## Step 1: Analyze the developer's project

Before asking questions, silently inspect the project:

```
1. package.json → confirm they use `ai` (v6+) and an AI SDK provider (@ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google, etc.)
2. Lock file → detect package manager (pnpm-lock.yaml / yarn.lock / package-lock.json / bun.lockb)
3. tsconfig.json → TypeScript or JavaScript?
4. Existing AI SDK usage → look for patterns like:
   - generateText({ model, messages, ... })
   - streamText({ model, messages, ... })
   - openai('gpt-4o'), anthropic('claude-sonnet-4-20250514'), google('gemini-2.0-flash')
   - wrapLanguageModel / middleware patterns
```

Use Glob + Grep to find these. This context shapes everything you generate.

## Step 2: Ask about their needs

Based on what you found, present a brief summary of their setup and ask which features they need:

| Pain point | Middleware feature | Option |
|---|---|---|
| Conversations get too long, context window fills up | History compression via cheap model | `compress` |
| Tool outputs (terminal, API responses) are huge | Auto-truncation with head/tail preservation | `truncate` |
| Want cheaper compression before LLM summarization | Mechanical compaction (strip tool results/thinking) | `compact` |
| Need to inject task state for LLM attention | Dynamic state as XML in prompt | `dynamicState` |
| Want custom prompt manipulation (RAG, metadata) | Post-compression transform hook | `transformContext` |
| Want to know when compression happens | Compression callback | `onCompress` |
| Need control over what happens at budget limit | Budget exceeded hook | `onBudgetExceeded` |

If the developer is unsure, recommend starting with: **compression + truncation** — these solve the most common problems with minimal setup.

## Step 3: Install

Generate the install command using their detected package manager:

```
npm install @context-chef/ai-sdk-middleware
pnpm add @context-chef/ai-sdk-middleware
yarn add @context-chef/ai-sdk-middleware
bun add @context-chef/ai-sdk-middleware
```

The middleware depends on `ai` (v6+) and `@ai-sdk/provider` (v3+) as peer dependencies — the developer should already have these.

## Step 4: Generate integration code

The core pattern is always:

```typescript
import { withContextChef } from '@context-chef/ai-sdk-middleware';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

// 1. Wrap the model once (stateful — one per conversation/session)
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
});

// 2. Use exactly like before — zero other code changes
const result = await generateText({ model, messages, tools });
```

### Configuration generation rules

Build the options object based on which features the developer selected:

**History compression (`compress`):**

Without a compression model — old messages are simply discarded:
```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
});
```

With a compression model — old messages are summarized by a cheap model:
```typescript
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: {
    model: openai('gpt-4o-mini'),  // cheap model for summarization
    preserveRatio: 0.8,             // keep 80% of context for recent messages
  },
});
```

**Tool result truncation (`truncate`):**
```typescript
truncate: {
  threshold: 5000,   // truncate tool results over 5000 chars
  headChars: 500,    // preserve first 500 chars
  tailChars: 1000,   // preserve last 1000 chars
}
```

Optionally persist original content via a storage adapter (so the LLM can retrieve it later via `context://vfs/` URI):
```typescript
import { FileSystemAdapter } from '@context-chef/core';

truncate: {
  threshold: 5000,
  headChars: 500,
  tailChars: 1000,
  storage: new FileSystemAdapter('.context_vfs'),
}
```

**Mechanical compaction (`compact`):**

Zero LLM cost — mechanically strips content before compression:
```typescript
compact: {
  clear: ['tool-result'],   // strip old tool results
  // also available: 'thinking' to strip reasoning traces
}
```

**Dynamic state injection (`dynamicState`):**
```typescript
dynamicState: {
  getState: () => ({
    currentStep: agent.step,
    availableTools: agent.tools.map(t => t.name),
    progress: `${completed}/${total}`,
  }),
  placement: 'last_user',  // default: injects into last user message for recency bias
  // placement: 'system',  // alternative: adds as standalone system message
}
```

**Transform hook (`transformContext`):**
```typescript
transformContext: (prompt) => {
  // Called after compression + dynamic state, before sending to model
  // Use for RAG injection, metadata, custom prompt manipulation
  return [{ role: 'system', content: ragContext }, ...prompt];
}
```

**Budget exceeded hook (`onBudgetExceeded`):**
```typescript
onBudgetExceeded: (history, { currentTokens, limit }) => {
  // Return modified messages, or null to let default compression handle it
  console.log(`Budget exceeded: ${currentTokens}/${limit} tokens`);
  return null;
}
```

**Compression callback (`onCompress`):**
```typescript
onCompress: (summary, truncatedCount) => {
  console.log(`Compressed ${truncatedCount} messages into summary`);
}
```

**Custom tokenizer (`tokenizer`):**
```typescript
tokenizer: (messages) => {
  // Precise per-message token counting (optional)
  // Without this, the middleware uses token usage from model responses
  return messages.reduce((sum, m) => sum + encode(m.content).length, 0);
}
```

### Integration patterns

Find the developer's existing AI SDK code and show exactly where to add the wrapper:

**Pattern A: Simple generateText / streamText**
```typescript
// Before:
const result = await generateText({
  model: openai('gpt-4o'),
  messages,
});

// After: just wrap the model — everything else stays the same
const model = withContextChef(openai('gpt-4o'), { contextWindow: 128_000, ... });
const result = await generateText({ model, messages });
```

**Pattern B: Agent loop with tools**
```typescript
// Create the wrapped model OUTSIDE the loop (it's stateful)
const model = withContextChef(openai('gpt-4o'), {
  contextWindow: 128_000,
  compress: { model: openai('gpt-4o-mini') },
  truncate: { threshold: 5000 },
});

// Inside the loop, use exactly like before
while (true) {
  const result = await generateText({ model, messages, tools });
  // ... handle tool calls, append to messages, etc.
}
```

**Pattern C: Using createMiddleware directly**

For developers who want more control or already use `wrapLanguageModel`:
```typescript
import { createMiddleware } from '@context-chef/ai-sdk-middleware';
import { wrapLanguageModel } from 'ai';

const middleware = createMiddleware({ contextWindow: 128_000, ... });
const model = wrapLanguageModel({ model: openai('gpt-4o'), middleware });
```

**Pattern D: Using format converters directly**

For developers who want to use `@context-chef/core` modules with AI SDK message formats:
```typescript
import { fromAISDK, toAISDK } from '@context-chef/ai-sdk-middleware';

// Convert AI SDK prompt → context-chef IR
const irMessages = fromAISDK(aiSdkPrompt);
// ... process with context-chef modules ...
const aiSdkPrompt = toAISDK(irMessages);
```

## Step 5: Verify and explain

After generating the code:

1. Verify `ai` (v6+) is in their dependencies — the middleware requires AI SDK v6
2. Verify they have at least one `@ai-sdk/*` provider installed
3. Explain the processing pipeline briefly:
   - Truncate large tool results (if configured)
   - Mechanical compaction (if configured)
   - History compression (if over token budget)
   - Dynamic state injection (if configured)
   - Custom transform (if configured)
4. Emphasize: the wrapped model is **stateful** — it tracks token usage across calls to know when compression is needed. Create one wrapped model per conversation/session, not per call.

## Common mistakes to prevent

- Don't create a new wrapped model per LLM call — reuse it across the conversation (it tracks token usage)
- Don't manually call `reportTokenUsage()` — the middleware extracts it automatically from `generateText` / `streamText` responses
- The `compress.model` should be a cheap, fast model (e.g. `gpt-4o-mini`, `claude-haiku`) — it's used for summarization, not the main task
- `withContextChef()` returns a standard `LanguageModelV3` — it works anywhere the original model works
- If using `compact` with `truncate` together, `truncate` runs first (on the raw AI SDK prompt), then `compact` runs on the IR (after conversion)

## When to recommend @context-chef/core instead

The middleware covers the most common use case: transparent compression and truncation. Recommend `@context-chef/core` directly when the developer needs:
- Tool pruning / namespace architecture (20+ tools)
- Persistent KV memory (cross-session)
- Snapshot & restore
- Multi-provider compilation (OpenAI / Anthropic / Gemini format switching)
- Manual control over the compilation pipeline

For these advanced use cases, refer the developer to the `context-chef-core` skill.

## Reference files

- For the complete middleware API surface and type definitions, read [references/api-reference.md](references/api-reference.md)
