---
layout: home

hero:
  name: ContextChef
  text: Context compiler for TypeScript/JavaScript AI agents
  tagline: Compile unbounded information into a bounded window — five axes, one payload, OpenAI / Anthropic / Gemini — without taking over your control flow.
  image:
    src: https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif
    alt: ContextChef demo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: The five axes
      link: /guide/architecture
    - theme: alt
      text: Migrating to v4
      link: /migration/v4
    - theme: alt
      text: View on GitHub
      link: https://github.com/MyPrototypeWhat/context-chef

features:
  - icon: 🗜️
    title: ① Selection — what goes into the window
    details: Overflow strategies bound the conversation (summarize, anchored, server, reset, chain, background); the Pruner bounds the tool list; a selector bounds memory.
    link: /guide/history-compression
  - icon: 🧭
    title: ② Placement — where in the window it goes
    details: A cache-stable prefix and a volatile tail. Memory, dynamic state, skills and announcements each pick a side, and cacheAudit tells you when the choice was wrong.
    link: /guide/architecture
  - icon: 💾
    title: ③ Persistence — where it lives outside the window
    details: One context store behind memory/, notes/, vfs/ and archive/ — one StorageBackend, one set of context:// addresses.
    link: /guide/context-store
  - icon: 🔎
    title: ④ Retrieval — how the model reaches back
    details: One context tool with seven commands, plus new_context, dispatched through chef.ownsTool and chef.handleTool.
    link: /guide/context-store
  - icon: 🔀
    title: ⑤ Adaptation — the provider wire format
    details: The same compiled state becomes an OpenAI / Anthropic / Gemini payload, with prefill, cache breakpoints and tool-call shapes adapted for you.
    link: /guide/adapters
  - icon: 📌
    title: Constraint pinning
    details: "pinned: true messages survive every overflow strategy verbatim and are never cleared by compact() — policy text stays intact."
  - icon: ♻️
    title: Reversible archive + recall
    details: Whatever a strategy evicts is stored and cited by URI, so exact details stay retrievable instead of guessed at.
  - icon: 🤝
    title: Handoff budget
    details: Tokens reserved above the trigger buy the model one turn to write what matters into notes/ or memory/ before the window is cut.
  - icon: ☁️
    title: Server-side context management
    details: The server() strategy delegates LLM compression to Anthropic's compaction, with a client-side fallback that keeps one config portable.
  - icon: 🧩
    title: Slots
    details: Six composition points in the compile pipeline — veto overflow, inject RAG results, rewrite the assembled messages, observe the payload.
  - icon: 💿
    title: Durable compaction
    details: planCompaction / compactHistory (plus AI SDK and TanStack ports) compact your own message store once and persist the result.
  - icon: 🚦
    title: Runtime tool gate
    details: Pruner blocklist + checkToolCall for permission, environment safety, and rate limits — KV-cache preserving by default.
  - icon: 🎯
    title: Dynamic state injection
    details: Zod schema-based state injection forces the model to stay aligned with the current task on every call.
  - icon: 🛡️
    title: Output guardrails
    details: withGuardrails enforces an XML output contract and sets an assistant prefill, auto-degraded on providers without native prefill.
  - icon: ⏪
    title: Snapshot & restore
    details: Capture and roll back full context state — history, memory, strategy state, window lineage — for branching and error recovery.
  - icon: 📊
    title: Observability
    details: A unified event system — chef.on('compress', ...) — plus optional pipeline invariants that report dropped pins and split tool pairs.
  - icon: 🎭
    title: Skills
    details: The Skill primitive bundles instructions and tool annotations per phase, loadable from SKILL.md files (Claude Code / Mastra / OpenCode compatible).
---
