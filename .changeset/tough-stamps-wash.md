---
"@context-chef/core": minor
---

### Compression now strips media attachments to text placeholders

`Janitor.executeCompression()` no longer ships binary attachment data through the compression call. Each attachment in the messages being compressed is replaced inline with a `[image]` / `[image: photo.png]` / `[document]` / `[document: report.pdf]` text marker before the compressionModel is invoked. The summarizer sees that media existed at this point in the conversation without being asked to process raw base64.

- Modeled on Claude Code's `stripImagesFromMessages` strategy
- Avoids prompt-too-long failures on the compression call itself when histories contain many images
- Empty `mediaType` produces `[attachment]` instead of misleading `[document]`
- `toKeep` (the recent messages preserved verbatim) is untouched — its attachments still reach the main model through the target adapter

### Removed `Prompts.MEDIA_DESCRIPTION_INSTRUCTION`

The constant is gone from the exported `Prompts` object. It was previously appended to the compression prompt when attachments were detected, asking the compression model to "describe the visual content." In practice this never worked — `compressionModel` is a `(Message[]) => Promise<string>` function with no adapter pipeline, so the binary data on `Message.attachments` was never actually forwarded to the LLM. The new placeholder-based strategy supersedes it.

If you imported `Prompts.MEDIA_DESCRIPTION_INSTRUCTION` directly, remove the reference — the behavior it described was already a no-op.
