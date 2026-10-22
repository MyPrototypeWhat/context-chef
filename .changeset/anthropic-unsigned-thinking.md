---
"@context-chef/core": patch
---

The Anthropic target no longer sends a thinking block without a signature. IR thinking with no signature, or an empty one, went out as `signature: ''`, which the API rejects; the block is now left out and the rest of the message is sent as before.
