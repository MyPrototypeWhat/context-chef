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

- [ ] **B2. 公共 API 导出补全**
  - 当前只导出了 `ContextChef`、`GovernanceOptions`、`ToolDefinition`、`Prompts`
  - 缺失导出：
    - 五大模块：`Stitcher`, `Pointer`, `Janitor`, `Governor`, `Pruner`
    - 核心类型：`Message`, `Role`, `ToolCall`, `TargetPayload`, `CompileOptions`, `TargetProvider`
    - 配置类型：`ChefConfig`, `VFSConfig`, `JanitorConfig`, `PrunerConfig`
    - 工具类：`XmlGenerator`, `TokenUtils`
    - Adapter：`AdapterFactory`, `ITargetAdapter`
  - 文件：`src/index.ts`

- [ ] **B3. TargetPayload 类型过于宽松**
  - 当前定义为 `messages: any[]`，完全丧失类型安全
  - AnthropicAdapter 还通过 `as TargetPayload` 强转挂了一个 `system` 属性
  - 方案：为每个 provider 定义独立的 payload 类型，通过泛型或联合类型让 `compile()` 返回正确类型
  - 文件：`src/types/index.ts`, `src/adapters/*.ts`

- [ ] **B4. compile() 返回值不包含 tools**
  - 设计方案要求编译后的 payload 同时包含 messages 和 tools
  - 当前 Pruner 完全独立，用户需要手动拼装
  - 考虑在 `TargetPayload` 中加入可选的 `tools` 字段，compile 时自动注入 Pruner 结果
  - 文件：`src/types/index.ts`, `src/index.ts`

- [x] ~~**B5. Pointer 仅支持 Node.js**~~ ❌ (按讨论暂不考虑)
  - 依赖 `fs`、`path`、`crypto`，在浏览器/Edge 环境直接报错
  - 设计方案开头写着"专为前端和 Node.js 生态设计"
  - 方案：暂时放弃浏览器支持，将其作为 Node.js 库处理。

- [ ] **B6. 运行一次 tsc 构建验证**
  - 所有测试都通过 ts-jest 即时编译运行
  - 从未验证 `tsc` 能否成功生成 `dist/` 产物
  - 可能存在隐藏的类型错误

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

- [ ] **E4. Janitor 的显式记忆 (Core Memory) 持久化**
  - **背景**：目前 Janitor 仅对历史对话（L2 -> L1）进行模糊压缩。
  - **方案**：借鉴 Letta，允许模型主动输出 `<update_core_memory>` 标签。Janitor 捕获该标签后，将其持久化到顶层的 `Static Base` (系统提示词) 中，使模型能够跨会话累积经验（如：记住项目代码规范）。

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

- [ ] **E8. `onBeforeCompile` 生命周期钩子 (beforeContextCreated)**
  - **背景**：Cursor 的 Dynamic Context Discovery 和 Augment 的 Context Engine 均证明，在 LLM 调用前零 round-trip 地注入语义相关上下文（代码片段、依赖图、文档摘要）能显著提升任务完成质量。当前 ContextChef 的 Dynamic State 完全依赖开发者显式传入，无法在编译阶段自动扩展上下文。
  - **方案**：在 `compile()` / `compileAsync()` 的最终组装阶段之前，提供一个 `onBeforeCompile(context => { ... })` 异步钩子。开发者可在此回调中执行任意外部操作（RAG 向量检索、AST 分析、MCP 查询、Augment Context Engine 调用等），并返回需要注入的额外内容。ContextChef 将返回值自动编排到三明治模型的正确位置（如 Dynamic State 层的 `<implicit_context>` 标签内），保持 KV-Cache 稳定性不受影响。库本身不承担任何检索逻辑，只提供注入点。

---

## 优先级建议

| 优先级 | 项目                       | 理由                                   |
| :----: | :------------------------- | :------------------------------------- |
| ~~P0~~ | ~~B1 (Zod 依赖)~~            | ✅ 已确认               |
|   P0   | B6 (tsc 构建)              | 验证性工作，不做就不知道有没有隐藏炸弹 |
| ~~P1~~ | ~~A1 (Gemini)~~            | ✅ 已完成                              |
| ~~P1~~ | ~~A2 (Anthropic prefill)~~ | ✅ 已确认正确                          |
|   P1   | B2 (导出补全)              | 不补的话库无法被正常引用               |
| ~~P2~~ | ~~A3 (死代码清理)~~        | ✅ 已完成                              |
|   P2   | B3 (类型安全)              | 提升开发体验                           |
|   P2   | C1-C3 (测试)               | 补齐覆盖率                             |
|   P3   | B4 (tools 输出)            | API 设计优化                           |
| ~~P3~~ | ~~B5 (浏览器支持)~~        | ❌ 按讨论暂不考虑                       |
|   P3   | D1-D2 (文档)               | 面向发布                               |
|   P4   | E1-E8 (架构演进)           | Phase 4 / Phase 5 核心特性规划         |
