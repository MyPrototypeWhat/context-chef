---
"@context-chef/core": patch
---

A history that opens with an Anthropic compaction block now reaches Anthropic with the block first.

With on-demand compaction (`compact-2026-09-04`) the conversation restarts from the returned block, and the API requires that block to lead `messages`. `fromAnthropic` runs its output through `ensureValidHistory`, which prepends a `[Conversation continues]` user turn to any history that doesn't open with one, so the block ended up second. The Anthropic target now drops that placeholder when the next message carries the compaction block. Other targets still get the opening user turn. `ensureValidHistory` exports `isOpeningPlaceholder(msg)` for adapters with their own opening rule.
