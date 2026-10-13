# 项目协作约定

## 项目与沟通

- 使用中文沟通、编写文档和必要的代码注释；保留命令、标识符及错误码的原文。
- 本项目为 `@nova-cbb/hermes`，命令名为 `nova-hm`，用于 npm 制品收集、安装树恢复及内网私服导入。
- 优先做能完整解决问题的最小改动，复用现有实现，不引入无需求的抽象或依赖。

## 环境与命令

- 使用 Node 22.12+、24+ 或 26+，推荐 Node 24；真实打包校验要求 npm 11.19.0 和系统 `tar`，以 `package.json` 与 `src/config.ts` 为准。
- 安装依赖：`npm ci --ignore-scripts --no-audit --no-fund`。
- 开发入口：`npm run dev -- --help`；构建：`npm run build`。
- 完整检查：`npm run check`，包含类型、lint、格式、测试及文档构建；按改动范围运行相应检查。
- `npm test` 使用本机临时 HTTP registry，运行环境需要允许监听回环端口；测试不向真实私服发布。
- 文档开发和构建：`npm run docs:dev`、`npm run docs:build`。

## 目录与实现

- `src/cli/`：命令声明、参数适配、终端输出及进度。
- `src/core/`：收集、恢复、发布及 tag 管理流程。
- `src/lib/`：文件、制品、包信息、安全校验及子进程公共实现。
- `test/`：Vitest 单元与真实 npm 集成测试；`docs/`：中文文档与 VitePress 配置。
- 源码使用 TypeScript 与 NodeNext，内部导入保留 `.js` 扩展名；由 TypeScript 解析到 `.ts` 并编译。
- `dist/`、文档构建产物、依赖目录和本地凭据不手工修改或提交。
- Mermaid 图片预览由 npm 包 `vitepress-plugin-mermaid-image-preview` 提供；源码在 https://github.com/Sinosaurus/vitepress-plugin-mermaid-image-preview 维护，不在本仓库恢复 `packages/` 插件目录。
- 文档主题保留插件样式导入及 `ssr.noExternal` 配置。

## 必须保留的业务约束

- 不覆盖已有 bundle，不修改被恢复的原安装树；保留失败记录和临时目录清理。
- 不执行待收集、恢复或导入包的生命周期脚本；不放宽路径、链接、registry、完整性和发布目标的校验。
- 发布流程保留“持久化意图 → 外部写入 → 回读确认 → 持久化结果”的顺序。
- 凭据与日志必须脱敏，不把密码、token、验证码或恢复码写入源码、文档或提交。
- 行为变化同步更新调用方、相关测试及文档；真实私服验收结果不得用本地测试结果替代。

## 代码查找

- 已有可用索引时，优先使用 codebase-memory-mcp 的 `search_graph`、`trace_path`、`get_code_snippet`，复杂结构再用 `query_graph`、`get_architecture`。
- 工具不可用、索引缺失或过期时，使用 `rg` 和直接文件读取；不要仅为满足此约定建立索引。
- 字符串、错误消息、配置及文档直接使用文本搜索。
