---
"@context-chef/core": patch
---

A `compile()` aborted while its overflow strategy runs no longer lands what the strategy returned.

The compile threw its `AbortError` and sent nothing, but `onCompress` and the `compress` event had already fired, the span was archived, the circuit breaker was cleared and the window lineage had moved on. Now none of that happens, and the compile throws before `compress:end`. A `background()` job aborted along with the compile that started it is dropped without the "crashed unexpectedly" warning.

A compile aborted before `background()` runs (in a `compress:start` handler, say, or during an earlier `chain()` step) leaves a finished job waiting, and the next compile lands it. Once the signal is aborted, `chain()` also stops before its next step, so an aborted compile no longer pays for a summarization nobody will use.

`janitor.overflow(history, { signal })` called on its own changes the same way. A call that would run the strategy throws the signal's reason once it is aborted, before the strategy runs or while it runs (an `AbortError` unless you aborted with a reason of your own), and lands nothing. It used to land and return whatever the strategy returned. A call that never reaches the strategy, because the history is within budget or an open circuit breaker holds it, resolves as before.
