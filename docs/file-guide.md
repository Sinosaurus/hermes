# 文件职责与阅读指南

本文覆盖当前项目源码、测试、配置和文档；不枚举自动安装的 `node_modules/`、Git 内部文件或运行生成的 bundle/run。

## 1. 源码

```text
src/
├── cli/       # cac 命令、参数适配、帮助、结果与进度
├── core/      # 流程入口与业务数据契约
│   ├── collection/  # 依赖解析、原制品/重打包、资源与 bundle 冻结
│   ├── installed/   # 安装树路径边界、内容摘要与递归扫描
│   └── publishing/  # 预检、run、版本、tag 与验收提升
├── lib/       # npm 子进程、制品、文件、身份和安全校验
└── config.ts  # 已验证的工具版本与运行常量
test/          # Vitest 单元与真实 npm 集成测试
docs/          # VitePress 文档站
```

| 文件                   | 作用                                                                                       | 主要入口或阅读重点                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/cli/index.ts`     | 可执行入口，调用 cac，输出脱敏错误、操作提示和退出码                                       | `createProgram`、`cli.parse()` 及同步解析错误处理                                       |
| `src/cli/program.ts`   | 按 Vite 风格链式声明命令，处理单值末次覆盖、批量参数、互斥校验及异步 action 错误           | `createProgram`、`registerCollectionCommands`、`registerPublishingCommands`             |
| `src/cli/actions.ts`   | 将 CLI 参数映射到业务函数，合并批量输入、选择默认输入/私服端点，统一结果输出与进度生命周期 | `packageInputs`、各命令 action、`runAction`                                             |
| `src/cli/output.ts`    | 终端中文结果摘要、管道/显式 JSON 和常见错误处理提示                                        | `writeResult`、`writeFailure`；保留 JSON 数据结构及脱敏                                 |
| `src/config.ts`        | 固定已验证的 npm 打包版本、默认源 registry 和输出上限                                      | `PACK_NPM_VERSION`、`OUTPUT_LIMIT`                                                      |
| `src/lib/index.ts`     | 公共能力导出入口，统一导出共享能力                                                         | 实现在 `src/lib/`，此文件不实现业务流程                                                 |
| `src/core/collect.ts`  | 收集与恢复入口：组织解析、取包、资源复制、冻结及失败清理                                   | `collect`、`recover`；具体步骤在 `collection/`                                          |
| `src/core/recovery.ts` | 安装树入口：组织自动定位、盘点、冲突汇总及独立 staging                                     | `inventoryModules`、`stageInstance`；递归扫描在 `installed/`                            |
| `src/core/publish.ts`  | 发布入口：组织导入、验收后 tag 提升及条件回滚                                              | `importBundle`、`promoteRun`、`rollbackRun`；具体步骤在 `publishing/`                   |
| `src/cli/progress.ts`  | 在 stderr 输出终端进度条或普通文字，区分下载/上传/复用数量和字节                           | `createProgress`、`progressLine`、`formatBytes`；stdout 留给结果摘要或 JSON             |
| `src/lib/packages.ts`  | 使用通用库校验 npm 包名、规范精确版本、registry 规格和 dist-tag                            | `validateIdentity`、`registrySpec`、`validateDistTag`；仍保留项目的非 registry 输入限制 |
| `src/lib/security.ts`  | 规范 registry URL、清除公开来源 URL 的凭证、脱敏错误                                       | `normalizeRegistry`、`publicUrl`、`redact`                                              |
| `src/lib/npm.ts`       | 受控调用 npm/tar 等子进程，限制超时和输出，绑定 registry/cache，检查 npm 工具链            | `command`、`npmCommand`、`npmJson`、`assertPackToolchain`；禁用 shell                   |
| `src/lib/files.ts`     | 原子 JSON 写入、文件摘要、流式 SRI 校验、路径规范化及受控文件枚举                          | `writeJson`、`assertIntegrity`、`safePath`、`canonicalPath`、`listFiles`                |
| `src/lib/artifacts.ts` | 读取归档身份并拒绝危险成员，禁钩子打包，核对冻结 bundle 的文件集合、摘要、包身份及声明     | `readArtifact`、`packArtifact`、`verifyBundle`；包验证与资源/tag/平台声明验证分开       |

`src/cli/types.ts` 定义 CLI 参数、输出流与结果契约；`src/core/types.ts` 定义 manifest、包身份、安装树实例、进度事件和 run 状态。

### core 内部步骤

| 文件                                | 作用                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/core/collection/bundle.ts`     | 创建批次、平台声明、源 tag 计划、失败记录与冻结文件清单         |
| `src/core/collection/resolution.ts` | 校验安装选项，解析 npm 锁条目、项目输入与批量根包               |
| `src/core/collection/originals.ts`  | 回源获取原始制品，核对来源、身份和 SRI，记录元数据与源 tag 快照 |
| `src/core/collection/repack.ts`     | 为安装树实例建立 staging，禁钩子重打包并登记恢复制品            |
| `src/core/collection/resources.ts`  | 校验资源声明，复制受控文件/目录并登记人工审查记录               |
| `src/core/installed/paths.ts`       | 自动寻找 node_modules，检查真实目录边界，生成盘点问题           |
| `src/core/installed/content.ts`     | 读取包身份、计算内容摘要，安全复制文件，排除普通嵌套依赖目录    |
| `src/core/installed/scan.ts`        | 扫描 npm/Yarn/pnpm 的模块、scope 和 store，保留实例位置与上下文 |
| `src/core/publishing/context.ts`    | 发布选项与 npm 适配器契约，初始化本次统计/进度，统一错误工具    |
| `src/core/publishing/registry.ts`   | 查询目标元数据/tag，下载并校验远端制品，约束目标下载来源        |
| `src/core/publishing/plan.ts`       | 校验批次与目标参数，只读预检版本内容及 tag 差异                 |
| `src/core/publishing/run.ts`        | run 排他锁、身份/状态持久化、创建与续跑、冻结批次复核           |
| `src/core/publishing/versions.ts`   | 导入单个/批量精确版本，处理已存在内容、丢失响应及回读校验       |
| `src/core/publishing/tags.ts`       | 写入/回读 tag，按当前值条件恢复旧值，清理本 run 的临时 tag      |
| `src/core/publishing/promotion.ts`  | 绑定验收证据，生成正式 tag 变更计划，应用并复核提升结果         |

这些模块按实际步骤拆分，不新增通用工作流框架。对外仍从原来的 `collect.ts`、`recovery.ts`、`publish.ts` 导入；CLI 和测试无需了解内部文件布局。

## 2. 测试

| 文件                       | 作用                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `test/cli-output.test.ts`  | 验证终端摘要、重定向/--json 完整记录、问题数量及错误脱敏和处理提示                                                      |
| `test/common.test.ts`      | 校验规格/版本/tag、锁条目、SRI、路径、归档与 bundle 边界，以及 CLI 帮助/错误/退出码                                     |
| `test/recovery.test.ts`    | 用安装树夹具覆盖嵌套/scope、pnpm/Yarn store、node_modules 实体边界及受控链接许可、内容冲突及 staging 完整性             |
| `test/publish.test.ts`     | 用注入的 npm 适配器模拟版本冲突、重复导入、丢失响应、断点续跑、验收约束、tag 变更和条件回滚                             |
| `test/progress.test.ts`    | 检查进度统计、TTY/普通/关闭模式，以及批量 JSON 输入校验与合并、默认输入/私服选择、公网默认发布阻断与免参数盘点          |
| `test/integration.test.ts` | 启动本机临时 registry，使用真实 npm 验证依赖收集、字节保留、消费安装、发布/tag/回滚及恢复禁钩子；夹具不会向真实私服发布 |

测试夹具直接写在各测试文件中，临时目录由测试清理；不额外建立共享模拟框架。

## 3. 配置与文档

| 文件                                              | 作用                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `package.json`                                    | 项目元数据、Node 最低版本、CLI bin、测试命令及精确直接依赖                      |
| `package-lock.json`                               | 固定直接/传递依赖版本、获取地址及完整性；通过 `npm ci --ignore-scripts` 安装    |
| `.gitignore`                                      | 排除依赖目录、缓存、默认 bundle/run 及系统临时文件，防止制品和状态误提交        |
| `README.md`                                       | 简短使用首页：一次准备、收集/恢复、内网导入、默认值及结果展示                   |
| [docs/operations.md](operations.md)               | 完整技术方案、操作手册、平台/资源/scripts、恢复和验收要求                       |
| [docs/architecture.md](architecture.md)           | 当前 CLI 的实现架构、支持边界、命令和实际 JSON 结构示例、工具离线准备及验证结果 |
| [docs/offline-npm-flow.svg](offline-npm-flow.svg) | 可独立查看的流程图，展示收集、冻结、交接、导入、验收和 tag 提升                 |
| [docs/file-guide.md](file-guide.md)               | 本文件：逐文件职责、主要入口与阅读顺序                                          |

工具链和站点配置职责：

| 文件                             | 作用                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `tsconfig.json`                  | TypeScript 严格类型检查与 Node ESM 编译，输出到 `dist/`        |
| `vitest.config.ts`               | 测试文件发现、执行超时和钩子清理超时                           |
| `.oxlintrc.json`                 | Oxlint 正确性检查，排除编译与站点产物                          |
| `.oxfmtrc.json`                  | Oxfmt 统一源码、配置和 Markdown 格式                           |
| `docs/.vitepress/config.ts`      | 文档导航、侧栏、本地搜索、中文界面和 Mermaid Markdown 渲染配置 |
| `docs/.vitepress/theme/index.ts` | 复用独立 Iris 插件主题，不保留本地预览组件                     |
| `docs/index.md`                  | 文档站快速开始首页                                             |
| `docs/development.md`            | 安装、开发、构建、质量检查与离线工具交付                       |
| `dist/`                          | TypeScript 自动构建产物，不手工修改、不提交                    |

Mermaid 与图片预览使用 npm 包 `vitepress-plugin-mermaid-image-preview`；源码、测试和演示在[独立仓库](https://github.com/Sinosaurus/vitepress-plugin-mermaid-image-preview)维护，不属于本仓库目录。

## 4. 阅读与修改顺序

先读 `src/cli/program.ts` 的命令声明，再读 `src/cli/actions.ts` 的参数映射，随后读 `core` 顶层入口的流程顺序，再进入对应目录的具体步骤；公共校验和子进程策略从 `src/lib/index.ts` 追到具体实现。

拆分函数以实际流程边界为准：主入口负责顺序和错误清理，具体步骤负责解析、单包处理或 tag 更新。注释使用中文，优先解释为何禁钩子、为何冻结、为何先持久化再写远端，以及链接和恢复内容的边界。

修改发布时保留「持久化意图 → 外部写入 → 回读确认 → 持久化结果」的顺序；修改收集/恢复时保留失败记录、临时目录清理、原安装树只读和 bundle 不覆盖的约束。执行 `npm test` 验证，真实内网私服和完整业务验收仍需目标环境执行。
