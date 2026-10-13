<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue';
import { useData } from 'vitepress';
import { renderDiagram, svgImage } from './render';

const props = defineProps<{ graph: string }>();
const { isDark } = useData();
const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
const src = ref('');
const error = ref('');
const graph = computed(() => {
  try {
    return decodeURIComponent(props.graph);
  } catch {
    return props.graph;
  }
});

onMounted(() => {
  let revision = 0;
  watch(
    [graph, isDark],
    async (_, __, onCleanup) => {
      const current = ++revision;
      let active = true;
      onCleanup(() => {
        active = false;
      });
      try {
        const svg = await renderDiagram(`${id}-${current}`, graph.value, isDark.value);
        if (!active) return;
        src.value = svgImage(svg);
        error.value = '';
      } catch (cause) {
        if (!active) return;
        src.value = '';
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    },
    { immediate: true },
  );
});
</script>

<template>
  <figure class="iris-mermaid">
    <img v-if="src" :src="src" alt="Mermaid 流程图" />
    <template v-else>
      <p v-if="error" role="alert">Mermaid 渲染失败：{{ error }}</p>
      <pre><code>{{ graph }}</code></pre>
    </template>
  </figure>
</template>

<style scoped>
.iris-mermaid {
  margin: 24px 0;
}
.iris-mermaid img {
  display: block;
  margin: auto;
  max-width: 100%;
}
</style>
