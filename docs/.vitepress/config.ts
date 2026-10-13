// 文件职责：VitePress 中文文档站导航、侧栏与本地搜索配置。
import { defineConfig } from 'vitepress';
import { mermaidPreview } from 'vitepress-plugin-mermaid-image-preview';

export default defineConfig({
  vite: {
    ssr: { noExternal: ['vitepress-plugin-mermaid-image-preview'] },
  },
  markdown: {
    config(md) {
      md.use(mermaidPreview);
    },
  },
  lang: 'zh-CN',
  title: 'Hermes',
  description: '@nova-cbb/hermes（nova-hm）：批量收集 npm 制品、恢复安装树、内网导入与 tag 管理',
  themeConfig: {
    nav: [
      { text: '使用', link: '/' },
      { text: '架构', link: '/architecture' },
      { text: '开发', link: '/development' },
    ],
    sidebar: [
      { text: '快速开始', link: '/' },
      { text: '实现架构与参数', link: '/architecture' },
      { text: '技术方案与操作手册', link: '/operations' },
      { text: '开发与校验', link: '/development' },
      { text: '文件职责', link: '/file-guide' },
    ],
    search: { provider: 'local' },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
  },
});
