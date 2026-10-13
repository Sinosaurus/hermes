// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import type { App } from 'vue';
import { useRoute } from 'vitepress';
import MediaPreview from '../../../src/theme/preview/MediaPreview.vue';

vi.mock('vitepress', async () => {
  const { reactive } = await import('vue');
  const route = reactive({ path: '/' });
  return { useRoute: () => route };
});

let app: App;
let dialog: HTMLDialogElement;
beforeEach(async () => {
  // Happy DOM does not implement the native dialog focus/top-layer behavior.
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
  document.body.innerHTML =
    '<main class="vp-doc"><img src="/test.png" alt="测试图片" tabindex="3"><img src="/skip.png" data-iris-no-preview><a href="/next"><img src="/linked.webp" alt="带链接图片"></a></main><div id="app"></div>';
  useRoute().path = '/';
  app = createApp({ render: () => h(MediaPreview) });
  app.mount(document.getElementById('app')!);
  await nextTick();
  dialog = document.querySelector('dialog')!;
});
afterEach(() => {
  app.unmount();
  document.body.innerHTML = '';
  document.documentElement.style.overflow = '';
  vi.restoreAllMocks();
});

test('image keyboard opening, zoom, reset, route closing and scroll restoration', async () => {
  const image = document.querySelector('img')!;
  expect(image.getAttribute('role')).toBe('button');
  document.documentElement.style.overflow = 'scroll';
  image.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await nextTick();
  expect(dialog.open).toBe(true);
  expect(document.documentElement.style.overflow).toBe('hidden');
  dialog.querySelector<HTMLButtonElement>('[aria-label="放大"]')!.click();
  await nextTick();
  expect(dialog.querySelector('output')!.textContent).toBe('125%');
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await nextTick();
  expect(dialog.querySelector('img')!.style.transform).toContain('40px');
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
  await nextTick();
  expect(dialog.querySelector('img')!.style.transform).toBe('translate(0px, 0px) scale(1)');
  useRoute().path = '/next';
  await nextTick();
  expect(dialog.open).toBe(false);
  expect(document.documentElement.style.overflow).toBe('scroll');
  expect(document.activeElement).toBe(image);
});

test('linked images preserve modified clicks, opt-out works, and cleanup restores attributes', async () => {
  const link = document.querySelector('a')!;
  expect(link.getAttribute('role')).toBe(null);
  expect(link.getAttribute('aria-haspopup')).toBe('dialog');
  expect(
    document.querySelector('img[data-iris-no-preview]')!.hasAttribute('data-iris-preview'),
  ).toBe(false);
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  link.querySelector('img')!.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(dialog.open).toBe(false);
  link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await nextTick();
  expect(dialog.open).toBe(true);
  app.unmount();
  expect(document.querySelector('img')!.getAttribute('tabindex')).toBe('3');
  expect(document.querySelector('img')!.hasAttribute('role')).toBe(false);
  expect(link.hasAttribute('aria-haspopup')).toBe(false);
  expect(document.documentElement.style.overflow).toBe('');
});

test('new images after navigation are enhanced and image errors are visible', async () => {
  const image = document.createElement('img');
  image.src = '/new.jpg';
  document.querySelector('main')!.append(image);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(image.getAttribute('role')).toBe('button');
  image.click();
  await nextTick();
  dialog.querySelector('img')!.dispatchEvent(new Event('error'));
  await nextTick();
  expect(dialog.querySelector('[role="alert"]')!.textContent).toContain('图片加载失败');
});
