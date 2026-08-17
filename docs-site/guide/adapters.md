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

Multimodal content (images, files) is automatically converted to IR `attachments`:

| Provider Format | IR Field |
|---|---|
| OpenAI `image_url` / `file` | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document` | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` converts `attachments` back to the corresponding provider format. During compression, Janitor guides the compression model to describe image content.

## Target Adapters

| Feature                      | OpenAI                      | Anthropic                              | Gemini                                     |
| ---------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ |
| Format                       | Chat Completions            | Messages API                           | generateContent                            |
| Cache breakpoints            | Stripped                    | `cache_control: { type: 'ephemeral' }` | Stripped (uses separate CachedContent API) |
| Prefill (trailing assistant) | Degraded to `[System Note]` | Native support                         | Degraded to `[System Note]`                |
| `thinking` field             | Stripped                    | Mapped to `ThinkingBlockParam`         | Stripped                                   |
| Tool calls                   | `tool_calls` array          | `tool_use` blocks                      | `functionCall` parts                       |
| `attachments`                | `image_url` / `file` content parts | `image` / `document` blocks   | `inlineData` / `fileData` parts            |

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
