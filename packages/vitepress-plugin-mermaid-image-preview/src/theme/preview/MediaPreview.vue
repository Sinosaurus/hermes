<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vitepress';
import { gesture, zoomAt } from './transform';

const props = withDefaults(defineProps<{ selector?: string }>(), {
  selector: '.vp-doc img, .iris-mermaid img',
});
const route = useRoute();
const dialog = ref<HTMLDialogElement>();
const stage = ref<HTMLDivElement>();
const src = ref('');
const label = ref('');
const failed = ref(false);
const view = ref({ scale: 1, x: 0, y: 0 });
const dragging = ref(false);
const transform = computed(
  () => `translate(${view.value.x}px, ${view.value.y}px) scale(${view.value.scale})`,
);
const pointers = new Map<number, { x: number; y: number }>();
const enhanced = new Map<HTMLElement, Map<string, string | null>>();
let previousFocus: HTMLElement | null = null;
let observer: MutationObserver | undefined;
let oldOverflow: string | undefined;

function reset() {
  view.value = { scale: 1, x: 0, y: 0 };
}
function zoom(factor: number) {
  view.value = zoomAt(view.value, factor);
}
function open(image: HTMLImageElement) {
  if (!dialog.value || dialog.value.open) return;
  previousFocus = image.closest('a') || image;
  src.value = image.currentSrc || image.src;
  label.value = image.alt || '图片预览';
  failed.value = false;
  reset();
  dialog.value.showModal();
  oldOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
}
function closed() {
  if (oldOverflow !== undefined) {
    document.documentElement.style.overflow = oldOverflow;
    oldOverflow = undefined;
  }
  pointers.clear();
  dragging.value = false;
  previousFocus?.focus({ preventScroll: true });
  src.value = '';
}
function close() {
  if (!dialog.value?.open) return;
  dialog.value.close();
  closed();
}
function activate(event: MouseEvent | KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const image =
    target instanceof HTMLImageElement ? target : target.closest('a')?.querySelector('img');
  if (!image?.matches(props.selector) || image.closest('[data-iris-no-preview]')) return;
  if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (event instanceof MouseEvent && event.button !== 0) return;
  event.preventDefault();
  open(image);
}
function wheel(event: WheelEvent) {
  if (!event.deltaY) return;
  const box = stage.value!.getBoundingClientRect();
  const delta =
    event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
  view.value = zoomAt(view.value, Math.exp(Math.max(-1, Math.min(1, -delta * 0.002))), {
    x: event.clientX - box.left - box.width / 2,
    y: event.clientY - box.top - box.height / 2,
  });
}
function down(event: PointerEvent) {
  if (event.button !== 0 || pointers.size >= 2) return;
  stage.value!.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragging.value = true;
}
function move(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  const before = [...pointers.values()];
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const box = stage.value!.getBoundingClientRect();
  view.value = gesture(view.value, before, [...pointers.values()], {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
  });
}
function up(event: PointerEvent) {
  pointers.delete(event.pointerId);
  dragging.value = pointers.size > 0;
}
function key(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = event.shiftKey ? 100 : 40;
  switch (event.key) {
    case '+':
    case '=':
      zoom(1.25);
      break;
    case '-':
      zoom(0.8);
      break;
    case '0':
      reset();
      break;
    case 'ArrowLeft':
      view.value.x -= step;
      break;
    case 'ArrowRight':
      view.value.x += step;
      break;
    case 'ArrowUp':
      view.value.y -= step;
      break;
    case 'ArrowDown':
      view.value.y += step;
      break;
    default:
      return;
  }
  event.preventDefault();
}
function restore(element: HTMLElement, attributes: Map<string, string | null>) {
  for (const [name, value] of attributes) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}
function enhanceImages() {
  for (const [element, attributes] of enhanced) {
    if (!element.isConnected) {
      restore(element, attributes);
      enhanced.delete(element);
    }
  }
  document.querySelectorAll<HTMLImageElement>(props.selector).forEach((image) => {
    if (!(image instanceof HTMLImageElement) || image.closest('[data-iris-no-preview]')) return;
    const trigger = image.closest('a') || image;
    if (enhanced.has(trigger)) return;
    const attributes: Record<string, string> = {
      'aria-haspopup': 'dialog',
      'aria-label': `${image.alt || '图片'}，打开预览`,
      'data-iris-preview': '',
    };
    if (trigger === image) Object.assign(attributes, { tabindex: '0', role: 'button' });
    const original = new Map<string, string | null>();
    for (const [name, value] of Object.entries(attributes)) {
      original.set(name, trigger.getAttribute(name));
      trigger.setAttribute(name, value);
    }
    enhanced.set(trigger, original);
  });
}
watch(() => route.path, close);
onMounted(() => {
  enhanceImages();
  observer = new MutationObserver(enhanceImages);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', activate);
  document.addEventListener('keydown', activate);
});
onUnmounted(() => {
  observer?.disconnect();
  document.removeEventListener('click', activate);
  document.removeEventListener('keydown', activate);
  closed();
  for (const [element, attributes] of enhanced) restore(element, attributes);
  enhanced.clear();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="iris-preview"
      aria-label="图像预览"
      @close="!dialog?.open && closed()"
      @keydown="key"
      @click="$event.target === dialog && close()"
    >
      <header class="iris-toolbar">
        <span class="iris-title">{{ label }}</span>
        <button type="button" aria-label="缩小" title="缩小 (-)" @click="zoom(0.8)">−</button>
        <output aria-label="缩放比例" aria-live="polite"
          >{{ Math.round(view.scale * 100) }}%</output
        >
        <button type="button" aria-label="放大" title="放大 (+)" @click="zoom(1.25)">+</button>
        <button type="button" @click="reset">适应窗口</button>
        <button type="button" autofocus aria-label="关闭预览" title="关闭 (Esc)" @click="close">
          关闭
        </button>
      </header>
      <div
        ref="stage"
        class="iris-stage"
        :class="{ dragging }"
        @wheel.prevent="wheel"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
        @lostpointercapture="up"
      >
        <p v-if="failed" role="alert">图片加载失败，请关闭后重试。</p>
        <img
          v-else-if="src"
          :src="src"
          :alt="label"
          :style="{ transform }"
          draggable="false"
          @error="failed = true"
        />
      </div>
      <p class="iris-hint">滚轮 / 双指缩放 · 拖动或方向键平移 · 0 复位 · Esc 关闭</p>
    </dialog>
  </Teleport>
</template>

<style>
[data-iris-preview] {
  cursor: zoom-in;
}
[data-iris-preview]:focus-visible {
  outline: 3px solid var(--vp-c-brand-1);
  outline-offset: 4px;
}
.iris-preview {
  width: calc(100vw - 32px);
  height: calc(100dvh - 32px);
  max-width: none;
  max-height: none;
  margin: auto;
  padding: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  overflow: hidden;
}
.iris-preview[open] {
  display: flex;
  flex-direction: column;
}
.iris-preview::backdrop {
  background: rgb(0 0 0 / 75%);
}
.iris-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--vp-c-divider);
}
.iris-title {
  flex: 1;
  min-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iris-toolbar button {
  min-width: 44px;
  min-height: 44px;
  padding: 4px 12px;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  cursor: pointer;
}
.iris-toolbar button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
}
.iris-toolbar output {
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.iris-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: hidden;
  padding: 24px;
  cursor: grab;
  touch-action: none;
}
.iris-stage.dragging {
  cursor: grabbing;
}
.iris-stage img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  flex-shrink: 0;
  user-select: none;
  pointer-events: none;
}
.iris-hint {
  padding: 8px;
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--vp-c-text-2);
}
</style>
