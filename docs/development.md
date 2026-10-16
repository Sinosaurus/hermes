# 开发与校验

使用 Node 22.12+ 或 24+，推荐 Node 24 LTS。真实打包测试要求 npm **11.19.0** 和系统 `tar`；目录 prepare 是否被禁用依赖 npm 版本，不放宽现有硬校验。

包名为 `@nova-cbb/hermes`，CLI 命令为 `nova-hm`。

普通使用者在 npm 包发布后安装即可，无需构建源码：

```sh
npm install -g @nova-cbb/hermes
nova-hm --help
nova-hm --version
```

收集和导入流程、npm 可选安装参数见[快速开始](index.md#安装一次)。以下命令用于源码开发；当前仓库的发布准备要求见下文。

## 源码安装与开发

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev -- --help
npm run dev -- recover --help
```

源码全部使用 TypeScript。`tsx` 提供本地源码执行，`cac` 提供与 Vite 一致的命令解析、`--help` 和版本显示。业务逻辑在 `src/core/`，通用校验在 `src/lib/`，命令适配与终端展示在 `src/cli/`；逐文件说明见[文件职责](file-guide.md)。

参数中的纯数字路径请写成 `./123`；cac 会把裸 `123` 转成数字，工具会明确报错，避免使用错误路径。纯数字包名请加版本或 tag，如 `123@latest`。

CLI 按 [Vite 的实现](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/cli.ts) 组织：链式声明 `command → option → action`，由 `cli.parse()` 直接分发，异步 action 内统一处理错误。重复单值选项取最后一次，例如 `--bundle ./old --bundle ./new` 使用 `./new`；`--package`、`--allow-host`、`--allow-link-root`、`--install-flag` 保留全部值。空值、互斥参数和发布目标的业务限制继续校验。

开发命令默认仍相对当前工作目录读取输入。验证真实业务时，请在业务目录执行构建后的工具，避免读到工具自身的锁文件或安装树。

开发时可选用 `npm link` 调试全局命令，普通 npm 安装无需此步骤：

```sh
npm run build
npm link --offline --ignore-scripts --no-audit --no-fund
nova-hm --help
```

也可直接执行 `node /absolute/path/to/hermes/dist/cli/index.js --help`，无需注册全局命令。更新源码后需重新构建。

## TypeScript 执行工具选型

核对日期：2026-10-12。你提到的工具很可能是 **Oxc 生态的 `oxc-node`，命令名 `oxnode`**。它用 Oxc 转换 TypeScript，再交给 Node 执行，与 tsx 的用途最接近。`tsdown` 和 Vite+ 也容易混淆，但分别面向打包和整套工具链。

| 工具                       | 主要用途                                                                                       | 对本项目的影响                                                                   | 当前建议             |
| -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------- |
| `tsx`                      | 基于 esbuild，直接执行 TypeScript，支持 ESM/CJS 和 watch                                       | 现有 `dev`/`cli` 已使用，支持源码中的 `.js` 导入对应 `.ts`；本次无需改动运行方式 | 保留                 |
| `@oxc-node/cli` / `oxnode` | 基于 Oxc 的 Node TypeScript 执行器，支持 TS/TSX、ESM/CJS、路径别名、源码映射及 Node watch/test | 官方标为实验阶段；依赖按系统/CPU 分发的原生组件，需要验证兼容性与离线安装        | 有明确执行瓶颈时再试 |
| `tsdown`                   | 基于 Rolldown 的 TypeScript 打包工具                                                           | 面向构建产物，不是 tsx 的直接执行替代品；当前 `tsc` 已能生成可运行的 CLI         | 暂不引入             |
| Vite+                      | 整合构建、测试、lint、格式化及任务等的开发工具链                                               | 与目前单独使用的 Vitest、Oxlint/Oxfmt 等有交集，迁移范围大于更换 TS 执行器       | 当前不迁移           |

依据：[tsx 官方仓库](https://github.com/privatenumber/tsx)、[Oxc TypeScript Runner 官方文档](https://oxc.rs/docs/guide/usage/oxc-node.html)、[tsdown 官方选型说明](https://tsdown.dev/guide/faq)、[Vite+ 本地 CLI 文档](https://viteplus.dev/guide/local-cli)。Oxc 官方目前将 TypeScript Runner 标为实验阶段，API 和行为可能随版本变化；这是当前保留 tsx 的另一项依据。

本次 npm 元数据查询结果：`tsx` 为 **4.23.15**，`@oxc-node/cli` 和 `@oxc-node/core` 为 **0.1.6**。版本号只用于记录本次比较，不能直接代表成熟度或性能。未对 oxnode 做本项目兼容性测试，也未做性能跑分，因此不声称它一定更快。

**本项目继续使用 `tsx + tsc`**：开发时直接执行源码，类型检查和交付构建交给 `tsc`，内网运行 `dist/` 下的 JavaScript。tsx 和 oxnode 的快速转换都不替代类型检查。业务流程涉及 npm 网络、打包和私服操作；更换源码执行器对整体耗时的收益需要实际测量。

若后续试用 oxnode，先在独立环境验证 CLI 帮助、异步错误/退出码、NodeNext 的 `.js` → `.ts` 导入、子进程、watch 与目标平台安装，再决定是否替换 `dev`/`cli`；不同时改变发布与打包策略。

## 构建与质量检查

```sh
npm run build           # tsc 编译到 dist/
npm run typecheck       # 严格检查运行源码类型
npm run lint            # Oxlint；警告也视为失败
npm run format          # Oxfmt 格式化源码、配置和文档
npm run format:check    # 只检查格式
npm test                # 先构建，再用 Vitest 验证源码及构建后的 CLI
npm run check           # 以上检查及文档构建
```

`npm test` 包含本机临时 HTTP registry 和真实 npm 子进程测试，运行环境需要允许监听 loopback 端口；不会向真实私服发布。测试涵盖依赖闭包、嵌套 npm/Yarn/pnpm 实例、目录边界、脚本钩子、制品完整性、上传续跑与 tag 回滚。

测试文件由 Vitest 编译执行；`typecheck` 专门检查生产源码。测试中刻意构造的非法输入由运行时断言验证。

## npm 发布准备

当前 `package.json` 仍有 `private: true`，尚未配置 `files` 或 `prepack`；本文的用户安装命令在维护者完成发布后适用。发布前需由维护者处理发布字段与产物范围：

- 解除 `private: true` 对发布的阻止，确认包名、版本、目标 registry 和 scope 的发布权限；公开发布时明确选择公开访问级别。
- 明确打包包含完整 `dist/` 及必要的包元数据和说明文件，可用 `files` 限定发布范围；若保留 README 中的文档链接，也应保留对应文档与图片。通过 `pack` 文件清单确认实际产物，不只检查 `bin` 入口。
- 没有 `prepack` 时须手工构建；即使后续增加该钩子，以下禁钩子打包命令仍要求先构建。发布包须包含可直接运行的编译产物，不能依赖安装时编译。

字段与打包范围规则见 [npm package.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)。准备好发布字段后执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run check
npm pack --dry-run --ignore-scripts --json
npm pack --ignore-scripts --json
```

检查 pack 的文件清单和实际 `.tgz`：必须包含 `dist/cli/index.js` 及它导入的全部编译模块，核对包名、版本、`bin` 和 Node 要求；不得夹带 bundle/run、凭据或本地缓存。随后在空临时目录禁钩子安装该 `.tgz`，验证 `nova-hm --help`、`--version`，避免源码目录现存依赖掩盖缺失产物。`pack` 只生成本地制品，不代表已发布或已通过目标私服验收。

生产依赖仍由 npm 安装，`package-lock.json` 不随 npm 包发布，不能用源码锁文件承诺用户全局安装的传递依赖完全一致。发布版本及实际生产依赖应作为独立工具批次冻结、导入内网并验证，业务 bundle 不包含它们。

## 文档站

```sh
npm run docs:dev        # 本地预览并实时更新
npm run docs:build      # 构建到 docs/.vitepress/dist/
npm run docs:preview    # 预览构建结果
```

文档站使用 VitePress **2.0.0-alpha.20**（2.x 预发布版），提供中文导航、侧栏、本地搜索和页内目录。

Mermaid 使用 **11.17.2**，预览使用 npm 包 `vitepress-plugin-mermaid-image-preview@0.1.1`，不再直接引用本地插件源码。插件源码与发布维护在[独立 GitHub 仓库](https://github.com/Sinosaurus/vitepress-plugin-mermaid-image-preview)，本站通过更新 npm 依赖使用新版本。Markdown Mermaid 代码块会渲染成图表；Mermaid 图和普通图片（PNG/JPEG/WebP/SVG 等）都可点击或用 Enter/空格打开同一个预览弹窗。

预览支持按钮及滚轮缩放（10%–800%，滚轮以光标为中心）、鼠标/触屏拖动、双指缩放、方向键平移、适应窗口和 Esc 关闭；`+`/`-` 缩放，`0` 复位。Mermaid 随站点打包，浏览器无需访问外部渲染服务；仓库内 SVG 仍可独立离线查看。

插件开发、发布和其他 VitePress 项目的接入方式见[插件仓库 README](https://github.com/Sinosaurus/vitepress-plugin-mermaid-image-preview#readme)。本仓库不保留插件源码。

## 内网安装与交付

先由私服维护者将已验收的 Hermes 发布版本及全部生产依赖（含传递依赖）导入内网私服，业务 `bundle/` 单独交付。只有 Hermes 的 `.tgz` 不能保证断网安装成功；开发和文档依赖无需在内网安装。内外网工具使用同一版本，Node/npm/tar 另行准备。

```sh
# 将 <version> 替换为已验收的实际版本；工具安装使用内网读端点。
npm install -g '@nova-cbb/hermes@<version>' \
  --registry https://npm.intranet.example/group/
nova-hm --version
nova-hm --help

# 在 bundle 的父目录配置业务导入的可写 hosted 端点。
cd /path/to/batch
npm config set registry https://npm.intranet.example/hosted/ --location=project
nova-hm import
```

工具安装的 group/聚合读端点与导入的 hosted 写端点各司其职；业务使用聚合读路由时，导入命令另传 `--read-registry https://npm.intranet.example/group/`。认证、CA 与已有 scope 路由使用受控 npm 配置，确认实际依赖与 tarball URL 均可从内网访问；用空缓存、无外网环境验证安装和启动。

`dist/` 为 npm 发布包中的编译产物。源码内使用 `.js` 扩展名导入，由 TypeScript NodeNext 解析到对应 `.ts` 文件，并生成可直接运行的 Node ESM。
