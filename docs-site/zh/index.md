---
layout: home

hero:
  name: ContextChef
  text: TypeScript/JavaScript AI Agent 的上下文编译器
  tagline: 压缩历史、裁剪工具、持久化记忆，把同一套状态编译到 OpenAI / Anthropic / Gemini —— 不接管你的控制流。
  image:
    src: https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif
    alt: ContextChef 演示
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 迁移到 v4
      link: /zh/migration/v4
    - theme: alt
      text: GitHub
      link: https://github.com/MyPrototypeWhat/context-chef

features:
  - icon: 🗜️
    title: 历史压缩
    details: 自动压缩历史消息，保留近期记忆，老对话交给小模型摘要。
  - icon: 📌
    title: 约束固定
    details: "pinned: true 的消息原文穿过压缩，且永不被 compact() 清除 —— 策略文本不会丢。"
  - icon: ♻️
    title: 可逆归档 + 召回
    details: 压缩前的完整片段会被存储并在摘要中以 URI 引用；recall_context 工具可按需还原精确细节。
  - icon: ☁️
    title: 服务端上下文管理
    details: 把 LLM 压缩交给 Anthropic 服务端 compaction，裁剪 / skills / 记忆 / VFS 仍留在客户端。
  - icon: 💾
    title: 持久化压缩
    details: planCompaction / compactHistory（以及 AI SDK 和 TanStack 移植版）把你的存储压缩一次并持久化结果。
  - icon: 🧰
    title: 工具裁剪
    details: 按任务动态裁剪工具列表，或用双层架构（稳定分组 + 按需加载）彻底消除工具幻觉。
  - icon: 🚦
    title: 运行时工具闸门
    details: Pruner blocklist + checkToolCall，覆盖权限、环境、限流、沙箱等场景；默认 KV-cache 友好。
  - icon: 🔀
    title: 多 Provider 编译
    details: 同一套 prompt 编译到 OpenAI / Anthropic / Gemini，prefill、cache、tool call 格式自动适配。
  - icon: 🎯
    title: 动态状态注入
    details: Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点。
  - icon: 🛡️
    title: 输出护栏
    details: withGuardrails 强制 XML 输出契约并设置 assistant prefill，在不支持原生 prefill 的 provider 上自动降级。
  - icon: 📦
    title: VFS 卸载
    details: 自动截断超大工具输出并卸载到虚拟文件系统，保留错误行 + context:// URI 指针供按需取回。
  - icon: 🧠
    title: 跨会话记忆
    details: 模型通过 tool call 主动持久化关键信息（项目规范、用户偏好），下次会话自动注入。
  - icon: ⏪
    title: 快照与恢复
    details: 一键捕获和回滚全部上下文状态，支持分支探索与错误恢复。
  - icon: 🪝
    title: 外部上下文钩子
    details: onBeforeCompile 让你在编译前注入 RAG 检索结果、AST 片段或 MCP 查询。
  - icon: 📊
    title: 可观测性
    details: 统一事件系统 —— chef.on('compress', ...) 一个入口订阅所有内部模块的日志、指标和调试信息。
  - icon: 🎭
    title: Skill
    details: Skill 原语按阶段打包指令 + 工具注解，支持从 SKILL.md 文件加载（与 Claude Code / Mastra / OpenCode 同格式）。
---
