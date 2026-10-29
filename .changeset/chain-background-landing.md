---
"@context-chef/core": patch
---

`chain()` and `background()` fixes:

- `chain()` keeps pinned messages protected in the steps after a `background()` job lands, also when you build your messages anew for each request. It matched them by object identity, so a `reset()` after the job could drop them. A pinned list you hand to a `chain()` you call yourself is still protected in every step.
- When the runner calls a strategy only so that a finished `background()` job can land (the window is under the trigger), `chain()` runs only the steps holding such a result. `chain(summarize(), background(...))` no longer summarizes again below the trigger on that call.
- Past an open circuit breaker, a strategy is only offered its finished background job to land, never asked for a new compaction (with `appendOnly`, unless the request would exceed `contextWindow`). A finished job that no longer applies is dropped there, and its replacement starts on the next compile instead of the same one.
