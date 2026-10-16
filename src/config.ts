// 文件职责：共享 CLI 默认路径与运行约束：固定已验证 npm 版本及输出大小上限。
// 固定已验证的打包工具链，避免旧 npm 在禁钩子时仍执行 prepare。
export const PACK_NPM_VERSION = '11.19.0';
export const OUTPUT_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_SOURCE_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_BUNDLE_DIR = './bundle';
export const DEFAULT_RUN_DIR = './runs/default';
export const DEFAULT_ACCEPTANCE_FILE = './acceptance.json';
export const DEFAULT_RESOURCES_FILE = 'resources.json';
