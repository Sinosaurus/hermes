// 文件职责：Vitest 测试发现与真实 npm 集成测试的超时配置。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
