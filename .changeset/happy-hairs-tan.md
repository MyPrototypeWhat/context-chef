---
"@context-chef/core": patch
---

Replace `adjustSplitIndex` with turn-based grouping in Janitor compression

- Add `groupIntoTurns()` utility that groups messages into atomic "turns" (assistant + tool_calls + tool results as one unit)
- Refactor `evaluateBudget()` to split on turn boundaries instead of individual messages, structurally guaranteeing tool pair integrity
- Remove `adjustSplitIndex()` — no longer needed since turn-based grouping handles tool pair protection by design
- Remove system message filtering in `executeCompression()`
- Export `groupIntoTurns` and `Turn` type from public API
- Fix `preserveRatio` docstring (was "70%", actual default is 80%)
- Add `Prompts.TOOL_RESULT_CLEARED_INSTRUCTION` — system-level instruction explaining cleared tool results to the model
- Export `ToolResultClearTarget` type and refactor `ClearTarget` union for object-form tool-result clearing with `keepRecent`

**Behavioral change:** `preserveRecentMessages` now counts turns instead of individual messages. A "turn" is a single message, or an assistant with tool_calls plus all its subsequent tool results.
