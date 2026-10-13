import { expect, test } from 'vitest';
import MarkdownIt from 'markdown-it';
import { mermaidPreview } from '../../src/index';

test('Mermaid fences encode quotes, HTML and Vue expressions as inert source', () => {
  const graph = 'flowchart LR\n A["<script>{{ value }}</script>"] --> B';
  const result = new MarkdownIt()
    .use(mermaidPreview)
    .render(`\`\`\`mermaid title\n${graph}\n\`\`\``);
  expect(result).toBe(`<IrisMermaid graph="${encodeURIComponent(`${graph}\n`)}" />\n`);
  expect(result).not.toContain('<script>');
});

test('unrelated fences keep the existing renderer and mermaid-like names stay code', () => {
  const md = new MarkdownIt();
  const original = md.render('```mermaid-example\nA-->B\n```');
  md.use(mermaidPreview);
  expect(md.render('```mermaid-example\nA-->B\n```')).toBe(original);
  expect(md.render('```js\nconst a = 1\n```')).toContain('language-js');
});
