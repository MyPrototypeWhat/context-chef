---
"@context-chef/ai-sdk-middleware": minor
---

Replace compact implementation with AI SDK's `pruneMessages`

**Breaking change to `CompactConfig`:**

Before:
```typescript
compact: { clear: ['thinking', { target: 'tool-result', keepRecent: 5 }] }
```

After:
```typescript
compact: { reasoning: 'all', toolCalls: 'before-last-message' }
```

- `CompactConfig.clear` replaced with `reasoning`, `toolCalls`, and `emptyMessages` fields, matching `pruneMessages` parameters
- Compact now runs before IR conversion (on raw AI SDK messages) instead of after
- Removed `TOOL_RESULT_CLEARED_INSTRUCTION` system prompt injection — `pruneMessages` removes chunks entirely rather than replacing with placeholders
- Per-tool pruning support via `toolCalls` array form: `[{ type: 'before-last-message', tools: ['search'] }]`
