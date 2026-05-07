---
'@context-chef/core': patch
'@context-chef/ai-sdk-middleware': patch
'@context-chef/tanstack-ai': patch
---

feat: physical-path truncation marker + compress tool-result stub

Two cooperating improvements that make tool-result handling cheaper and easier
to wire into existing agents.

**`Offloader` exposes the underlying physical path in the truncation marker.**
`VFSStorageAdapter` gains an optional `getPhysicalPath(filename)` method;
`FileSystemAdapter` implements it. When the adapter returns a path, the
marker advertises it as the primary retrieval handle (`Full output saved to:
/path/to/file`) and demotes the URI to an alternative — the model can pull
the original content back with its existing file-read tool, no custom
URI-aware tool required. Adapters that don't map to a filesystem (DB,
in-memory) leave the method unset and the marker falls back to the
`context://vfs/` URI alone.

**`Janitor` gains `toolResultStubThreshold`** (also exposed on both
middlewares as `compress.toolResultStubThreshold`). When set, tool-result
content longer than the threshold is replaced with a one-line metadata stub
— `[Tool name returned N chars; omitted before summarization]` — *only*
inside the to-be-summarized portion. Recent (preserved) tool results are
untouched. Tool name is resolved from the preceding assistant turn's
`tool_calls[].function.name` via `tool_call_id`. tool_use ↔ tool_result
pairing is structurally preserved so the summarizer doesn't see orphan
calls. Default: undefined (disabled). Recommended starting value: `5000`.

This second change relaxes the prior "compact + compress incompatibility"
warning around clearing tool-result: the in-compress stub path operates on
compress's own boundary, so the "preserve recent / summarize old" split
stays coherent without two windows competing.
