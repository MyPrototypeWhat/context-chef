---
"@context-chef/tanstack-ai": patch
---

Bump `@context-chef/core` peer to pick up the new media-aware compression strategy (attachments are now stripped to `[image]` / `[document]` text placeholders before reaching the compression model). No source changes in this package — multimodal compression behavior is driven entirely by core.
