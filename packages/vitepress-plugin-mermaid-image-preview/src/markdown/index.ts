import type { MarkdownRenderer } from 'vitepress';

/** Register before other plugins that replace Mermaid fences. */
export function mermaidPreview(md: Pick<MarkdownRenderer, 'renderer'>): void {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.info.trim().split(/\s+/)[0] === 'mermaid') {
      return `<IrisMermaid graph="${encodeURIComponent(token.content)}" />\n`;
    }
    return fence
      ? fence(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
}
