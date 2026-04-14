---
"@context-chef/core": minor
---

### Multimodal Attachment Support

- Added `Attachment` interface and `Message.attachments` field to IR for provider-neutral media representation
- Janitor detects `attachments` during compression and augments the prompt with `MEDIA_DESCRIPTION_INSTRUCTION` to guide the compression model toward describing image/media content in summaries
- Output adapters (`compile()`) now convert `attachments` to provider-specific formats:
  - OpenAI: `image_url` / `file` content parts
  - Anthropic: `image` / `document` content blocks
  - Gemini: `inlineData` / `fileData` parts

### Input Adapters (Provider → IR)

- Added `fromOpenAI()`, `fromAnthropic()`, `fromGemini()` to convert provider-native messages to ContextChef IR
- Returns `{ system, history }` — automatically separates system messages from conversation history
- Multimodal content (images, files, documents) automatically mapped to IR `attachments`
- New types: `HistoryMessage`, `ParsedMessages`
