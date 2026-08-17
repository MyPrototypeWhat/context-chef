# 适配器

适配器是边界层：input adapter 把 provider 原生消息转换为 ContextChef IR，target adapter 把 IR 编译为 provider 就绪的 payload —— 让同一套 prompt 架构在 OpenAI、Anthropic、Gemini 以及你自己注册的任何 provider 上通用。

## Input Adapters（Provider → IR）

将 OpenAI / Anthropic / Gemini 原生消息转换为 ContextChef IR，自动分离 system 和 history。每个 adapter 都会在出口跑一次 `ensureValidHistory` 做边界 sanitize —— 删除孤儿 tool result、为缺失的 tool result 注入 `[No tool result available]` 占位、强制首条非 system 消息为 user。手动 `chef.setHistory(...)` 进来的 IR **不**做 sanitize：trust IR，或者自己显式调用 `ensureValidHistory(messages)`。

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

多模态内容（图片、文件）自动转换为 IR `attachments` 字段：

| Provider 格式                    | IR 字段                              |
| -------------------------------- | ------------------------------------ |
| OpenAI `image_url` / `file`      | `attachments: [{ mediaType, data }]` |
| Anthropic `image` / `document`   | `attachments: [{ mediaType, data }]` |
| Gemini `inlineData` / `fileData` | `attachments: [{ mediaType, data }]` |

`compile()` 时 `attachments` 自动转换回对应 provider 格式。压缩时 Janitor 会引导压缩模型描述图片内容。

## Target Adapters

| 特性                      | OpenAI                             | Anthropic                              | Gemini                               |
| ------------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------ |
| 格式                      | Chat Completions                   | Messages API                           | generateContent                      |
| 缓存断点                  | 移除                               | `cache_control: { type: 'ephemeral' }` | 移除（使用独立的 CachedContent API） |
| Prefill（尾部 assistant） | 降级为 `[System Note]`             | 原生支持                               | 降级为 `[System Note]`               |
| `thinking` 字段           | 移除                               | 映射为 `ThinkingBlockParam`            | 移除                                 |
| 工具调用                  | `tool_calls` 数组                  | `tool_use` blocks                      | `functionCall` parts                 |
| `attachments`             | `image_url` / `file` content parts | `image` / `document` blocks            | `inlineData` / `fileData` parts      |

适配器由 `compile({ target })` 自动选择。也可以独立使用：

```typescript
import { getAdapter } from "@context-chef/core";
const adapter = getAdapter("gemini");
const payload = adapter.compile(messages);
```

## `openai-responses` target <Badge type="tip" text="v4" />

面向 OpenAI Responses API 的第四个内置 target。`compile({ target: "openai-responses" })` 产出 `OpenAIResponsesPayload { instructions?, input, tools?, meta? }`，`fromOpenAIResponses(items, instructions?)` 是配套的 input adapter：

```typescript
import { fromOpenAIResponses } from "@context-chef/core";

const payload = await chef.compile({ target: "openai-responses" });
const { system, history } = fromOpenAIResponses(response.output, instructions);
```

往返转换处理 `message` / `function_call` / `function_call_output` 条目（按 `call_id` 关联，乱序安全），逐字节保留 reasoning 条目的 `encrypted_content`，并把 `input_image` / `input_file` part 转为 IR attachments。

## Gemini thought signatures <Badge type="tip" text="v4" />

Gemini 3.x 会拒绝当前轮次里缺失 thought signature 的 function call（HTTP 400）。`fromGemini` 会捕获它们 —— `functionCall` part 存进 `ToolCall.thoughtSignature`，text part 走透传字段 —— `GeminiAdapter` 原样重新发出。它们对 `compact({ clear: ['thinking'] })` 免疫。

## `preserveThinkingAsText` <Badge type="tip" text="v4" />

`new OpenAIAdapter({ preserveThinkingAsText: true })` / `new GeminiAdapter({ preserveThinkingAsText: true })` 会把 Anthropic 风格的 `thinking` 转成 `<thinking>...</thinking>` 文本前缀而不是丢弃 —— 适合在会话中途把 Claude 对话迁到其他 provider。`redacted_thinking` 永不文本化（丢弃，并给出一次警告）。默认 `false`。

## 自定义适配器 —— `adapterRegistry` 与 `defaultTarget`

三个内置适配器（`'openai' | 'anthropic' | 'gemini'`）会自动注册。如果想接入第三方协议（Cohere、Mistral、自家私有协议），实现 `ITargetAdapter` 后注册一次即可：

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

`compile({ target })` 接受三种形式：

| 形式             | 示例                                   | 适用场景                            |
| ---------------- | -------------------------------------- | ----------------------------------- |
| 内置字面量       | `compile({ target: "openai" })`        | 通过类型重载获得精确 payload 类型   |
| 注册名字符串     | `compile({ target: "cohere" })`        | 复用同一个第三方适配器多次          |
| `ITargetAdapter` | `compile({ target: new MyAdapter() })` | 一次性使用 / 测试 — 跳过 registry   |

在构造函数中设置 `defaultTarget` 可以避免每次调用都传 target：

```typescript
const chef = new ContextChef({ defaultTarget: "anthropic" });
await chef.compile(); // → AnthropicPayload
```

`compile()` 解析顺序：
`options.target` → `ChefConfig.defaultTarget` → `'openai'`（最终内置兜底）。

对插件系统和测试隔离，可以传入 `sourceId`，把一组注册按来源批量卸载：

```typescript
adapterRegistry.register("cohere", new CohereAdapter(), "my-plugin");
adapterRegistry.register("mistral", new MistralAdapter(), "my-plugin");
// Later — unload the entire plugin in one call
adapterRegistry.unregisterBySource("my-plugin");
```

> **替换内置名**（如 `register('openai', myFork)`）会保留 strict overload 的 payload 返回类型 —— `compile({ target: 'openai' })` 仍标注为 `Promise<OpenAIPayload>`，因此你的替换实现在运行时必须遵守该 shape。TypeScript 无法在替换层面强制这个约束。
