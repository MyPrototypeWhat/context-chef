---
"@context-chef/ai-sdk-middleware": patch
"@context-chef/tanstack-ai": patch
---

The warning logged when `compress` keeps firing without `onCompress` said the payload grows without bound. With `@context-chef/core` now compressing every call that is over budget, what is sent stays within it. What an unpersisted summary costs is a summarizer call on every call over budget (every `chat()` call, with TanStack AI), over your whole history, which keeps growing. The warning now says that. The advice is the same: persist the summary through `onCompress`, or compact your own store.
