---
"@context-chef/core": patch
---

A `compile()` aborted while its overflow strategy runs no longer lands what the strategy returned.

The compile threw its `AbortError` and sent nothing, but `onCompress` and the `compress` event had already fired, the span was archived, the circuit breaker was cleared and the window lineage had moved on. Now none of that happens, and the compile throws before `compress:end`.

A `background()` job no longer gets the `signal` of the compile that started it. The job isn't part of that request, so a user stopping a streamed reply now leaves a running job running, and it lands on a later compile. Before, a strategy inside `background()` that honors the signal stopped with the compile, and the job was lost with a "background compression job crashed unexpectedly" warning. The job now has a signal of its own, aborted when the job is dropped: by `chef.restore()` or `clearHistory()` (`restoreState()` or `reset()` on a Janitor you hold yourself), or under `appendOnly` when another compaction takes its place. A dropped job lands nothing and logs no warning. It used to keep running, so a summarizer that failed after `clearHistory()` still warned and counted toward the circuit breaker of the conversation that had just started over. `summarize()` and `anchored()` now count no failure, and log none, once their signal is aborted, a compile's or a job's, whether the model call or `validateCompression` ends after it.

A compile aborted before `background()` runs (in a `compress:start` handler, say, or during an earlier `chain()` step) leaves a finished job waiting, and the next compile lands it. Once the signal is aborted, `chain()` also stops before its next step, so an aborted compile no longer pays for a summarization nobody will use.

`janitor.overflow(history, { signal })` called on its own changes the same way. A call that would run the strategy throws the signal's reason once it is aborted, before the strategy runs or while it runs (an `AbortError` unless you aborted with a reason of your own), and lands nothing. It used to land and return whatever the strategy returned. A call that never reaches the strategy, because the history is within budget or an open circuit breaker holds it, resolves as before.
