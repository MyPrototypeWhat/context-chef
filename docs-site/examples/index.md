# Examples

Runnable, self-contained examples live in the repository's [`examples/`](https://github.com/MyPrototypeWhat/context-chef/tree/main/examples) directory. Most run fully offline (mock summarizers, no API key); the ones that call a real model tell you which env var to set. Run any of them with `npx tsx examples/<name>.ts`.

## Core

| Example | What it demonstrates |
|---|---|
| [`basic-chat.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/basic-chat.ts) | ContextChef + Janitor for automatic history compression, `reportTokenUsage`-style token tracking, compiling to OpenAI format. Needs `OPENAI_API_KEY`. |
| [`compression-v2.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/compression-v2.ts) | The v4 janitor pipeline: `triggerRatio` pre-rot trigger, `pinned` messages surviving compression, `archive: 'vfs'` + `chef.resolveRecall`, `compressionGuidelines`, `minShrinkRatio` + `validateCompression` quality gates, granular compression events, and `compressionMode: 'incremental-anchored'`. Fully offline. |
| [`durable-compaction.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/durable-compaction.ts) | `planCompaction` turn-safe splits, `compactHistory` one-shot compaction, the `result === history` no-op persist pattern, and the contrast with in-flight compression. Fully offline. |
| [`guardrail.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/guardrail.ts) | `withGuardrails` enforce-XML + prefill, provider-aware prefill degradation, `withGuardrails(null)` clearing, and v4 order-independence. Fully offline. |
| [`memory.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/memory.ts) | Memory with `InMemoryStore`, turn-based and wall-clock TTL, both `memoryPlacement` modes and why the tail placement is KV-cache friendly, injection selectors, and the compiled `<memory>` block + memory tools. Fully offline. |
| [`multi-provider.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/multi-provider.ts) | The same prompt compiling to OpenAI, Anthropic, and Gemini formats — cache breakpoints for Anthropic, prefill degradation across providers. Fully offline. |
| [`skills.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/skills.ts) | Skill objects and `SKILL.md` loading, `registerSkills` + `activateSkill`, `renderSkill` placeholder substitution, `formatSkillListing`, and `meta.activeSkillName`. Fully offline. |
| [`snapshot-restore.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/snapshot-restore.ts) | `chef.snapshot(label)` / `chef.restore(snap)` rollback, `guardrailOptions` surviving the round-trip, Janitor state (including the anchored-mode anchor doc) in snapshots. Fully offline. |
| [`tool-pruning.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/tool-pruning.ts) | Flat mode tag-based pruning by task, plus the two-layer architecture: stable namespaces + on-demand toolkits. Fully offline. |
| [`vfs-lifecycle.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/vfs-lifecycle.ts) | `offloadAsync` head/tail markers + URIs, the `offload:created` event, the `getRecallToolDefinition` + `chef.resolveRecall` round-trip, and `cleanupAsync` with `maxFiles` / `maxBytes` LRU eviction. Fully offline. |

## Middleware

| Example | What it demonstrates |
|---|---|
| [`ai-sdk-middleware.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/ai-sdk-middleware.ts) | `withContextChef` compress + truncate + compact in one wrapper, per-conversation `sessionId` isolation, the anti-double-compression guard for Anthropic server-side context management, and durable compaction with `compactModelMessages`. Constructs offline; the model call needs `OPENAI_API_KEY`. |
| [`tanstack-ai.ts`](https://github.com/MyPrototypeWhat/context-chef/blob/main/examples/tanstack-ai.ts) | `contextChefMiddleware` with compress + truncate + compact on `@tanstack/ai` 0.44, `threadId` keying, and durable compaction with `compactTanStackMessages`. Constructs offline; the `chat()` call needs `OPENAI_API_KEY`. |

## Running the examples

```bash
git clone https://github.com/MyPrototypeWhat/context-chef.git
cd context-chef
pnpm install
pnpm build

npx tsx examples/compression-v2.ts   # offline
export OPENAI_API_KEY=your-key
npx tsx examples/basic-chat.ts       # calls the real API
```
