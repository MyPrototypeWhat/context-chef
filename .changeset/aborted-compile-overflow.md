---
"@context-chef/core": patch
---

A `compile()` aborted while its overflow strategy runs no longer lands what the strategy returned.

The compile threw its `AbortError` and sent nothing, but `onCompress` and the `compress` event had already fired, the span was archived, the circuit breaker was cleared and the window lineage had moved on. Now none of that happens, and the compile throws before `compress:end`. A `background()` job aborted along with the compile that started it is dropped without the "crashed unexpectedly" warning.
