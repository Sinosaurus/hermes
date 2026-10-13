import { defineComponent, h } from 'vue';
import type { Theme } from 'vitepress';
import MermaidDiagram from './mermaid/MermaidDiagram.vue';
import MediaPreview from './preview/MediaPreview.vue';

export { MermaidDiagram, MediaPreview };

/** Keeps the base theme's hooks and slots; adds one shared preview dialog. */
export function withIrisTheme(base: Theme, options: { selector?: string } = {}): Theme {
  return {
    extends: base,
    enhanceApp({ app }) {
      app.component('IrisMermaid', MermaidDiagram);
    },
    Layout: defineComponent({
      name: 'IrisLayout',
      setup(_, { attrs, slots }) {
        return () => [h(base.Layout!, attrs, slots), h(MediaPreview, options)];
      },
    }),
  };
}
