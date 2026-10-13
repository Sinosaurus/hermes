import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: { index: 'src/index.ts', theme: 'src/theme/index.ts' },
      formats: ['es'],
      cssFileName: 'style',
    },
    rolldownOptions: {
      external: ['vue', 'vitepress', 'mermaid'],
    },
  },
});
