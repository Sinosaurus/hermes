import type { MermaidConfig } from 'mermaid';

let pending: Promise<unknown> = Promise.resolve();

/** Mermaid has global configuration: serialize configuration and rendering together. */
export function renderDiagram(id: string, graph: string, dark: boolean): Promise<string> {
  const result = pending.then(async () => {
    const { default: mermaid } = await import('mermaid');
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
    };
    mermaid.initialize(config);
    const { svg } = await mermaid.render(id, graph);
    return svg;
  });
  pending = result.catch(() => undefined);
  return result;
}

export function svgImage(svg: string): string {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  if (root.localName !== 'svg' || root.querySelector('parsererror')) {
    throw new Error('Mermaid 返回的 SVG 无效');
  }
  const box = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    // SVG 作为图片加载时需要本征尺寸，百分比宽度会造成裁切。
    root.setAttribute('width', String(box[2]));
    root.setAttribute('height', String(box[3]));
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}
