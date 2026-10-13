import DefaultTheme from 'vitepress/theme';
import { withIrisTheme } from '../../../dist/theme.js';
import '../../../dist/style.css';

export default withIrisTheme(DefaultTheme);
