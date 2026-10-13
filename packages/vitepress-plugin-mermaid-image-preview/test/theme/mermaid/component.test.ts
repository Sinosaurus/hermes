// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import type { App } from 'vue';
import { useData } from 'vitepress';
import MermaidDiagram from '../../../src/theme/mermaid/MermaidDiagram.vue';

const rendering = vi.hoisted(() => ({ renderDiagram: vi.fn() }));
vi.mock('../../../src/theme/mermaid/render', async (original) => ({
  ...(await original<typeof import('../../../src/theme/mermaid/render')>()),
  renderDiagram: rendering.renderDiagram,
}));
vi.mock('vitepress', async () => {
  const { ref } = await import('vue');
  const data = { isDark: ref(false) };
  return { useData: () => data };
});

let app: App;
const graph = ref('');
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  useData().isDark.value = false;
  rendering.renderDiagram.mockReset();
  graph.value = encodeURIComponent('flowchart LR; A-->B');
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = '';
});
function mount() {
  app = createApp({ render: () => h(MermaidDiagram, { graph: graph.value }) });
  app.mount(document.getElementById('app')!);
}

test('diagram source is decoded and dark mode triggers a new render', async () => {
  rendering.renderDiagram.mockResolvedValue(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"/>',
  );
  mount();
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  expect(rendering.renderDiagram).toHaveBeenCalledWith(
    expect.any(String),
    'flowchart LR; A-->B',
    false,
  );
  useData().isDark.value = true;
  await nextTick();
  expect(rendering.renderDiagram).toHaveBeenLastCalledWith(
    expect.any(String),
    'flowchart LR; A-->B',
    true,
  );
});

test('render errors keep the source visible and a later valid diagram recovers', async () => {
  rendering.renderDiagram.mockRejectedValueOnce(new Error('bad syntax'));
  mount();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('bad syntax'),
  );
  expect(document.querySelector('code')!.textContent).toBe('flowchart LR; A-->B');
  rendering.renderDiagram.mockResolvedValue(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"/>',
  );
  graph.value = encodeURIComponent('flowchart LR; A-->C');
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('stale async render results cannot replace a newer diagram', async () => {
  let complete!: (svg: string) => void;
  rendering.renderDiagram.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  rendering.renderDiagram.mockResolvedValue(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"/>',
  );
  mount();
  graph.value = encodeURIComponent('flowchart LR; New-->Diagram');
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  const source = document.querySelector('img')!.src;
  complete('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  await nextTick();
  expect(document.querySelector('img')!.src).toBe(source);
});
