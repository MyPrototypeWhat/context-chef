import { defineConfig } from 'vitepress';

const GITHUB_URL = 'https://github.com/MyPrototypeWhat/context-chef';

function guideSidebar(
  prefix: string,
  labels: {
    guide: string;
    gettingStarted: string;
    concepts: string;
    architecture: string;
    overflow: string;
    durableCompaction: string;
    serverSide: string;
    contextStore: string;
    memory: string;
    offloading: string;
    toolManagement: string;
    skills: string;
    guardrail: string;
    snapshotRestore: string;
    eventsHooks: string;
    adapters: string;
  },
) {
  return [
    {
      text: labels.guide,
      items: [{ text: labels.gettingStarted, link: `${prefix}/guide/getting-started` }],
    },
    {
      text: labels.concepts,
      items: [
        { text: labels.architecture, link: `${prefix}/guide/architecture` },
        { text: labels.overflow, link: `${prefix}/guide/history-compression` },
        { text: labels.durableCompaction, link: `${prefix}/guide/durable-compaction` },
        { text: labels.serverSide, link: `${prefix}/guide/server-side-context-management` },
        { text: labels.contextStore, link: `${prefix}/guide/context-store` },
        { text: labels.memory, link: `${prefix}/guide/memory` },
        { text: labels.offloading, link: `${prefix}/guide/offloading-vfs` },
        { text: labels.toolManagement, link: `${prefix}/guide/tool-management` },
        { text: labels.skills, link: `${prefix}/guide/skills` },
        { text: labels.guardrail, link: `${prefix}/guide/guardrail` },
        { text: labels.snapshotRestore, link: `${prefix}/guide/snapshot-restore` },
        { text: labels.eventsHooks, link: `${prefix}/guide/events-hooks` },
        { text: labels.adapters, link: `${prefix}/guide/adapters` },
      ],
    },
  ];
}

function packagesSidebar(prefix: string, heading: string) {
  return [
    {
      text: heading,
      items: [
        { text: '@context-chef/core', link: `${prefix}/packages/core` },
        { text: '@context-chef/ai-sdk-middleware', link: `${prefix}/packages/ai-sdk-middleware` },
        { text: '@context-chef/tanstack-ai', link: `${prefix}/packages/tanstack-ai` },
      ],
    },
  ];
}

export default defineConfig({
  title: 'ContextChef',
  base: '/context-chef/',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/context-chef/logo.svg' }]],
  lastUpdated: true,

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      description: 'Context compiler for TypeScript/JavaScript AI agents',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
          { text: 'Packages', link: '/packages/core', activeMatch: '/packages/' },
          { text: 'Migration', link: '/migration/v4', activeMatch: '/migration/' },
          { text: 'Examples', link: '/examples/', activeMatch: '/examples/' },
        ],
        sidebar: {
          '/guide/': guideSidebar('', {
            guide: 'Guide',
            gettingStarted: 'Getting Started',
            concepts: 'Core Concepts',
            architecture: 'Architecture — the five axes',
            overflow: 'Overflow (history)',
            durableCompaction: 'Durable Compaction',
            serverSide: 'Server-Side Context Management',
            contextStore: 'Context Store',
            memory: 'Memory',
            offloading: 'Offloading & VFS',
            toolManagement: 'Tool Management (Pruner)',
            skills: 'Skills',
            guardrail: 'Guardrail',
            snapshotRestore: 'Snapshot & Restore',
            eventsHooks: 'Events & Hooks',
            adapters: 'Adapters',
          }),
          '/packages/': packagesSidebar('', 'Packages'),
          '/migration/': [
            { text: 'Migration', items: [{ text: 'Migrating to v4', link: '/migration/v4' }] },
          ],
          '/examples/': [{ text: 'Examples', items: [{ text: 'Overview', link: '/examples/' }] }],
        },
        editLink: {
          pattern: `${GITHUB_URL}/edit/main/docs-site/:path`,
          text: 'Edit this page on GitHub',
        },
        outline: { level: [2, 3] },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      description: 'TypeScript/JavaScript AI Agent 的上下文编译器',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started', activeMatch: '/zh/guide/' },
          { text: '包', link: '/zh/packages/core', activeMatch: '/zh/packages/' },
          { text: '迁移', link: '/zh/migration/v4', activeMatch: '/zh/migration/' },
          { text: '示例', link: '/zh/examples/', activeMatch: '/zh/examples/' },
        ],
        sidebar: {
          '/zh/guide/': guideSidebar('/zh', {
            guide: '指南',
            gettingStarted: '快速开始',
            concepts: '核心概念',
            architecture: '架构 —— 五条轴',
            overflow: '溢出（历史）',
            durableCompaction: '持久化压缩',
            serverSide: '服务端上下文管理',
            contextStore: '上下文存储',
            memory: '记忆（Memory）',
            offloading: '卸载与 VFS',
            toolManagement: '工具管理（Pruner）',
            skills: 'Skill',
            guardrail: '护栏（Guardrail）',
            snapshotRestore: '快照与恢复',
            eventsHooks: '事件与钩子',
            adapters: '适配器',
          }),
          '/zh/packages/': packagesSidebar('/zh', '包'),
          '/zh/migration/': [
            { text: '迁移', items: [{ text: '迁移到 v4', link: '/zh/migration/v4' }] },
          ],
          '/zh/examples/': [{ text: '示例', items: [{ text: '总览', link: '/zh/examples/' }] }],
        },
        editLink: {
          pattern: `${GITHUB_URL}/edit/main/docs-site/:path`,
          text: '在 GitHub 上编辑此页',
        },
        outline: { level: [2, 3], label: '页面导航' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdatedText: '最后更新于',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        langMenuLabel: '切换语言',
      },
    },
  },

  themeConfig: {
    logo: '/logo.svg',
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '无法找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: GITHUB_URL }],
  },
});
