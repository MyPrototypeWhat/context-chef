# ContextChef

![Status](https://img.shields.io/badge/Status-MVP-orange)

A pure, white-box Context Engineering compiler for TS/JS agents. It implements a zero-invasion "Sandwich Model" designed to maximize KV-Cache hits and strictly enforce prompt consistency.

## Overview

Unlike heavy orchestration frameworks (e.g., LangGraph), **ContextChef** doesn't take over your control flow. Instead, it provides a deterministic build pipeline (`Top Layer` -> `Rolling History` -> `Dynamic State`) that compiles your agent's state into an LLM-ready payload, neutralizing token bloat and context rot.

## Core Features

1. **The Stitcher (Deterministic Compiler)**
   - Guarantees physical payload consistency by sorting JSON keys lexicographically and normalizing formats.
   - Radically improves KV-Cache hit rates by ensuring prefix hashes remain locked.

2. **Pointer (Virtual File System / VFS)**
   - Automatically truncates and offloads massive text blobs (like `npm install` logs) to a local `context://vfs/` directory.
   - Allows configuration per-call (e.g. `processLargeOutput(log, 'log', { threshold: 50 })`).

3. **Janitor (Dynamic History Compression)**
   - Token-budget-based history compression. Automatically summarizes ancient history using a low-cost model (e.g. `gpt-4o-mini`) while perfectly preserving recent short-term memory.
   - Dual-track token calculation: Uses a blazingly fast 0-dependency heuristic by default, but allows plugging in `tiktoken` for 100% precision.

4. **Pruner (Tool Guard)**
   - Dynamically prunes the tool list injected into LLM context, preventing "tool hallucination" and conserving attention budget.
   - Three filtering strategies: explicit allowlist (`allowOnly`), task-relevance matching (`pruneByTask`), and combined mode (`pruneByTaskAndAllowlist`) with `union` / `intersection` semantics.
   - Tools with no tags are treated as universal utilities and always preserved.

5. **Governor (Output & State Governance)**
   - Zod-to-XML: Enforce task state shapes using strong schemas at compile time. Automatically compiles JSON states into XML tags (`<dynamic_state>...</dynamic_state>`), which is proven to be strictly superior for LLM comprehension.
   - EPHEMERAL_MESSAGE pattern: System-level instructions are wrapped in Claude Code's `<EPHEMERAL_MESSAGE>` format, clearly separating system directives from user content.
   - Robust XML guardrails with cognitive anchoring: forces the model to recall format rules at the start of its `<thinking>` block.

6. **Target Adapters & Graceful Degradation**
   - Write your prompt architecture once. Compile to `openai`, `anthropic`, or `gemini`.
   - Anthropic: Automatically injects `cache_control: { type: "ephemeral" }` breakpoints.
   - OpenAI: If the target model rejects `assistant` trailing messages (prefill), the Governor elegantly degrades the prefill into a `[System Note]` appended to the final user/system prompt.

## Installation

```bash
npm install context-engineer zod
```

---

## Production Best Practices

ContextChef is unopinionated about your database, but it is highly opinionated about how you format data for LLMs. Here is how you should integrate it into a real-world Agent loop.

### 1. The "JIT" Stateless Memory Philosophy (Handling Long Contexts)

ContextChef uses a **Just-In-Time (JIT)** compiler philosophy. Instead of permanently destroying old messages in your database when the context window fills up, ContextChef compresses them *in memory* right before the API request. 

To prevent summarizing the same old messages repeatedly on every turn, you must use the `onCompress` hook to update your "Working Memory" database, while keeping your "Cold Storage" (audit logs) intact.

```typescript
// 1. Fetch active working memory from your DB
let activeMessages = await db.getWorkingMemory(sessionId);

const chef = new ContextChef({
  janitor: {
    maxHistoryTokens: 20000, // Trigger compression at 20k tokens
    preserveRecentTokens: 10000, // Keep the most recent 10k tokens intact
    
    // Provide a cheap LLM to summarize the old messages
    compressionModel: async (oldMsgs) => callGpt4oMini(oldMsgs),
    
    // 2. The crucial hook: Persist the compression!
    onCompress: async (summaryMsg, truncatedCount) => {
      // Remove the old raw messages from the working DB
      await db.deleteOldestMessages(sessionId, truncatedCount);
      // Insert the summary at the beginning of the working DB
      await db.insertSummaryAtBeginning(sessionId, summaryMsg);
      // (Optional) The original raw messages are still safe in your audit logs!
    }
  }
});

const payload = await chef
  .setTopLayer(systemRules)
  .useRollingHistory(activeMessages)
  .compileAsync({ target: 'anthropic' });

// Send payload.messages to Claude/OpenAI
```

### 2. Handling Massive Terminal Outputs (Pointer & VFS)

When your agent runs `npm install` or triggers a massive error stack trace, feeding 50,000 lines of logs to an LLM will destroy its attention span and your wallet. 

ContextChef's `Pointer` intercepts this data, saves it to disk, and replaces it with a short URI + the last 20 lines (which usually contains the actual Error anyway).

```typescript
// Offload large output before appending to history
const safeLog = chef.processLargeOutput(rawTerminalOutput, 'log');
// safeLog is either the original content (if small) or a truncated pointer with a context://vfs/ URI

history.push({ role: 'tool', content: safeLog, tool_call_id: 'call_123' });
```

**How to integrate this with LLM Tools:**
We do *not* automatically register a read tool to the LLM (to remain zero-invasion). You should register your own `read_vfs_file` tool:

```json
{
  "name": "read_vfs_file",
  "description": "If you see a truncated log with a context://vfs/ URI, use this tool to read the full file.",
  "parameters": {
    "type": "object",
    "properties": { "uri": { "type": "string" } }
  }
}
```

When the LLM calls this tool, resolve the URI via a standalone `Pointer` instance:

```typescript
import { Pointer } from 'context-engineer';
const pointer = new Pointer({ storageDir: '.context_vfs' });

// In your tool handler:
const fullContent = pointer.resolve(args.uri);
// Return fullContent to the LLM as a tool result
```

This pattern ("Default Fold + Lazy Load") is exactly how elite coding agents like Devin and Cursor handle infinite terminal outputs.

### 3. Preventing Tool Hallucination (Pruner)

When your agent has 30+ tools registered but the current task only needs 3, the extra 27 tool schemas consume attention budget and increase the probability of hallucinated tool calls.

ContextChef's `Pruner` lets you dynamically filter the tool list at each turn:

```typescript
const chef = new ContextChef();

// Register your full tool catalog once
chef.registerTools([
  { name: 'read_file',   description: 'Read a file from disk',  tags: ['file', 'read'] },
  { name: 'write_file',  description: 'Write to a file',        tags: ['file', 'write'] },
  { name: 'run_bash',    description: 'Execute a shell command', tags: ['shell', 'execute'] },
  { name: 'search_web',  description: 'Search the web',         tags: ['web', 'search'] },
  { name: 'get_time',    description: 'Get current timestamp'   /* no tags = always kept */ },
]);

// At each agent turn, prune based on the current task
const currentTask = "Read the auth.ts file and analyze the bug";
const { tools, removed } = chef.tools().pruneByTask(currentTask);
// tools:   [read_file, get_time]   (matched by 'read'/'file' tags + universal)
// removed: [write_file, run_bash, search_web]

// Pass only `tools` to your LLM SDK call
const response = await openai.chat.completions.create({
  messages: payload.messages,
  tools: tools.map(t => ({ type: 'function', function: t })),
});
```

---

## Quick Start (Synchronous)

If you don't need async features like History Compression or async `transformContext` hooks, you can use the synchronous `compile()` method.

```typescript
import { ContextChef } from 'context-engineer';
import { z } from 'zod';

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string())
});

const chef = new ContextChef({ vfs: { threshold: 5000 } });

// Compile your deterministic payload
const payload = chef
  .setTopLayer([{ role: 'system', content: 'You are an expert coder.', _cache_breakpoint: true }])
  .useRollingHistory([{ role: 'user', content: 'Help me fix this.' }])
  .setDynamicState(TaskSchema, {
    activeFile: 'auth.ts',
    todo: ['Add JWT validation']
  })
  .withGovernance({ 
    enforceXML: { outputTag: 'final_code' },
    prefill: '<thinking>\n1.' 
  })
  .compile({ target: 'openai' });

console.log(payload.messages);
```
