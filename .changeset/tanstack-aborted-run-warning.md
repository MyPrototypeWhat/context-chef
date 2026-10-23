---
"@context-chef/tanstack-ai": patch
---

`onConfig` no longer logs "onConfig transform failed; passing the request through unchanged" for a `chat()` run that was already aborted. The config is still passed through as before; nothing of an aborted run goes out, so there is no request to warn about.
