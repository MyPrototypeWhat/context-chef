---
layout: home

hero:
  name: ContextChef
  text: TypeScript/JavaScript AI Agent 的上下文编译器
  tagline: 把无界的信息编译进有界的窗口 —— 五条轴、一份 payload、OpenAI / Anthropic / Gemini，且不接管你的控制流。
  image:
    src: https://github.com/MyPrototypeWhat/context-chef/releases/download/media-assets/ContextChef.gif
    alt: ContextChef 演示
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 五条轴
      link: /zh/guide/architecture
    - theme: alt
      text: 迁移到 v4
      link: /zh/migration/v4
    - theme: alt
      text: GitHub
      link: https://github.com/MyPrototypeWhat/context-chef

features:
  - icon: 🗜️
    title: ① 选择 —— 什么进入窗口
    details: 溢出策略限界对话（summarize、anchored、server、reset、chain、background）；Pruner 限界工具列表；selector 限界记忆。
    link: /zh/guide/history-compression
  - icon: 🧭
    title: ② 位置 —— 它落在窗口的哪里
    details: 一段可缓存的稳定前缀 + 一段易变的 tail。记忆、动态状态、skill 和 announcements 各自选边站，cacheAudit 会在你选错时告诉你。
    link: /zh/guide/architecture
  - icon: 💾
    title: ③ 持久化 —— 它在窗口之外住哪
    details: memory/、notes/、vfs/、archive/ 背后是同一个上下文存储 —— 一个 StorageBackend，一套 context:// 地址。
    link: /zh/guide/context-store
  - icon: 🔎
    title: ④ 取回 —— 模型如何伸手拿回来
    details: 一个 context 工具、七个命令，外加 new_context，全部经由 chef.ownsTool 与 chef.handleTool 分发。
    link: /zh/guide/context-store
  - icon: 🔀
    title: ⑤ 适配 —— provider 的线上格式
    details: 同一份编译好的状态变成 OpenAI / Anthropic / Gemini 的 payload，prefill、cache 断点和 tool call 形状都替你适配好。
    link: /zh/guide/adapters
  - icon: 📌
    title: 约束固定
    details: "pinned: true 的消息原文穿过每一种溢出策略，且永不被 compact() 清除 —— 策略文本不会丢。"
  - icon: ♻️
    title: 可逆归档 + 召回
    details: 策略驱逐掉的一切都会被存储并以 URI 引用，精确细节始终可取回，而不是靠猜。
  - icon: 🤝
    title: Handoff 预算
    details: 在触发线之上预留的 token，为模型买下一轮时间，把重要的东西写进 notes/ 或 memory/，然后窗口才被裁掉。
  - icon: ☁️
    title: 服务端上下文管理
    details: server() 策略把 LLM 压缩交给 Anthropic 的 compaction，并用客户端 fallback 让同一份配置可跨 provider 复用。
  - icon: 🧩
    title: Slot
    details: 编译管道上的六个组合点 —— 否决 overflow、注入 RAG 结果、改写装配好的消息、观察最终 payload。
  - icon: 💿
    title: 持久化压缩
    details: planCompaction / compactHistory（以及 AI SDK 和 TanStack 移植版）把你的存储压缩一次并持久化结果。
  - icon: 🚦
    title: 运行时工具闸门
    details: Pruner blocklist + checkToolCall，覆盖权限、环境、限流、沙箱等场景；默认 KV-cache 友好。
  - icon: 🎯
    title: 动态状态注入
    details: Zod schema 强类型状态注入，每次调用前强制对齐当前任务焦点。
  - icon: 🛡️
    title: 输出护栏
    details: withGuardrails 强制 XML 输出契约并设置 assistant prefill，在不支持原生 prefill 的 provider 上自动降级。
  - icon: ⏪
    title: 快照与恢复
    details: 一键捕获和回滚全部上下文状态 —— 历史、记忆、策略状态、窗口谱系 —— 支持分支探索与错误恢复。
  - icon: 📊
    title: 可观测性
    details: 统一事件系统 —— chef.on('compress', ...) —— 外加可选的管道不变量检查，上报被丢掉的固定消息和被拆开的 tool 配对。
  - icon: 🎭
    title: Skill
    details: Skill 原语按阶段打包指令 + 工具注解，支持从 SKILL.md 文件加载（与 Claude Code / Mastra / OpenCode 同格式）。
---
