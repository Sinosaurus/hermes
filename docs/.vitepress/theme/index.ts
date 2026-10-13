import DefaultTheme from 'vitepress/theme';
import { withIrisTheme } from 'vitepress-plugin-mermaid-image-preview/theme';
import 'vitepress-plugin-mermaid-image-preview/style.css';

export default withIrisTheme(DefaultTheme);
