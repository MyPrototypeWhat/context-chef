---
"@context-chef/ai-sdk-middleware": patch
---

### New Features

- **`compact` option**: Mechanical, zero-LLM-cost compaction before compression. Configure `compact: { clear: ['tool-result', 'thinking'] }` to strip specified content types from history before LLM-based compression triggers.
- **`onBudgetExceeded` hook**: Called when token budget is exceeded, before automatic compression. Return modified messages to intervene, or null to let default compression handle it.
- **`dynamicState` injection**: Inject structured state as XML into the prompt. Supports `last_user` (default, leverages Recency Bias) and `system` placement. State object is auto-converted to XML via `objectToXml`.
- **`transformContext` hook**: Transform the AI SDK prompt after compression, before sending to the model. Enables RAG injection, Memory integration via core, and custom prompt manipulation.
