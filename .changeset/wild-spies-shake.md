---
'@context-chef/ai-sdk-middleware': minor
---

Compression is now opt-in: `createMiddleware` only constructs a Janitor when a compression option is configured (`compress`, `onCompress`, `onBeforeCompress`, or `onBudgetExceeded`). `contextWindow` becomes optional and is only required — enforced with a throw at construction time — when one of those options is present.

Truncate / compact / skill / dynamicState-only configurations no longer need a `contextWindow` sentinel or a dummy tokenizer, no longer run budget checks or capture token usage, and no longer trigger the Janitor's per-instance missing-tokenizer `console.warn`.

Behavior change: previously, passing only `contextWindow` silently enabled discard-style compression (old messages dropped with a placeholder summary) once the budget was exceeded. That implicit, lossy default is gone — opt in explicitly via `compress` or the compression hooks to get budget-driven behavior.
