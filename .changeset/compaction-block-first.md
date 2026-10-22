---
"@context-chef/core": patch
---

A history that opens with an Anthropic compaction block keeps the block first when overflow or durable compaction rebuilds it.

When a session is resumed from an Anthropic compaction (`_anthropic_compaction`, for example parsed with `fromAnthropic`), `summarize()`, `anchored()`, `reset()` and `compactHistory()` used to put their summary or notice ahead of the block, and the API rejects such a request (`compaction_block_misplaced`). They now keep the block first and put the summary after it. The placeholder user turn `fromAnthropic` puts before the block stays with it, so OpenAI and Gemini still get a user turn first. No split falls inside that pair: one that would leave nothing else to compress compacts nothing. The archive citation and `onCompress` read the summary message after the block. `planCompaction()` keeps its output shape, and its docs say to put a compaction message `toKeep` starts with before the summary. Histories that don't open with a compaction block are rebuilt as before.
