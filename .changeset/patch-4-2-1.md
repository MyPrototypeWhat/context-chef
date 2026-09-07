---
"@context-chef/core": patch
---

Two overflow fixes.

- The overflow runner now resets its circuit breaker on any successful overflow, whichever strategy did the work. Before, only the summarizing strategies (`summarize()` / `anchored()`) reported success, so `chain(summarize(), reset())` — where `reset()` rescues a failed summary — still counted every rescued failure, and after three the open breaker stopped calling the strategy at all: `reset()` never ran again and the window stayed over budget for the rest of the session.
- `reset()`'s default notice no longer tells the model the earlier conversation "was archived". Archiving is opt-in; the runner's citation line already says so, with the address, when an archive is configured. Hosts that pass their own `ResetOptions.notice` are unaffected.
