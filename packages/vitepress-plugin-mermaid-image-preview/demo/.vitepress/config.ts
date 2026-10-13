import { defineConfig } from 'vitepress';
import { mermaidPreview } from '../../src/index.ts';

export default defineConfig({
  vite: { ssr: { noExternal: ['vitepress-plugin-mermaid-image-preview'] } },
  title: 'Iris · Mermaid 与图片预览',
  markdown: {
    config(md) {
      md.use(mermaidPreview);
    },
  },
  themeConfig: { nav: [{ text: '下一页', link: '/second' }] },
});
