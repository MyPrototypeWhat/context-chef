---
"@context-chef/core": patch
---

History parsed with `fromAnthropic` now goes back to Anthropic exactly as it came in, as long as nothing has changed it.

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign every thinking block over everything before it, and on accounts created on or after 2026-08-31 the API rejects a request (400) when an earlier turn differs from what the model saw. The Anthropic adapter used to rebuild every message from IR fields, which changed earlier turns even when nothing touched them: an assistant turn kept only its last thinking block, separate text blocks were joined with a newline, a tool-only turn gained an empty text block, parallel tool results and the user text after them were split into separate user messages, and blocks the IR does not model (server tool use, web search results, the signature of a compaction block) were dropped.

- `fromAnthropic` records on each parsed message where it came from (`Message._anthropic_origin`, type `AnthropicOrigin`): its place among the IR messages parsed from one wire message, a hash of its fields, and — on the first — the original content blocks.
- The Anthropic target replays the original message when every message parsed from it is still present, in order, and unmodified. A cleared tool result, stripped thinking or a dropped part falls back to rebuilding from IR fields, as before. Breakpoints carried in the original are replaced by the chef's own (`_cache_breakpoint`).
- The heuristic token estimate skips `_anthropic_origin`, so parsed history is not counted twice.

IR built directly (not through `fromAnthropic`) compiles to the same bytes as before.
