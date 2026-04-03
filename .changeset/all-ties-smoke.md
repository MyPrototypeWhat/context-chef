---
"@context-chef/core": patch
---

Add compact + compress interaction guidance to JSDoc and README

- Document that clearing `tool-result` in compact before compress causes the compression model to receive empty placeholders, producing low-quality summaries
- Add recommended usage patterns: use `compact` for `thinking` only when combined with `compress`, use `tool-result` clearing only without `compress`
- Update `preserveRecentMessages` description to clarify it counts turns (not individual messages)
- Add Compact section to core README with usage examples and interaction notes
