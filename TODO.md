# ContextChef TODO

## A. 功能性缺陷（会导致错误输出）

- [ ] **A1. GeminiAdapter 补完**
  - `system` 角色应映射到 Gemini 的 `systemInstruction` 字段，而非强制转为 `user`
  - `tool` 角色的消息需要正确映射为 Gemini 的 `functionCall` / `functionResponse` 格式
  - `_cache_breakpoint` 需要决定在 Gemini 上的行为（Gemini 目前不支持 prompt caching，可以静默忽略）
  - Prefill 降级逻辑需要与 OpenAI 对齐（Gemini 同样不支持尾部 assistant 消息）
  - 文件：`src/adapters/GeminiAdapter.ts`

- [ ] **A2. AnthropicAdapter 保留 prefill**
  - Anthropic 原生支持尾部 `assistant` 消息来触发预填充
  - 当前实现把 `assistant` prefill 当普通消息处理，没有保留在末尾的特殊逻辑
  - 需要确保尾部 `assistant` 消息在 Anthropic 编译时被正确保留
  - 文件：`src/adapters/AnthropicAdapter.ts`

- [ ] **A3. `useRollingHistory` options 参数是死代码**
  - `windowSize` 和 `strategy` 被接口声明但从未使用
  - 方法体内有 `// TODO: integrate Janitor compression logic here`
  - 决策：要么实现这些参数的逻辑，要么从签名中移除
  - 文件：`src/index.ts` L56

---

## B. 工程性缺陷（技术债）

- [ ] **B1. Zod 从 devDependencies 移到 dependencies**
  - `src/index.ts` 在运行时依赖 Zod，但 `package.json` 把它列为 devDependency
  - 用户 `npm install context-engineer` 后运行会因缺少 Zod 崩溃
  - 文件：`package.json`

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

- [ ] **B5. Pointer 仅支持 Node.js**
  - 依赖 `fs`、`path`、`crypto`，在浏览器/Edge 环境直接报错
  - 设计方案开头写着"专为前端和 Node.js 生态设计"
  - 方案：抽象存储层接口，提供 Node 和 Browser（localStorage / IndexedDB）两套实现
  - 文件：`src/modules/Pointer.ts`

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

- [ ] **C2. GeminiAdapter 测试**
  - 当前只有 OpenAI 和 Anthropic 的集成测试
  - A1 补完后需要同步补测试
  - 文件：`tests/index.test.ts` 或新建 `tests/adapters.test.ts`

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

## 优先级建议

| 优先级 | 项目 | 理由 |
|:---:|:---|:---|
| P0 | B1 (Zod 依赖) | 一行改动，不改就崩 |
| P0 | B6 (tsc 构建) | 验证性工作，不做就不知道有没有隐藏炸弹 |
| P1 | A1 (Gemini) | 三大 Adapter 之一是空壳，对外宣称支持但实际会出错 |
| P1 | A2 (Anthropic prefill) | Anthropic 是预填充的原生支持者，不保留等于浪费了核心卖点 |
| P1 | B2 (导出补全) | 不补的话库无法被正常引用 |
| P2 | A3 (死代码清理) | 代码卫生 |
| P2 | B3 (类型安全) | 提升开发体验 |
| P2 | C1-C3 (测试) | 补齐覆盖率 |
| P3 | B4 (tools 输出) | API 设计优化 |
| P3 | B5 (浏览器支持) | 扩展运行环境 |
| P3 | D1-D2 (文档) | 面向发布 |
