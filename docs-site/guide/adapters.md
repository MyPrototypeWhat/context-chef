# Adapters

Adapters are the boundary layer: input adapters convert provider-native messages into ContextChef IR, and target adapters compile IR into provider-ready payloads — so the same prompt architecture works across OpenAI, Anthropic, Gemini, and anything you register yourself.

## Input Adapters (Provider → IR)

Convert OpenAI / Anthropic / Gemini native messages to ContextChef IR, automatically separating system and history. Each adapter sanitizes the result via `ensureValidHistory` at the boundary — orphan tool results are dropped, missing tool results get an `[No tool result available]` placeholder, and the first non-system message is forced to be a user message. IR you build manually with `chef.setHistory(...)` is NOT sanitized; trust the IR or call `ensureValidHistory(messages)` yourself.

```typescript
import { fromOpenAI, fromAnthropic, fromGemini } from "@context-chef/core";

// OpenAI
const { system, history } = fromOpenAI(openaiMessages);
chef.setSystemPrompt(system).setHistory(history);

// Anthropic (system is a separate top-level parameter)
const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
chef.setSystemPrompt(system).setHistory(history);

// Gemini (systemInstruction is a separate top-level parameter)
const { system, history } = fromGemini(geminiContents, systemInstruction);
chef.setSystemPrompt(system).setHistory(history);
```

**`fromAnthropic` history replays verbatim.** History parsed with `fromAnthropic` compiles back to the Anthropic target byte-for-byte while nothing has modified it: every thinking block, separate text blocks, parallel tool results plus the user text after them as one user message, and blocks the IR does not model (server tool use, web search results, compaction block signatures). Each parsed message records where it came from in `Message._anthropic_origin`, which keeps a copy of the original blocks: an image or document is stored twice, in `attachments` and in that copy, in the parsed history and in every snapshot of it. This matters because Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign each thinking block over everything before it, and on accounts created on or after 2026-08-31 the API returns 400 when an earlier turn differs from what the model saw. A message you modify (a cleared tool result, stripped thinking) is rebuilt from IR fields as before, and `cache_control` markers in the original are replaced by the chef's own breakpoints. What else can still change an earlier turn, and the `drop_block` safety net, are on [Claude Thinking Prefix Check](/guide/thinking-prefix).

**Mid-conversation system messages** <Badge type="tip" text="4.3" />**.** `fromAnthropic` skips the `role: "system"` messages a parsed request holds mid-conversation, so a history that had one changes where it was. `fromAnthropic(messages, system, { keepPositionalSystem: true })` keeps them in place as positional system messages, sent back unchanged. Use it for the system messages your own code wrote: a payload the chef compiled also holds the chef's own announcements and events, which it adds again by itself. Under [`appendOnly`](/guide/append-only), a parsed message whose thinking a checkpoint stripped keeps every other block as it came in.

Multimodal content (images, files) is automatically converted to IR `attachments`:

| Provider Format | IR Field |
|---|---|
| OpenAI `image_url` / `file` | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document` | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` converts `attachments` back to the corresponding provider format. During compression, Janitor guides the compression model to describe image content.

## Target Adapters

| Feature                      | OpenAI                             | Anthropic                                                      | Gemini                                     |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions                   | Messages API                                                   | generateContent                            |
| Cache breakpoints            | Stripped                           | `cache_control: { type: 'ephemeral' }`                         | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to an instruction         | Native; `prefillMode: 'instruction'` for models that reject it | Degraded to an instruction                 |
| `thinking` field             | Stripped                           | Mapped to `ThinkingBlockParam`; not sent without a signature   | Stripped                                   |
| Tool calls                   | `tool_calls` array                 | `tool_use` blocks                                              | `functionCall` parts                       |
| `attachments`                | `image_url` / `file` content parts | `image` / `document` blocks                                    | `inlineData` / `fileData` parts            |

Claude Sonnet 4.6, Sonnet 5, Sonnet 5.5 and Haiku 5.5 reject a request whose last message is a prefilled assistant turn (400). For those, set `withGuardrails({ prefill, prefillMode: 'instruction' })`: no target gets a trailing assistant message, and the prefill becomes an instruction, delivered with the other guardrail instructions wherever `placement` puts them. The chef never sees your model id, so the mode is yours to set. See [Guardrail](/guide/guardrail).

Adapters are selected automatically by `compile({ target })`. You can also use them standalone:

```typescript
import { getAdapter } from "@context-chef/core";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

## `openai-responses` target <Badge type="tip" text="v4" />

A fourth built-in target for the OpenAI Responses API. `compile({ target: "openai-responses" })` produces an `OpenAIResponsesPayload { instructions?, input, tools?, meta? }`, and `fromOpenAIResponses(items, instructions?)` is the matching input adapter:

```typescript
import { fromOpenAIResponses } from "@context-chef/core";

const payload = await chef.compile({ target: "openai-responses" });
const { system, history } = fromOpenAIResponses(response.output, instructions);
```

The round-trip handles `message` / `function_call` / `function_call_output` items (joined by `call_id`, out-of-order safe), preserves reasoning items' `encrypted_content` byte-identically, and converts `input_image` / `input_file` parts to IR attachments.

## Gemini thought signatures <Badge type="tip" text="v4" />

Gemini 3.x rejects current-turn function calls whose thought signatures are missing (HTTP 400). `fromGemini` captures them — `ToolCall.thoughtSignature` for `functionCall` parts, a passthrough field for text parts — and `GeminiAdapter` re-emits them verbatim. They are immune to `compact({ clear: ['thinking'] })`.

## `preserveThinkingAsText` <Badge type="tip" text="v4" />

`new OpenAIAdapter({ preserveThinkingAsText: true })` / `new GeminiAdapter({ preserveThinkingAsText: true })` convert Anthropic-style `thinking` into a `<thinking>...</thinking>` text prefix instead of dropping it — useful when moving a Claude conversation to another provider mid-session. `redacted_thinking` is never textified (dropped, with one warning). Default `false`.

## Custom adapters — `adapterRegistry` and `defaultTarget`

The three built-ins (`'openai' | 'anthropic' | 'gemini'`) are registered automatically. To plug in a third-party provider (Cohere, Mistral, an in-house protocol), implement `ITargetAdapter` and register it once:

```typescript
import { adapterRegistry, ITargetAdapter } from "@context-chef/core";

class CohereAdapter implements ITargetAdapter {
  compile(messages) {
    /* return Cohere-shaped payload */
  }
}

adapterRegistry.register("cohere", new CohereAdapter());
await chef.compile({ target: "cohere" }); // routed via the registry
```

`compile({ target })` accepts three forms:

| Form                  | Example                                | Use case                                      |
| --------------------- | -------------------------------------- | --------------------------------------------- |
| Built-in literal      | `compile({ target: "openai" })`        | Strict payload type via the type overloads    |
| Registered name       | `compile({ target: "cohere" })`        | Reuse the same custom adapter many times      |
| `ITargetAdapter`      | `compile({ target: new MyAdapter() })` | One-off use / tests — bypasses the registry   |

Set `defaultTarget` once in the constructor to avoid repeating it on every call:

```typescript
const chef = new ContextChef({ defaultTarget: "anthropic" });
await chef.compile(); // → AnthropicPayload
```

Resolution order in `compile()`:
`options.target` → `ChefConfig.defaultTarget` → `'openai'` (final built-in fallback).

For plugin systems and test isolation, pass a `sourceId` so a batch of registrations can be torn down together:

```typescript
adapterRegistry.register("cohere", new CohereAdapter(), "my-plugin");
adapterRegistry.register("mistral", new MistralAdapter(), "my-plugin");
// Later — unload the entire plugin in one call
adapterRegistry.unregisterBySource("my-plugin");
```

> **Replacing a built-in name** (e.g. `register('openai', myFork)`) keeps the strict overload's payload return type — `compile({ target: 'openai' })` is still typed `Promise<OpenAIPayload>`, so your replacement must honor that shape at runtime. TypeScript can't enforce this for you.

An adapter that can't end a request on an assistant message and turns a prefill into an instruction should say so with `nativePrefill: false` (a wrapper passes on the value of the adapter it wraps). Under [`appendOnly`](/guide/append-only) the chef then sends a guardrail prefill as an instruction, once, instead of letting the adapter fold it into a different user message every turn.

An adapter that wraps the Anthropic one (to log, or to add request fields) should pass on its `anthropicWire` too: `anthropicWire = inner.anthropicWire`. The chef treats a target as Anthropic only by the `'anthropic'` name or by that flag. Without it, server-side context management is skipped. Under [`appendOnly`](/guide/append-only) the thinking a checkpoint invalidated is sent anyway, which the API rejects, and [`onDemandCompaction()`](/guide/append-only#signed-compaction-ondemandcompaction) runs its `fallback` instead of asking for a compaction.
