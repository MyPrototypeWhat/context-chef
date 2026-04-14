---
"@context-chef/tanstack-ai": minor
---

### New Package: `@context-chef/tanstack-ai`

TanStack AI `ChatMiddleware` powered by context-chef. Drop in as a single middleware to get transparent history compression, tool result truncation, and token budget management.

#### Features

- **History Compression** — automatically compresses older messages when conversation exceeds the token budget, with optional LLM-based summarization via a cheap adapter
- **Tool Result Truncation** — large tool outputs are truncated while preserving head and tail, with optional VFS storage for full content retrieval
- **Token Budget Tracking** — extracts `promptTokens` from `onUsage` callbacks and feeds it back to the compression engine automatically
- **Compact (Mechanical Pruning)** — zero-LLM-cost removal of tool call/result pairs and empty messages with configurable retention modes
- **Dynamic State Injection** — injects runtime state as XML into the last user message or system prompt on every call
- **Transform Context Hook** — custom post-processing for RAG injection or prompt manipulation

#### Adapter

- `fromTanStackAI()` / `toTanStackAI()` — lossless round-trip converters between TanStack AI `ModelMessage[]` and context-chef `Message[]` IR
- Preserves multimodal `ContentPart[]` content and `providerMetadata` on tool calls through round-trip via `_originalContent` / `_originalToolCalls` pass-through fields
