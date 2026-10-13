# Hermes：npm 批量下载与离线发布

**`@nova-cbb/hermes`**（CLI：`nova-hm`）把 npm 包及传递依赖收集成 `bundle/`，带入内网后批量上传私服。已有 `node_modules` 时，也能按安装树恢复包。

## 准备一次

工具需要 **Node 22.12+ 或 24+（推荐 Node 24 LTS）、npm 11.19.0、系统 tar**。在外网的工具目录安装依赖：

```sh
cd /path/to/tool
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm link --offline --ignore-scripts --no-audit --no-fund
nova-hm --help
```

`npm link` 将本地工具注册为 `nova-hm`，无需从 registry 安装工具包。之后切换到**业务目录或本批次的独立工作目录**。下文 `/path/to/tool` 替换为工具的实际路径；所有默认文件路径都相对于当前工作目录。

> 不要在工具源码目录执行无参数 `collect` / `recover`，否则会读取工具自己的锁文件或 `node_modules`。

## 外网：选择一种收集方式

**有业务 npm 锁文件**：在业务目录执行，自动读取 `npm-shrinkwrap.json` 或 `package-lock.json`（v2/v3）：

```sh
cd /path/to/business
nova-hm collect
```

**按包列表下载**：在当前目录创建 `packages.json`，再执行同一条 `collect`。列表优先于当前项目锁文件：

```json
["commander@15.0.0", "semver@7.8.5"]
```

**只有 node_modules**：在业务目录改用 `recover`，自动向上寻找最近的 `node_modules`，扫描嵌套 npm/Yarn/pnpm 实例，再从源 registry 获取原始 tarball：

```sh
nova-hm recover
```

三种方式默认生成 `./bundle`，不会覆盖已有目录。新批次换工作目录，或指定 `--out ./bundle-batch-b`。

恢复入口和包实体的真实路径都必须在 `node_modules` 内；指向外部源码/workspace 的链接会阻断。`--allow-link-root` 也不能放宽这一约束。无法回源时，可按[恢复手册](docs/operations.md#13-仅有-node_modules恢复与发布)显式重打包，并使用专用恢复仓库。

## 内网：批量上传

带入生成的 `bundle/` 和准备好的工具目录（包含工具自己的 `node_modules/`），准备相同工具链。在内网工具目录执行一次 `npm link --offline --ignore-scripts --no-audit --no-fund` 注册命令，再在 **bundle 的父目录**执行，按私服要求配置发布凭证，再设置可写的托管仓库地址：

```sh
npm config set registry https://npm.intranet.example/hosted/ --location=project
nova-hm import
```

`import` 自动校验制品、预检冲突并上传。上传失败后执行原命令续跑，保持 bundle、私服端点和 run 不变；日常不必另跑 `verify`、`plan` 或测试命令。

**上传完成表示精确版本就绪。** 正式 `latest` 等 tag 在实际业务验收后通过 `promote` 提升；浏览器、原生二进制等额外资源及消费端 scripts 仍须审查。见[验收与 tag 操作](docs/architecture.md#6-内网版本导入与-tag-提升)。

## 默认值与结果

| 配置                   | 不传时                                                   |
| ---------------------- | -------------------------------------------------------- |
| `--out` / `--bundle`   | `./bundle`                                               |
| `--run`                | `./runs/default`；同批次续跑复用，新批次换目录或 `--run` |
| `--node-modules`       | 从当前目录向上查找最近的 `node_modules`                  |
| 收集/恢复 `--registry` | npm 官方源；私有源需显式指定                             |
| 发布 `--registry`      | 当前 npm 配置；隐式默认公网源会被阻断                    |
| `--read-registry`      | 同写端点；业务使用聚合读端点时另行指定                   |
| `--acceptance`         | `./acceptance.json`，须填写真实验收证据                  |

终端默认显示中文结果摘要和进度统计。重定向或管道自动输出完整 JSON；`--json` 可显式选择 JSON。进度写 stderr，可用 `--progress none` 关闭：

```sh
nova-hm inventory --json
nova-hm import > import-result.json
nova-hm recover --help
```

错误会给出原因及适用的处理提示。退出码 `0` 表示完成，`1` 表示失败，`2` 表示有盘点问题或清理/回滚未完成；遇到 `2` 请查看结果中待处理项。

## 按需查阅

- [实现架构与完整参数](docs/architecture.md)：命令示例、资源/验收 JSON、工具链与支持范围。
- [技术方案与操作手册](docs/operations.md)：依赖闭包、平台资源、scripts 钩子、验收、恢复与排障。
- [总流程图](docs/offline-npm-flow.svg)：收集 → 交接 → 导入 → 验收 → tag 提升。
- [文件职责与阅读指南](docs/file-guide.md)：每个源码、测试、配置和文档文件的作用。

## 本地开发

```sh
npm run dev -- --help
npm run check
npm run docs:dev
```

使用 TypeScript、cac、Oxlint/Oxfmt、Vitest 和 VitePress。完整开发命令与交付方式见[开发指南](docs/development.md)。
