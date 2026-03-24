# Provider-Specific Integration Examples

Complete working examples for each supported LLM provider.

## Table of Contents
1. [OpenAI Integration](#openai-integration)
2. [Anthropic Integration](#anthropic-integration)
3. [Gemini Integration](#gemini-integration)
4. [Multi-Provider Setup](#multi-provider-setup)
5. [Agent Loop with Memory + Tool Handling](#agent-loop-with-memory--tool-handling)

---

## OpenAI Integration

```typescript
import OpenAI from "openai";
import { ContextChef } from "context-chef";
import type { Message } from "context-chef";
import { z } from "zod";

const openai = new OpenAI();

const chef = new ContextChef({
  janitor: {
    contextWindow: 128000, // gpt-4o context window
    preserveRecentMessages: 1,
    compressionModel: async (msgs) => {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Summarize the following conversation concisely, preserving key decisions and context." },
          ...msgs.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        ],
      });
      return res.choices[0].message.content ?? "";
    },
  },
  vfs: { threshold: 5000 },
});

// Define your task state schema
const TaskSchema = z.object({
  currentGoal: z.string(),
  completedSteps: z.array(z.string()),
  pendingSteps: z.array(z.string()),
});

// Register tools
chef.registerTools([
  {
    name: "read_file",
    description: "Read a file from the filesystem",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    tags: ["file", "read"],
  },
  {
    name: "write_file",
    description: "Write content to a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    tags: ["file", "write"],
  },
]);

// Agent loop
const history: Message[] = [];

async function agentLoop(userMessage: string) {
  history.push({ role: "user", content: userMessage });

  while (true) {
    // Compile context
    const payload = await chef
      .setSystemPrompt([{
        role: "system",
        content: "You are a helpful coding assistant.",
        _cache_breakpoint: true,
      }])
      .setHistory(history)
      .setDynamicState(TaskSchema, {
        currentGoal: "Help the user with their request",
        completedSteps: [],
        pendingSteps: ["Analyze request", "Implement solution"],
      })
      .compile({ target: "openai" });

    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      ...payload,
    });

    // Feed token usage for compression tracking
    chef.reportTokenUsage(response.usage?.prompt_tokens ?? 0);

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Add assistant response to history
    history.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      tool_calls: assistantMessage.tool_calls?.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls?.length) break;

    // Handle tool calls
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await executeTool(toolCall.function.name, args);

      // Offload large results
      const safeResult = chef.offload(typeof result === "string" ? result : JSON.stringify(result));

      history.push({
        role: "tool",
        content: safeResult,
        tool_call_id: toolCall.id,
      });
    }
  }

  return history[history.length - 1].content;
}
```

---

## Anthropic Integration

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { ContextChef, InMemoryStore } from "context-chef";
import type { Message } from "context-chef";
import { z } from "zod";

const anthropic = new Anthropic();

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000, // claude-3.5-sonnet / claude-4
    preserveRecentMessages: 1,
    compressionModel: async (msgs) => {
      const res = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [
          { role: "user", content: `Summarize this conversation concisely:\n\n${msgs.map(m => `${m.role}: ${m.content}`).join("\n")}` },
        ],
      });
      const textBlock = res.content.find(b => b.type === "text");
      return textBlock?.text ?? "";
    },
  },
  memory: {
    store: new InMemoryStore(),
    defaultTTL: { turns: 20 },
  },
  vfs: { threshold: 5000 },
});

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

const history: Message[] = [];

async function agentLoop(userMessage: string) {
  history.push({ role: "user", content: userMessage });

  while (true) {
    const payload = await chef
      .setSystemPrompt([{
        role: "system",
        content: "You are an expert coding assistant. Use memory to remember important project details.",
        _cache_breakpoint: true, // Enables Anthropic prompt caching
      }])
      .setHistory(history)
      .setDynamicState(TaskSchema, {
        activeFile: "src/index.ts",
        todo: ["Review code", "Fix bugs"],
      })
      .compile({ target: "anthropic" });

    // payload has { system, messages, tools, meta }
    // system is automatically separated for Anthropic
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: payload.system,
      messages: payload.messages,
      tools: payload.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters ?? { type: "object", properties: {} },
      })),
    });

    chef.reportTokenUsage(response.usage.input_tokens);

    // Build assistant message for history
    const assistantContent = response.content.map(block => {
      if (block.type === "text") return block.text;
      return "";
    }).filter(Boolean).join("\n");

    const toolUseBlocks = response.content.filter(b => b.type === "tool_use");

    history.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: toolUseBlocks.map(b => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      })),
    });

    if (toolUseBlocks.length === 0) break;

    // Handle tool calls
    for (const block of toolUseBlocks) {
      // Handle memory tool calls
      if (block.name === "create_memory") {
        const { key, value, description } = block.input as any;
        await chef.getMemory().createMemory(key, value, description);
        history.push({ role: "tool", content: `Memory "${key}" created.`, tool_call_id: block.id });
        continue;
      }
      if (block.name === "modify_memory") {
        const { action, key, value, description } = block.input as any;
        if (action === "update") {
          await chef.getMemory().updateMemory(key, value, description);
        } else {
          await chef.getMemory().deleteMemory(key);
        }
        history.push({ role: "tool", content: `Memory "${key}" ${action}d.`, tool_call_id: block.id });
        continue;
      }

      // Handle regular tools
      const result = await executeTool(block.name, block.input);
      const safeResult = chef.offload(typeof result === "string" ? result : JSON.stringify(result));
      history.push({ role: "tool", content: safeResult, tool_call_id: block.id });
    }
  }

  return history[history.length - 1].content;
}
```

---

## Gemini Integration

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ContextChef } from "context-chef";
import type { Message } from "context-chef";
import { z } from "zod";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

const chef = new ContextChef({
  janitor: {
    contextWindow: 1000000, // Gemini 1.5 Pro
    preserveRecentMessages: 2,
  },
});

const TaskSchema = z.object({
  task: z.string(),
  context: z.string(),
});

const history: Message[] = [];

async function agentLoop(userMessage: string) {
  history.push({ role: "user", content: userMessage });

  const payload = await chef
    .setSystemPrompt([{ role: "system", content: "You are a helpful assistant." }])
    .setHistory(history)
    .setDynamicState(TaskSchema, { task: "Answer the question", context: "General knowledge" })
    .compile({ target: "gemini" });

  // payload has { messages, systemInstruction, tools }
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    systemInstruction: payload.systemInstruction,
  });

  const chat = model.startChat({ history: payload.messages.slice(0, -1) });
  const lastMessage = payload.messages[payload.messages.length - 1];
  const result = await chat.sendMessage(lastMessage.parts);

  const text = result.response.text();
  history.push({ role: "assistant", content: text });

  return text;
}
```

---

## Multi-Provider Setup

Switch providers without changing your prompt architecture:

```typescript
import { ContextChef } from "context-chef";

type Provider = "openai" | "anthropic" | "gemini";

function createChef(provider: Provider) {
  return new ContextChef({
    janitor: {
      contextWindow: provider === "gemini" ? 1000000 : provider === "anthropic" ? 200000 : 128000,
      preserveRecentMessages: 1,
    },
  });
}

async function callLLM(chef: ContextChef, provider: Provider, history: Message[]) {
  chef.setSystemPrompt([{
    role: "system",
    content: "You are a helpful assistant.",
    _cache_breakpoint: true,
  }]).setHistory(history);

  const payload = await chef.compile({ target: provider });

  // Each provider gets the right format automatically
  switch (provider) {
    case "openai":
      return openai.chat.completions.create({ model: "gpt-4o", ...payload });
    case "anthropic":
      return anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: (payload as any).system,
        messages: (payload as any).messages,
      });
    case "gemini":
      // ... gemini-specific call
  }
}
```

---

## Agent Loop with Memory + Tool Handling

Complete example with all features enabled:

```typescript
import { ContextChef, InMemoryStore, VFSMemoryStore, Janitor } from "context-chef";
import type { Message } from "context-chef";
import { z } from "zod";

const compactJanitor = new Janitor({ contextWindow: Infinity });

const chef = new ContextChef({
  janitor: {
    contextWindow: 200000,
    preserveRecentMessages: 1,
    compressionModel: async (msgs) => summarizeWithCheapModel(msgs),
    onCompress: (summaryMessage, count) => {
      console.log(`Compressed ${count} messages`);
    },
    onBudgetExceeded: (history) => {
      // First pass: mechanically strip tool results (zero LLM cost)
      return compactJanitor.compact(history, { clear: ['tool-result'] });
    },
  },
  memory: {
    store: new VFSMemoryStore(".context-memory"),
    defaultTTL: { turns: 50 },
    onMemoryChanged: (event) => {
      console.log(`Memory ${event.type}: ${event.key}`);
    },
  },
  pruner: { strategy: "union" },
  vfs: { threshold: 5000 },
  onBeforeCompile: async (ctx) => {
    // Inject RAG results based on the current task state
    const results = await vectorDB.search(ctx.dynamicStateXml);
    if (results.length === 0) return null;
    return results.map(r => r.content).join("\n\n");
  },
});

// Register tools with tags for task-based filtering
chef.registerTools([
  { name: "read_file", description: "Read a file", tags: ["file", "read"] },
  { name: "write_file", description: "Write a file", tags: ["file", "write"] },
  { name: "run_bash", description: "Run shell command", tags: ["shell", "execute"] },
  { name: "search_code", description: "Search codebase", tags: ["search", "code"] },
]);

const AgentState = z.object({
  currentTask: z.string(),
  activeFiles: z.array(z.string()),
  completedSteps: z.array(z.string()),
  nextStep: z.string(),
});

async function agentLoop(userMessage: string) {
  const history: Message[] = [{ role: "user", content: userMessage }];
  let state = { currentTask: userMessage, activeFiles: [], completedSteps: [], nextStep: "Analyze request" };

  while (true) {
    // Prune tools based on current task (flat mode — returns filtered tools)
    const pruned = chef.getPruner().pruneByTask(state.nextStep);

    // Snapshot before risky operations
    const snap = chef.snapshot("before-turn");

    // Compile (tools from compile() include ALL registered tools;
    // use pruned.tools to override when using flat mode filtering)
    const payload = await chef
      .setSystemPrompt([{
        role: "system",
        content: "You are an expert coding agent. Use create_memory to remember important project details.",
        _cache_breakpoint: true,
      }])
      .setHistory(history)
      .setDynamicState(AgentState, state)
      .compile({ target: "anthropic" });

    // Override with pruned tools for this turn
    payload.tools = pruned.tools;

    // Call LLM
    const response = await callLLM(payload);
    chef.reportTokenUsage(response.usage.input_tokens);

    // Process response...
    const toolCalls = extractToolCalls(response);

    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      try {
        // Memory tools
        if (tc.name === "create_memory" || tc.name === "modify_memory") {
          await handleMemoryToolCall(chef, tc);
          continue;
        }

        // Regular tools
        const result = await executeTool(tc.name, tc.args);
        const safeResult = chef.offload(result);
        history.push({ role: "tool", content: safeResult, tool_call_id: tc.id });
      } catch (error) {
        // Restore on failure
        chef.restore(snap);
        history.push({ role: "tool", content: `Error: ${error.message}`, tool_call_id: tc.id });
      }
    }

    // Update state for next turn
    state = { ...state, completedSteps: [...state.completedSteps, state.nextStep], nextStep: "Continue task" };
  }
}
```
