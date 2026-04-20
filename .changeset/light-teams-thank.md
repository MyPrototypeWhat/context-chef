---
"@context-chef/ai-sdk-middleware": patch
---

`fromAISDK()` now maps AI SDK `FilePart` (type `'file'`) on user and assistant messages to IR `attachments`, so multimodal turns participate in the new core compression placeholder logic (`[image]` / `[document]` markers in the compression payload).

`Attachment.data` in the middleware path is a presence/metadata signal only — Janitor reads `m.attachments?.length` for placeholder injection but never the binary itself. The actual `Uint8Array` / `URL` / string payload round-trips losslessly through `_userContent` / `_assistantContent`, which `toAISDK()` hands back to the underlying AI SDK provider verbatim. No re-encoding, no data loss.
