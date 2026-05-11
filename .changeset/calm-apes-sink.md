---
"@context-chef/ai-sdk-middleware": patch
"@context-chef/tanstack-ai": patch
---

Tighten `tokenizer` option signature from `(messages: unknown[]) => number` to `(messages: Message[]) => number`.

The middleware always invokes the user-supplied tokenizer with `Message[]` (the core IR type) — the previous `unknown[]` was a leak in the public type, forcing callers to cast or narrow inside their tokenizer. The new signature matches the actual runtime contract and matches `@context-chef/core`'s `Janitor` config.

Type-only change; no runtime behavior change. Existing tokenizers typed as `(messages: unknown[]) => number` will continue to compile, but callers can now drop the cast and read `Message` fields directly.
