# Append-only 前缀 <Badge type="tip" text="4.3" />

Claude Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5 的每个 thinking 块，签名都覆盖它前面的全部内容。在 2026-08-31 及以后创建的账号上，只要它前面的内容变了，再把这段 thinking 发回去，API 默认就会拒绝请求（见 [Claude thinking 前缀校验](/zh/guide/thinking-prefix)）。默认情况下，ContextChef 每次 compile 都会改动之前的轮次：dynamic state、announcement、memory 等注入渲染在末尾，下一次又挪到新的末尾；客户端摘要会替换掉之前的轮次。对这几个模型来说，上一轮的 thinking 就再也发不回去了。对所有 provider 来说，提示缓存从第一个被挪动的注入开始失效。

`appendOnly` 让已经发出去的内容留在原处：每次的 payload 都完整重复上一次，只在末尾追加。凡是必须改写已发送内容的情况，都会成为一次被报告的*检查点*，不会悄悄改掉。

```ts
const chef = new ContextChef({ appendOnly: true, janitor: { contextWindow: 200_000, compressionModel } });
```

默认关闭，关闭时它不改变任何行为。

## 它保证什么

三条规则：

1. **chef 添加的内容是事件，只追加一次。** dynamic state、announcement、skill 指令、memory、guardrail 和 handoff 提醒，各自成为一条独立消息，追加在它发生变化的那一轮之后，之后每次请求都原样留在那里。内容变了就追加一个新修订（`<dynamic_state rev="2">`）；来源撤掉了就追加一条*墓碑*，也就是一个说明"已撤回"的块。chef 从不改写你的 history：它用一份 *ledger* 记下自己在哪里追加了什么，每次 compile 时按记录重放。
2. **模型能自己读的就不推送。** memory 每个窗口先以一份快照的形式声明一次，之后只追加模型自己不知道的变化。模型通过 `context` 工具读到的内容，作为普通的工具结果出现在对话里。
3. **任何改写都是一次被报告的检查点。** *检查点*指这样一次 compile：它的 payload 从某条消息开始不再重复上一次。原因可能是你改了 history、system prompt 或 tools 变了、一次压缩落地、history 被清空，或者 chef 没有之前发送内容的记录。这次 compile 会通过 `prefix:break` 事件和 `meta.prefix` 报告断在哪里。在 Anthropic 上，它还会把从那里开始已经无法验证的 thinking 去掉，让请求能被接受。去掉的 thinking 之后也不会再发。

两次 compile 之间如果没有检查点，第二次的 payload 就以第一次为开头，逐条一致。唯一的例外是还没被回答的请求：没有任何签名过的 thinking 依赖它，所以追加给它的事件会在重试时跟着 history 的末尾移动，等到后面出现回复才固定下来。

## 打开它

```ts
import { ContextChef } from "@context-chef/core";

const chef = new ContextChef({
  appendOnly: true, // 或 { clearAt: true }，见下文
  janitor: { contextWindow: 200_000, compressionModel },
});

chef.on("prefix:break", ({ reason, at, signed, strippedThinking }) => {
  console.info(`checkpoint (${reason}) at message ${at}`, { signed, strippedThinking });
});

const payload = await chef.setHistory(history).compile({ target: "anthropic" });
payload.meta?.prefix;
// { stable: 12 } —— 前 12 条消息和上一次的 payload 相同
```

`meta.prefix` 只在打开 `appendOnly` 时出现：

- `stable`：窗口里和上一次 payload 完全相同的消息数。
- `break`：这次 compile 应用了检查点时才有，形如 `{ reason, at, signed, strippedThinking }`。`at` 是第一条被改动消息在窗口里的下标（压缩、system prompt 变化、tools 变化时为 0）。`strippedThinking` 是因此在 Anthropic 上去掉的 thinking 块数。`prefix:break` 事件带同样的字段，外加 `windowId`。

| `reason` | 发生了什么 |
|---|---|
| `compaction` | 某个 overflow 策略把窗口开头摘要掉了，或者模型要求开一个新窗口（`new_context`） |
| `history` | 你的 history 和已发送的内容对不上：改了或删了消息、模型看过之后又清理或 offload 了工具结果、你自己写了一份摘要 |
| `system` / `tools` | system prompt 或工具列表变了，包括显式 `'after_system'` 下的 memory 或 skill，以及 `placement: 'system'` 下新的 guardrail options |
| `ledger` | chef 没有已发送内容的记录：新建 chef 时没有恢复它保存的 ledger，或者调用了 `clearHistory()` |

`signed: true` 表示替换内容由 provider 签名（[`onDemandCompaction`](#签名压缩-ondemandcompaction)）：什么都不剥，后面的轮次保留自己的 thinking。

本指南里的「在 Anthropic 上」，指 `'anthropic'` target，或者 `anthropicWire` 为 `true` 的 adapter。`AnthropicAdapter` 自带这个标记，包装它的 adapter 应该把它传下去（见[适配器](/zh/guide/adapters)）。没传下去的包装会被当成其他 provider：什么都不剥，检查点之后的请求会被拒绝。

## 各种注入的变化

| 来源 | 打开 `appendOnly` 后 |
|---|---|
| dynamic state，`'last_user'` | 在它变化的那一轮之后追加一条独立的 user 消息，不再并进你的消息 |
| dynamic state，`'system'` | 一条留在对话原处的 system 消息；在 Anthropic 上不会被挪进顶层 `system` |
| implicit context（`before-assemble` 的 `inject`） | 一条 user 消息，变化时才追加。如果每轮都不一样，窗口每轮都会变长，改成让模型调用的工具可能更合适 |
| announcement | `'system'`（以及 Anthropic 上的 `'auto'`）：一条 system 消息。`'user_tail'`（以及其他 target 上的 `'auto'`）：一条 user 消息。`retractAnnouncement()` 追加一条墓碑，之前的声明留在原处 |
| skill 指令 | 没设置 `skillPlacement` 时等于 `'tail'`：每次激活或切换追加一条 system 消息，`activateSkill(null)` 追加墓碑。显式设置 `'after_system'` 时仍放在 system prompt 里，每次变化都是一次 `system` 检查点 |
| memory | 没设置 `memoryPlacement` 时等于 `'before_history_tail'`：以事件的形式出现，见 [Memory](#memory)。显式设置 `'after_system'` 时仍放在 system prompt 里，每次变化都是一次 `system` 检查点 |
| guardrail，`placement: 'last_user'` | 一条 user 消息，options 变化时才追加 |
| guardrail，`placement: 'system'` | system prompt 的最后一部分；options 变化是一次 `system` 检查点 |
| guardrail prefill | Anthropic：和以前一样是末尾的 assistant 消息（没有签名依赖它）。OpenAI 和 Gemini：没设置 `prefillMode` 时等于 `'instruction'`，和其他 guardrail 指令一起只发一次；显式设置 `'native'` 会照办，并 warn 一次 |
| handoff 提醒 | 每个窗口一次，走 `'auto'` announcement 所走的通道 |

事件永远不会插在 assistant 的 tool call 和它们的结果之间。tool call 等结果期间发生的变化，会紧跟在结果后面送到模型。同一次 compile 追加的内容最多合成一条 user 消息和一条 system 消息（打开 `clearAt` 时再加一条每轮提醒的 system 消息）；状态块后面的那行说明会告诉模型：每个块都取代同类的旧块。如果它们前面没有 user 轮（比如空 history，或者刚收到回复后的那次 compile），system 事件会改为一条 user 消息发出，这样 Anthropic 就不会把它们挪进顶层 `system`。

### 每轮提醒：`clearAt`

每个修订都留在窗口里，所以频繁变化的状态会一直占 token。在 Anthropic 上，`appendOnly: { clearAt: true }` 把 system 通道的来源（skill 指令、`'system'` 位置的 dynamic state、system 通道的 announcement）改成每轮一条的提醒：每次请求都带上它们的当前状态，并标上 `clear_at: 'next_user_message'`。后面出现 user 消息之后（只含 tool result 的也算），API 会清除这条提醒，它留在原处、不再占 token。chef 会把 `mid-conversation-system-clear-at-2026-08-21` beta 加进 `payload.betas`。其他 target 忽略这个选项。

- 来源停了，提醒也就不再重复，只有两种情况仍会追加墓碑：重试一个提醒里还写着这个来源的请求；这个来源之前以普通事件的形式声明过（在 user 通道上，或者在打开 `clearAt` 之前），因为那条声明会比所有提醒都活得久。
- 提醒前面必须紧挨着一个 user 轮。没有的请求（比如空 history，或者刚收到回复后的那次 compile）就不带提醒。

### Memory

- 窗口开头是 `selector` 选中内容的一份快照。之后只追加模型自己不知道的变化，作为 delta：你自己调用的 `getMemory().set()`、`delete()`，以及 TTL 过期。模型通过 `chef.handleTool` 做的写入不会再推回去，因为它的工具结果已经告诉了模型。
- 检查点之后，chef 不再记得哪些写入是模型做的，所以有的写入可能会在检查点之后再声明一次。
- selector 没选中的条目，变化时不推送；但模型看过或写过它之后，删除它会推送。
- 想完全靠拉取，就用 `selector: () => []` 配合 `tools: 'unified'`，让模型自己读 `context://memory/*`。注意 unified 的说明文字仍然告诉模型 memory 会"shown to you automatically below"，这时这句话就不成立了。
- `meta.injectedMemoryKeys` 列出本次 compile 的快照或 delta 涉及的 key（包括被删除的），没有追加时为空。
- 如果某个 memory hook 或 `memory:changed` 监听器改写了模型刚写的同一个 key，这次改写会被记成模型写入的一部分，在这个 key 再次变化之前不会被推送。写其他 key 照常推送。

## 压缩

客户端摘要会替换之前的轮次，而摘要之后保留下来的每一轮，它的 thinking 签名都覆盖了被替换掉的那些轮次。所以没签名的压缩是一次检查点，在 Anthropic 上，保留下来的轮次会失去 thinking。

打开 `appendOnly` 后，压缩**只落地一次**。它的结果，也就是摘要加上放回去的 pinned 消息，成为窗口的 *head*：之后每次 compile 都用它代替它摘要掉的那些消息，直到窗口再次超出预算才会重新摘要。

**什么时候落地。** 没签名的压缩会等到 user 轮边界，也就是 history 的末尾既不是工具结果、也不是还在等结果的 tool call。在工具轮中途压缩，会剥掉这一轮还需要的 thinking。只有两种情况不能等：

- 请求会超过原始上下文窗口，也就是 `janitor.contextWindow` 本身，而不是触发阈值；
- 模型要求开一个新窗口（`requestNewContext()`、`new_context`）。

这时整个窗口，包括正在进行的这一轮，收拢成一份摘要。pinned 消息仍然放回摘要之后，还在等结果的 tool call 也会保留。在 user 轮边界上，超过原始上下文窗口的请求会在同一次 compile 里压缩：`background()` 当场运行它的策略，而不是启动一个后台任务。

**策略看到什么。** overflow 读的是窗口：head、它之后你的消息，以及夹在其中的 chef 事件，所以摘要模型也会看到这些事件。`onBeforeCompress` hook 仍然可以返回改写后的 history，但在 `appendOnly` 下，只有压缩落地时它才会进入 payload。

### 签名压缩：`onDemandCompaction`

Anthropic 的按需压缩（beta `compact-2026-09-04`）把一个模型已经回答过的请求摘要成一个由 provider 签名的块。这个块替换掉它摘要的内容，块之后保留的轮次保留自己的 thinking。在 thinking 校验下，这是唯一什么都不剥的客户端压缩（`server()` 的服务端压缩同样不会碰你发出的内容），也是唯一不用等工具轮结束的压缩。它需要在 Anthropic target 上打开 `appendOnly`，从第二次请求起可用。

```ts
import { ContextChef, onDemandCompaction, summarize } from "@context-chef/core";

const chef = new ContextChef({
  appendOnly: true,
  janitor: { contextWindow: 200_000 },
  overflow: {
    strategy: onDemandCompaction({
      compact: ({ payload, compaction, betas }, signal) =>
        client.beta.messages.create(
          { ...payload, model, max_tokens, thinking, compaction, betas },
          { signal },
        ),
      keepRecentTurns: 1,
      fallback: summarize({ compressionModel }),
    }),
  },
});
```

- `compact` 拿到的是可以直接发送的请求。`payload` 是切点之前的窗口，和当初发送的字节完全一致，system prompt 和 tools 取自上一次的 payload；`betas` 已经包含 `compact-2026-09-04`。像发送编译出的 payload 一样发送它，用对话本身的模型和 thinking 设置，然后返回响应。`stop_reason` 不是 `'compaction'` 的响应算一次失败的压缩，计入熔断器，窗口保持不变。
- `keepRecentTurns`（默认 1）是块之后保留的回复数，每个回复连同它之后直到下一个回复的全部内容；`0` 表示整个窗口都摘要。`instructions` 替换 provider 默认的摘要 prompt，最多 16,384 个字符。
- **一定要给 `fallback`。** 凡是无法签名的地方都由它来跑：其他 target、第一次请求（还没有发送过任何内容）、被 `onBeforeCompress` hook 改写过的窗口、轮次太少不够保留。超过原始上下文窗口时，签名尝试失败也由它接手。和任何没签名的策略一样，它只在 user 轮边界上运行，或者用来收拢一个等不了的工具轮。没有 fallback 时，一个超过原始上下文窗口又无法签名压缩的窗口，会算作一次失败的压缩，并按原样发出去。
- 组合方式是 `onDemandCompaction({ fallback })`，而不是 `chain(onDemandCompaction(…), summarize(…))`：chain 不是签名策略，会像任何没签名的策略一样等工具轮结束。`background(onDemandCompaction(…))` 可以用：请求在任务开始时就渲染好，只有窗口渲染出的内容仍然一致时，任务结果才会落地。
- 之后的每次请求都把这个块放在最前面，这些 payload 的 `payload.betas` 都带 `compact-2026-09-04`。不打开 `appendOnly` 时，如果你回放一个通过 `fromAnthropic` 恢复的块，需要自己加上这个 beta。
- 被摘要范围里的 system 消息、图片和文档会丢失。chef 会在块之后重新声明自己的事件。被摘要范围里的 pinned 消息不能放回块和它保留的轮次之间，所以 chef 在窗口末尾用一条 `<pinned_messages>` 事件重新声明它们。
- 它不能和 `server()` 组合：带服务端 `context_management` 的请求不能要求按需压缩，回放这个块的请求也不能被服务端压缩。两者同时配置时，chef 在构造时 warn 一次。

压缩请求带着窗口当初发送时的缓存断点。如果你每轮都把断点挪到最新一条消息上，压缩请求这个整个会话里最大的请求就会完全没有缓存命中。在 `compact` 里给 `payload.messages` 的最后一个块加上 `cache_control`，应该能复用之前那次请求写下的缓存；这一点还没有用 API 验证过。

## 持久化对话

`snapshot()` 和 `restore()` 会把 ledger（`ChefSnapshot.prefixLedger`）和模型写入 memory 的记录（`ChefSnapshot.modelMemoryWrites`），连同 chef 的其他状态一起带上。恢复它们不算检查点：下一次 compile 会重复已经发送的内容。

**每个请求新建一个 chef 时，必须保存它的快照，并在下一个请求里恢复。** 没有 ledger 的 chef 无从知道上一次请求发了什么。它的第一次 compile 会报告一次位于 0 的 `ledger` 检查点，在 Anthropic 上会剥掉 history 里的全部 thinking，而且每个请求都这样。chef 第一次遇到这种情况、而 history 里已经有超过两条带 thinking 或推理的回复时，会 warn 一次。

```ts
async function handleRequest(conversationId: string, history: Message[]) {
  const chef = new ContextChef({
    appendOnly: true,
    store: backend, // 跨请求、跨对话共享的 memory
    memory: {},
    janitor: { contextWindow: 200_000, compressionModel },
  });
  chef.registerSkills(skills); // 放在 restore() 之前，这样保存下来的激活 skill 能按名字找回
  const saved = await db.load(conversationId); // 一个 ChefSnapshot，以 JSON 存储
  if (saved) chef.restore({ ...saved, modules: { ...saved.modules, memory: null } });
  // 以下都放在 restore() 之后，因为 restore() 会用保存的值替换它们：
  // system prompt、tools、guardrail、dynamic state、announcement 和 skill 激活。
  chef.setSystemPrompt(systemPrompt).registerTools(tools);

  const payload = await chef.setHistory(history).compile({ target: "anthropic" });
  await db.save(conversationId, chef.snapshot()); // 1. 请求发出之前

  // 发送请求，把回复原样加进这个对话的 history（下一个请求的 history 里必须有它），
  // 再执行其中的 tool call（chef 自己的工具交给 chef.handleTool）。
  await runTurn(chef, payload);
  await db.save(conversationId, chef.snapshot()); // 2. 所有 handleTool 调用之后
}
```

- **先恢复，再配置。** `restore()` 会用保存的值替换 system prompt、tools、guardrail、dynamic state、announcement 和当前激活的 skill。如果在它之前设置这些，保存的值会胜出并再次被保存，新的 prompt 或工具列表永远不会生效。skill 要在它之前注册，这样保存下来的激活 skill 才能按名字找回。
- **恢复时跳过 memory**（`memory: null`），因为它存在共享存储里。恢复快照里的那份副本，会把存储回滚到保存时的样子，之后不管是这个对话还是其他对话写入的 memory 都会丢失。其余状态都会恢复，包括 overflow runner 的状态（窗口、熔断器、上报的用量）和 handoff 提醒的标记。如果 chef 的状态只存在于快照里，就恢复整份快照。
- **第一次保存**保证已经发出的请求一定有记录，即使在回复存好之后有地方抛错。没有它，下一个请求会恢复更早的 ledger，在一个 thinking 签名时并不存在的前缀上回放 thinking，而且什么都不报告。如果一个请求里 compile 了不止一次，每次 compile 之后都要保存。
- **第二次保存**记录模型通过 `handleTool` 写入的 memory，这样下一个请求就不会把它们再推送给模型。如果进程在两次保存之间崩溃，代价只是某条 memory 再声明一次，对话不会坏。
- memory 的轮次计数属于被跳过的那部分，所以它每个请求都从头开始；在每个请求新建的 chef 上，按轮次的 TTL（一个数字，或 `{ turns }`）实际上永远不会过期。使用共享存储时，请用 `{ ms }` 形式的 TTL。

**持久化压缩结果**是可选的：head 存在 ledger 里，你的 history 可以保留每一条消息。只有想让存储本身变小时才需要写回。写回时，把 `details.replacement` 原样、按顺序写到它替换掉的那些消息的位置，也就是你 history 里的前 `count` 条：

```ts
janitor: {
  contextWindow: 200_000,
  compressionModel,
  onCompress: (_summary, count, details) => {
    if (details.replacement) store = [...details.replacement, ...store.slice(count)];
  },
},
```

`replacement` 是摘要（或签名块）、放回摘要之后的 pinned 消息，以及它从更早的 head 里保留下来的内容。下一次 compile 会把这个 history 认作已经收下了这次压缩，什么都不报告。写回其他内容就和被摘要的内容对不上了：pinned 消息也被放回时只写摘要、写你自己的摘要、把摘要写成 system 消息，都会成为一次 `history` 检查点，你的 history 按原样发出。在 `appendOnly` 下，`compressedMessages` 和 `count` 不包含 chef 的事件，因为你的存储里本来就没有它们。

按 `count` 切片的前提是，你的存储里已经有之前的每一份 `replacement`。只要漏写回一次，下一次压缩就会把那份旧摘要再摘要一遍：这时 `count` 数的是那份摘要和它放回的 pinned 消息，而不是它所代表的你的那些消息，切片就错位了。你的存储要么留下已经被摘要过的消息，要么丢掉还没被摘要的消息，下一次 compile 会报告一次 `history` 检查点。漏写回之后，或者在对话进行到一半才开始持久化时，不要切片：保留完整的 history 即可，反正 head 存在 ledger 里。

用 `onDemandCompaction` 时，replacement 只有那个块。写回它，就会把它摘要掉的 pinned 消息和范围里的其他内容一起移出你的 history，chef 也会撤回对它们的重新声明。如果你依赖 pinned 消息，就保留完整的 history，不要写回按需压缩的结果。

- `clearHistory()` 会让 ledger 从头开始：下一次 compile 报告一次 `ledger` 检查点。
- `fromAnthropic` 默认跳过解析出的请求里位于对话中间的 system 消息，这会让 history 在它们原来的位置发生变化。`fromAnthropic(messages, system, { keepPositionalSystem: true })` 会把它们留在原处，用于你自己代码写的 system 消息。见[适配器](/zh/guide/adapters)。

## 检查它：`pipelineChecks`

打开 `pipelineChecks: true` 后，每个 payload 都会和 chef 上一次发出的 payload 比较。除非这次 compile 报告了检查点，否则它必须重复上一次的 payload（上一次的请求还没被回答时，比到它的最后一条回复为止；已经有回复之后，除了末尾的 prefill 全部都要比），并且把上一次发过的每个 thinking 签名都发出去。不符合的会通过 `pipeline:invariant` 和 logger 报告，不会抛错。比如改写之前消息的 slot handler，会在这里被报告，但不会被阻止。

- 报告了检查点的 compile 不做比较。
- 比较需要同一个 chef 的上一次 payload，所以 `restore()` 之后的第一次 compile 不检查：每个请求新建的 chef，从它在一个请求里的第二次 compile 开始才会被检查。
- 它的开销是每个 payload 一份 JSON 拷贝，外加对其中一部分最多两次 adapter 渲染，这还不算其他检查。只在开发和测试时打开。

## OpenAI 和 Gemini

同样的 ledger、事件和检查点，只是没有 Anthropic 独有的部分：

- 检查点只报告，什么都不剥：没有签名可以失败。
- 忽略 `clearAt`，也不加 betas。
- system 事件在 Chat Completions 上是留在原处的 system 消息，在 Responses 上是一个输入 `message` item，在 Gemini 上是 user 内容，并和相邻的 user 轮合并。
- guardrail prefill 默认改为指令（见上面的表）。自定义 adapter 如果会把 prefill 转成指令，应该设置 `nativePrefill: false`。
- 一个对话只用一个 target：system prompt 和 tools 是按上一次请求发送的形式比较的，所以换 target 就是一次检查点。

在这些 provider 上，你得到的是一个只会增长的前缀，所以 provider 的前缀缓存能持续命中；压缩也只落地一次，不会每轮重算。

## AI SDK 和 TanStack AI

两个 middleware 也都支持 `appendOnly`。每个对话在 middleware 里有自己的 ledger，middleware 从不改写你的消息，并且对它添加的内容和它的压缩应用同样的规则。

```ts
// Vercel AI SDK
const model = withContextChef(baseModel, {
  appendOnly: true,
  contextWindow: 200_000,
  compress: { model: summarizerModel },
  onPrefixBreak: ({ sessionId, reason, at, strippedThinking }) => {
    console.info(`[${sessionId}] checkpoint (${reason}) at message ${at}`, { strippedThinking });
  },
});

await generateText({
  model,
  messages,
  providerOptions: { contextChef: { sessionId: conversationId } },
});
```

```ts
// TanStack AI：middleware 只创建一次，之后复用
const contextChef = contextChefMiddleware({
  appendOnly: true,
  contextWindow: 200_000,
  compress: { adapter: summarizerAdapter },
  onPrefixBreak: (event) => console.info(event),
});

const stream = chat({ adapter, messages, threadId: conversationId, middleware: [contextChef] });
```

- **每个对话一个 session。** AI SDK 传 `providerOptions.contextChef.sessionId`，TanStack AI 传 `threadId`；TanStack AI 不传时每次 run 都会生成一个新的，于是每次 run 都从空白开始。共用一个 session 的多个对话，每次调用都会互相改写对方的 history。同一个 session 里的调用逐个执行：一次调用会等上一次调用的 compile 结束，摘要也算在内，所以卡住的摘要模型会卡住它所在的 session。在排队时被 abort 的调用会立刻退出队列。千万不要让摘要模型再经过同一个 middleware 和同一个 session（比如把套了中间件的模型当作 AI SDK 的 `compress.model`，或者 `compressionModel` 里调用了套了中间件的模型）：它的调用会排在正等着它出摘要的那次调用后面，两边都不会返回。
- **session 存在 middleware 实例里。** 只创建一次，之后复用。每个请求新建一个的话，每个 session 都从空白开始，每次调用都是一次 `ledger` 检查点。进程重启、或者超过 `maxSessions`（默认 256）被淘汰，各算一次。每个 session 会保留它最后一次 compile 的 history。
- **事件都是 user 消息。** middleware 不知道背后是哪个 provider，而 provider SDK 可能把对话中间的 system 消息挪进 system prompt。所以无论哪种 placement，`dynamicState` 都是一条 user 消息，`clearAt` 被忽略（会 warn）。
- **压缩只落地一次**，时机和 chef 一样。`onCompress` 只在你的存储需要比进程活得久时才需要：把 `details.replacement`（你自己的消息格式）原样写回 `compressedMessages` 的位置，做法和[上面](#持久化对话)一样。
- **随对话移动的设置**（`compact.reasoning: 'before-last-message'`、`'before-last-…'` 形式的 `compact.toolCalls`、带 `keepRecent` 的 `clear`）会改写之前调用发过的消息，几乎每次调用都是检查点。压缩落地之后，这类改写一旦碰到被摘要的消息，还会让摘要失效，于是每次调用都要重新摘要一遍。创建 middleware 时会对它们 warn。改用 `'all'`，它在每条消息第一次发出之前就改写好；或者用 provider 自己的 context editing。
- `clear` 在压缩之前运行，所以摘要模型看到的是占位符。
- **`transformContext` 在 session 记录请求之后运行。** 它添加或改动的内容，每次调用都必须完全一样、位置也一样。否则在之前调用上签名的推理，会被放到一个不同的前缀后面回放，而且没有任何报告。每次调用都会变的内容请放进 `dynamicState`。创建 middleware 时会对此 warn。
- **检查点只剥 Anthropic 系签名的推理**：经 `@ai-sdk/anthropic` 或 `@ai-sdk/amazon-bedrock` 签名的 reasoning part，以及带签名的 TanStack thinking 块（`@tanstack/ai-anthropic`）。只剩推理的回复会整条去掉。其他 provider 的推理保留，检查点只报告。
- **什么算变化。** system prompt 按文本比较，tools 按真正发给模型的内容比较；缓存断点挪到它们身上不算变化。一次调用换了一组工具（`activeTools`、`prepareStep`）就是一次 `tools` 检查点。消息按 ContextChef 自己的消息格式比较（文本、tool call、推理文本、附件的媒体类型）：只改了 provider 元数据、内联的 provider 端执行的工具结果，或者文件的字节，都检测不到。
- **`onPrefixBreak`** 收到 `{ sessionId, reason, at, signed, strippedThinking }`。`at` 是这次调用消息里的下标，AI SDK 下从 system 消息之后算起。
- **这里没有签名压缩。** middleware 无法渲染 provider 自己的请求，所以 `onDemandCompaction` 总是运行它的 fallback。
- **持久化压缩。** `compactModelMessages`、`compactTanStackMessages` 和对应的 `planCompaction…` 都接受 `keptReasoning: 'strip'`。你自己写的摘要是一个没人签名的检查点，保留在它后面的推理就无法再通过验证；`'strip'` 返回一个可以直接发送的 history。

### TanStack AI 的细节

- 工作发生在每次模型调用的 `onConfig` 触发里（`beforeModel`、`structuredOutput`）；`init` 原样放行。`getState` 和 `transformContext` 也只在那里运行。
- 在一次 `chat()` run 里，引擎会把 `onConfig` 返回的内容带进下一轮迭代，middleware 再把它读回来，当作你的对话加上之后新增的内容。其他 middleware 不能修改它返回的消息（复制没问题）。如果你自己调用 middleware 的 hook，每次 run 只用一个 context 对象：每次触发都新建一个，会被当成新的 run，事件会重复。
- 持久化客户端的对话，而不是引擎的消息。引擎的消息里有 chef 的事件；在之后的 run 里发回来，同一个事件会发两次，而且没有任何检查点报告它。
- 结构化输出那次调用不带 tools 发出。在带 tools 的 run 里，它因此是一次性的：不算这个对话的检查点，也不带对话里任何签名过的 thinking。在不带 tools 的 run 里，它就是这次 run 的一次普通模型调用：会被保留，超预算时照常压缩，用量也计入。ledger 没有保留的请求（这样的一次性调用，或者某次触发失败后按引擎原样发出的请求），它的回复是在一个对话从未有过的前缀上签名的：这个回复里签名过的 thinking 永远不会回放，它的用量也不计入。
- 截断每次调用都会在你的对话上重新执行一遍。每次结果都一样，所以请求保持稳定，但超长的结果每次调用都会重新写入一次 offload 存储。

## 局限

- **还没在真实 API 上跑过。** 上面的行为都在本地按文档规则测试过。有些问题必须发真实请求才能回答，比如 Anthropic 是否接受最后一轮丢了 thinking 的工具循环，或者各个 AI SDK provider 怎样发送紧跟在工具结果后面的 user 事件。它们列在 [TODO.md](https://github.com/MyPrototypeWhat/context-chef/blob/main/TODO.md) 的 "Needs an API key" 下。
- **请求仍可能超过原始上下文窗口**：摘要模型放弃时（没什么可压缩的，或单独一轮就比窗口还大）；`onDemandCompaction` 没有 fallback、签名尝试又失败时；压缩本身失败时。熔断器打开后只拦下放得下的请求：超过原始窗口的请求每次 compile 都会再试一次，所以一直失败的摘要模型每次都会被调用。
- **旧修订占 token。** 不打开 `clearAt` 时，频繁变化的状态会把每个修订都留在窗口里，直到被压缩吸收，所以压缩会来得更早。让状态保持粗粒度，或者让模型通过工具自己拉取。预算也仍然会计入已经被 `clear_at` 清除的提醒。
- **新建的 chef 遇到 few-shot 示例**（问题之前就有的 assistant 回复）时，第一次 compile 会报告一次 `ledger` 检查点。它不会 warn：这些示例没有可丢的 thinking。末尾的 prefill 不算回复。
- **slot handler 可以改写窗口。** `after-assemble` handler（已废弃的 `transformContext` 选项也是其中之一）和 `after-adapt` handler 在 ledger 之后运行：`pipelineChecks` 会报告它们的改写，但无法阻止。`onBeforeCompile` 或 `before-assemble` handler 注入的内容是 implicit context 事件，变化时才追加。
- 如果某个请求必须在你修好原因之前发出去，[`drop_block` 安全网](/zh/guide/thinking-prefix#安全网-drop-block)仍然可用。
