---
"@context-chef/core": minor
---

`checkPrefixContinuity(prev, next)` tells whether the payload sent on one turn is still the prefix of the payload for the next: system prompt and tools unchanged, every earlier message repeated as it was, new ones only appended. It reports the first place that differs (`'system'`, `'tools'`, `'messages[3]'`, …) and ignores key order and `cache_control`. It reads every target's payload shape, including OpenAI Responses (`instructions` + `input`).

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign each thinking block over everything before it, so a turn that fails this check fails theirs when it replays thinking. Use it in tests across two consecutive compiles. By default, tail injections (dynamic state at `'last_user'`, announcements on either channel, guardrail `placement: 'last_user'`) move to the new tail on every compile and fail it; a test in the core suite records that. With the new `appendOnly` option, consecutive compiles pass it unless one reports a checkpoint.
