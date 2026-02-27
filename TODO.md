# ContextChef TODO

## A. 功能性缺陷（会导致错误输出）

- [x] **A1. GeminiAdapter 补完** ✅
  - `system` → 顶层 `systemInstruction` 字段
  - `assistant` → `model` 角色
  - `tool_calls` → `functionCall` parts（支持并行）
  - `tool` 结果 → `functionResponse` parts（`role: "user"`）
  - `_cache_breakpoint` 静默忽略（Gemini 使用独立的 CachedContent API）
  - Prefill 降级与 OpenAI 对齐（尾部 model 消息 → 系统注入）
  - 13 个测试覆盖：`tests/GeminiAdapter.test.ts`

- [x] **A2. AnthropicAdapter 保留 prefill** ✅ (确认无需修改)
  - Anthropic 原生支持尾部 `assistant` 消息触发预填充
  - 当前实现已正确将 assistant 消息直接传递，无需特殊逻辑
  - OpenAI/Gemini 的降级逻辑正是因为它们不支持此特性

- [x] **A3. `useRollingHistory` options 参数已清理** ✅
  - 移除了未使用的 `_options?: { windowSize?: string; strategy?: string }` 参数
  - 移除了过时的 TODO 注释

---

## B. 工程性缺陷（技术债）

- [x] **B1. Zod 从 devDependencies 移到 dependencies** ✅
  - 经检查，`package.json` 中 `zod` 已位于 `dependencies` 内，无需修改。

- [x] **B2. 公共 API 导出补全** ✅
  - 五大模块、全部类型、工具类、Adapter 均已从 `src/index.ts` 导出。

- [x] **B3. TargetPayload 类型安全** ✅
  - `OpenAIPayload`、`AnthropicPayload`、`GeminiPayload` 均已对接各 SDK 原生类型。
  - `compile()` 已添加完整重载，按 target 返回对应强类型。

- [x] **B4. compile() 自动注入 tools** ✅
  - `compile()` 已自动合并 Pruner 结果，无需手动拼装。

- [x] ~~**B5. Pointer 仅支持 Node.js**~~ ❌ (按讨论暂不考虑)
  - 依赖 `fs`、`path`、`crypto`，在浏览器/Edge 环境直接报错
  - 设计方案开头写着"专为前端和 Node.js 生态设计"
  - 方案：通过引入 `VFSStorageAdapter`，现已支持传入自定义适配器（如 `IndexedDBAdapter`），从而解决浏览器兼容性问题。此问题已**转化并解决**。

- [x] **B6. tsc 构建验证** ✅
  - `tsc --noEmit` 零错误通过。

- [x] **B7. 统一 compile() 为异步，始终走 Janitor 压缩** ✅
  - 砍掉同步 `compile()`，将 `compileAsync()` 重命名为 `compile()`
  - 现在只有一个编译入口，始终走 Janitor 压缩
  - Janitor 内部提取了 `evaluateBudget()` 共享预算检查逻辑
  - 所有测试已适配 async/await

---

## C. 测试覆盖缺口

- [ ] **C1. Governor 独立单元测试**
  - 当前仅通过 `index.test.ts` 的集成路径间接覆盖
  - 需要覆盖：空 dynamicState + prefill、空 dynamicState + enforceXML、连续两次 applyGovernance
  - 新文件：`tests/Governor.test.ts`

- [x] **C2. GeminiAdapter 测试** ✅
  - 13 个测试覆盖：system 分离、角色映射、functionCall/functionResponse、并行调用、prefill 降级、cache_breakpoint 忽略、完整多轮对话
  - 文件：`tests/GeminiAdapter.test.ts`

- [ ] **C3. Janitor token-based 压缩测试**
  - `asyncFeatures.test.ts` 只测了 legacy 的 message count 模式（`maxHistoryLimit`）
  - `maxHistoryTokens` + `preserveRecentTokens` 路径完全未覆盖
  - 包括自定义 `tokenizer` 钩子的测试
  - 文件：`tests/asyncFeatures.test.ts`

---

## D. 文档/配置

- [x] **D1. README 补充 Pruner 文档** ✅
  - 已补充扁平模式 Pruner 用法示例

- [x] **D2. 设计方案 Phase 3 状态更新** ✅
  - 已更新为 Namespace + Lazy Loading 双层架构描述
  - API 示例已包含 `registerNamespaces` / `registerToolkits` / `compile()` / `resolveNamespace()` / `extractToolkit()`

- [ ] **D3. README 补充 Namespace + Lazy Loading 文档**
  - README 目前只包含扁平模式 Pruner 的 Best Practice
  - 需要补充双层架构的完整用法和 Agent Loop 集成示例
    - 文件：`README.md`

---

## E. 架构迭代与优化 (Phase 4 / Phase 5 规划)

根据前沿 Agent 平台（Cursor, Letta, Cline, Augment 等）的实践，规划以下架构演进方向：

- [ ] **E1. 引入 AST / Semantic Context Injector (雷达模块钩子)**
  - **背景**：Cursor/Augment 的核心在于"隐式上下文发现" (Dynamic Context Discovery)。当前 Dynamic State 需要显式传入，对于复杂代码库存在盲区。
  - **方案**：不在库内实现沉重的 AST 或 VectorDB 分析，而是提供一个类似 `onBeforeCompile(context => {...})` 的 Hook 或中间件 API，允许开发者在最终编译前，注入外部检索引擎计算出的 `<related_snippets>`，实现零耗时 (Zero round-trip) 的认知扩展。

- [ ] **E2. 原生 MCP (Model Context Protocol) 网关接入**
  - **背景**：Cline/Roo Code 等前沿工具已全线拥抱 MCP，而 ContextChef 当前工具配置仍为静态对象。
  - **方案**：将 Layer 2 (Lazy Loading Toolkits) 的概念与 MCP 融合。提供诸如 `chef.tools().registerMCPServer(client)` 的 API，让 `load_toolkit` 虚拟工具可以直接对接 MCP Server，实现能力的动态即插即用，同时保持核心库轻量（不内置 client，只提供注入点）。

- [ ] **E3. 全局状态的时间旅行 (Snapshot & Restore)**
  - **背景**：长程任务容易中途出错，IDE 插件 (如 Cline) 刚需 Undo/Redo 能力。
  - **方案**：暴露 `chef.snapshot()` 和 `chef.restore(state)` 方法，因为 ContextChef 内部维护了统一的 IR (中间表示)，可以轻易地实现 AI 记忆的回滚与重放。
  - **GCC 借鉴**：引入内置的 Milestone Snapshot Schema（类似 GCC 的 COMMIT），允许 Agent 在尝试复杂操作前自主通过 Tool 发起 `take_snapshot(reason)`，并在失败时调用 `revert_to_snapshot()`。这从被动的 IDE 级撤销，升级为了 Agent 自主的分支探索（Branching）。

- [ ] **E4. Janitor 的显式记忆 (Core Memory) 持久化**
  - **背景**：目前 Janitor 仅对历史对话（L2 -> L1）进行模糊压缩。
  - **方案**：借鉴 Letta，允许模型主动输出 `<update_core_memory>` 标签。Janitor 捕获该标签后，将其持久化到顶层的 `Static Base` (系统提示词) 中，使模型能够跨会话累积经验（如：记住项目代码规范）。
  - **GCC 借鉴**：记忆结构支持类似 GCC 的分层模式：`main.md`（高优全局记忆）与 `commit.md`（当前分支/任务进度记忆），通过不同权重的注入点进入三明治模型。

- [x] **E9. Janitor 双信号 Token 触发 (`feedTokenUsage`)** ✅
  - `chef.feedTokenUsage(n)` 已实现，三级 fallback 链完整
  - Janitor 压缩触发条件：`max(feedTokenUsage, 本地估算) > maxHistoryTokens`
  - 代码位于 `Janitor.ts:evaluateBudget()` 和 `index.ts:feedTokenUsage()`

- [x] **E10. Janitor 压缩冷却保护 (Suppress Next Compression)** ✅
  - `_suppressNextCompression` 已实现，压缩成功后自动设置
  - 下一次 `compress()` 跳过检查，防止连锁压缩
  - 代码位于 `Janitor.ts:evaluateBudget()` 和 `executeCompression()`

- [ ] **E5. 支持流式解析与对象重组 (Streaming Parser Integration)**
  - **背景**：Governor 采用 XML 约束包络（Envelope），传统解析需要等待闭合标签，导致极高的首字节体感延迟 (TTFB)，前沿应用极度依赖 Streaming。
  - **方案**：
    1. **解耦包络与负载**：由于开发者配置的 `outputTag` 是动态的（不仅限于 `<dynamic_state>` 或 `<thinking>`），我们需要一个泛型的底层 Stream Scanner 负责剥离外部的 XML 标签。
    2. **引入成熟流解析库**：在剥离出目标内容后，若是 JSON 负载，则无缝接入 `zod-stream` 或 `stream-json`，实现边接收边校验的强类型 Partial Object 抛出；若是纯 XML 负载，则接入 `htmlparser2` 等成熟的流式 XML 解析器。

- [ ] **E6. Reasoning Models (o1/o3-mini) 的 Adapter 专项优化**
  - **背景**：OpenAI 的 o1 系列模型自带内部思维链，且不支持某些 Assistant prefill，强加复杂的 `<thinking>` 引导（如 `prompts.ts` line 24）反而会导致模型性能下降。
  - **方案**：在 `AdapterFactory` 中为 o1/o3 建立特殊的适配逻辑，智能削减或剥离冗余的 XML Guardrails 引导提示，防止过度指令限制。

- [ ] **E7. VFS 指针解析的按需摘要 (Optional Summary)**
  - **背景**：Pointer 截断超大文件并返回 `context://...`，要求 LLM 主动再读，效率较低。
  - **方案**：在转储文件的瞬间，如果开发者配置了快速模型，允许触发一次异步的轻量 summary 操作。截断信息更新为 `[Summary: ... + context://...]`，避免模型盲人摸象。若未配置，则优雅降级为现有的简单截断。

- [x] **E8. `onBeforeCompile` 生命周期钩子 (beforeContextCreated)** ✅
  - `ChefConfig.onBeforeCompile` 异步钩子，接收 `BeforeCompileContext` 只读快照
  - 返回 string 自动包裹为 `<implicit_context>`，注入到 dynamic state 同一位置
  - 支持 `last_user` 和 `system` 两种 placement 模式
  - 返回 null/undefined 跳过注入；支持同步和异步回调
  - 7 个测试覆盖：`tests/onBeforeCompile.test.ts`

- [x] **E11. IR 支持 `thinking` 字段 + Adapter 映射（可选）** ✅
  - `Message` IR 新增 `thinking?: ThinkingContent` 和 `redacted_thinking?: RedactedThinking` 字段
  - AnthropicAdapter：映射为 `ThinkingBlockParam` / `RedactedThinkingBlockParam`，prepend 在 text block 之前
  - GeminiAdapter：`thinking` 和 `redacted_thinking` 均静默丢弃（`thought:true` 是响应输出字段，不可作为请求输入；多轮 thinking 回传依赖 SDK 管理的 `thoughtSignature`）
  - OpenAIAdapter：`thinking` / `redacted_thinking` 静默丢弃（Chat Completions 不支持）
  - 测试覆盖：`tests/thinking.test.ts`

- [x] **E12. MemoryStore 标准化接口 + 默认实现（InMemory/VFS）** ✅
  - `src/stores/MemoryStore.ts`：轻量 `MemoryStore` 接口（get/set/delete/keys，同步/异步均支持）
  - `src/stores/InMemoryStore.ts`：内存实现，用于测试和短生命周期场景
  - `src/stores/VFSMemoryStore.ts`：文件系统持久化，key 经 base64url 编码，跨进程重启可恢复
  - 测试覆盖：`tests/MemoryStore.test.ts`

---

## 优先级建议

| 优先级   | 项目                          | 理由                                  |
| :------: | :---------------------------- | :------------------------------------ |
| ~~P0~~   | ~~B1 (Zod 依赖)~~             | ✅ 已确认                             |
| ~~P0~~   | ~~B6 (tsc 构建)~~             | ✅ 零错误通过                         |
| ~~P1~~   | ~~A1 (Gemini)~~               | ✅ 已完成                             |
| ~~P1~~   | ~~A2 (Anthropic prefill)~~    | ✅ 已确认正确                         |
| ~~P1~~   | ~~B2 (导出补全)~~             | ✅ 已完成                             |
| ~~P2~~   | ~~A3 (死代码清理)~~           | ✅ 已完成                             |
| ~~P2~~   | ~~B3 (类型安全)~~             | ✅ 已完成                             |
| ~~P3~~   | ~~B4 (tools 输出)~~           | ✅ 已完成                             |
| ~~P3~~   | ~~B5 (浏览器支持)~~           | ✅ 通过 VFSStorageAdapter 抽象已解决  |
| ~~P2~~   | ~~B7 (compile 统一异步)~~     | ✅ 砍掉同步路径，统一为 async compile |
| ~~P3~~   | ~~E9 (feedTokenUsage)~~       | ✅ 已实现                             |
| ~~P3~~   | ~~E10 (压缩冷却保护)~~        | ✅ 已实现                             |
| P2       | C1/C3 (测试)                  | 暂缓，功能稳定后补齐                  |
| P3       | D3 (README Namespace 文档)    | 面向发布，README 仅有扁平模式文档     |
| ~~P4~~   | ~~E8, E11, E12 (架构演进)~~   | ✅ 已完成                             |
| P4       | E1-E7 (架构演进)              | Phase 5 核心特性规划                  |
