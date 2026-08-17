---
layout: home

hero:
  name: ContextChef
  text: Context compiler for TypeScript/JavaScript AI agents
  tagline: Compress history, prune tools, persist memory, and compile the same state to OpenAI / Anthropic / Gemini — without taking over your control flow.
  image:
    src: https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif
    alt: ContextChef demo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Migrating to v4
      link: /migration/v4
    - theme: alt
      text: View on GitHub
      link: https://github.com/MyPrototypeWhat/context-chef

features:
  - icon: 🗜️
    title: History compression
    details: Automatically compress long conversations, preserve recent memory, and delegate old messages to a small model for summarization.
  - icon: 📌
    title: Constraint pinning
    details: "pinned: true messages survive compression verbatim and are never cleared by compact() — policy text stays intact."
  - icon: ♻️
    title: Reversible archive + recall
    details: The full pre-compression span is stored and cited by URI; a recall_context tool restores exact details on demand.
  - icon: ☁️
    title: Server-side context management
    details: Delegate LLM compression to Anthropic's server-side compaction while pruning, skills, memory, and VFS stay client-side.
  - icon: 💾
    title: Durable compaction
    details: planCompaction / compactHistory (plus AI SDK and TanStack ports) compact your own message store once and persist the result.
  - icon: 🧰
    title: Tool pruning
    details: Dynamically prune the tool list per task, or use a two-layer namespace + lazy-loading architecture to eliminate tool hallucinations.
  - icon: 🚦
    title: Runtime tool gate
    details: Pruner blocklist + checkToolCall for permission, environment safety, and rate limits — KV-cache preserving by default.
  - icon: 🔀
    title: Multi-provider compile
    details: The same prompt architecture compiles to OpenAI / Anthropic / Gemini with automatic prefill, cache, and tool-call format adaptation.
  - icon: 🎯
    title: Dynamic state injection
    details: Zod schema-based state injection forces the model to stay aligned with the current task on every call.
  - icon: 🛡️
    title: Output guardrails
    details: withGuardrails enforces an XML output contract and sets an assistant prefill, auto-degraded on providers without native prefill.
  - icon: 📦
    title: VFS offloading
    details: Auto-truncate oversized tool output and offload it to a virtual file system, keeping error lines plus a context:// URI pointer.
  - icon: 🧠
    title: Cross-session memory
    details: The model persists key information (project rules, user preferences) via tool calls, auto-injected on the next session.
  - icon: ⏪
    title: Snapshot & restore
    details: Capture and roll back full context state for branching, exploration, and error recovery.
  - icon: 🪝
    title: Hooks for external context
    details: onBeforeCompile lets you inject RAG results, AST snippets, or MCP queries right before compilation.
  - icon: 📊
    title: Observability
    details: A unified event system — chef.on('compress', ...) — for logging, metrics, and debugging across all internal modules.
  - icon: 🎭
    title: Skills
    details: The Skill primitive bundles instructions and tool annotations per phase, loadable from SKILL.md files (Claude Code / Mastra / OpenCode compatible).
---
