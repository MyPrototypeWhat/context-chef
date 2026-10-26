---
"@context-chef/core": patch
---

The Anthropic target no longer sends an empty text block next to a message's other content.

A message built from IR fields with no text still went out with a text block holding `''`: a tool-call turn as `[text '', tool_use]`, a reply with thinking and no text as `[thinking, text '']`, a user message with only attachments as `[text '', image]`. The model reads nothing from such a block, and if the API rejects one the whole request fails, so now only the message's other blocks are sent. A tool-call turn the model sent without text now goes back the way it was sent, which matters on Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5: they check that earlier turns are unchanged before accepting the thinking after them.

- A `_cache_breakpoint` meant for the text that was left out goes on the message's last block instead. A reply that is only thinking has no block that can carry one, as when such a reply is replayed verbatim.
- A message with nothing else to send keeps its empty text block.
- Text that is only whitespace is still sent: it is text the model wrote.

History parsed with `fromAnthropic` and sent back unchanged was already replayed as it came in, and is not affected.
