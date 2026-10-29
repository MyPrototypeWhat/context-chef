---
"@context-chef/core": patch
---

The Anthropic target no longer sends an empty or whitespace-only text block next to a message's other content.

A message built from IR fields with no text still went out with a text block holding `''`: a tool-call turn as `[text '', tool_use]`, a reply with thinking and no text as `[thinking, text '']`, a user message with only attachments as `[text '', image]`. Such a block carries nothing the model wrote, and the thinking check on Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 ignores empty and whitespace-only text blocks, so leaving it out changes nothing a signature covers. It only stops sending a block the API has no use for. A conversation an earlier version sent with such a block keeps its thinking valid after upgrading.

- Text that is empty or only whitespace is left out whenever the message has another block: thinking, a tool call, an attachment or a compaction block.
- A `_cache_breakpoint` on a message whose text was left out goes on its last block instead. A reply that is only thinking has no block that can carry one, as when such a reply is replayed verbatim.
- A message with nothing else to send keeps its text block as it is.

History parsed with `fromAnthropic` and sent back unchanged is replayed as it came in, and is not affected.
