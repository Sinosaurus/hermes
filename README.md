# Hermes

`@nova-cbb/hermes` 提供 `nova-hm` 命令，将 npm 包及传递依赖收集成 `bundle/`，带入内网后批量导入私服；也支持从已有 `node_modules` 恢复包。

## 安装

需要 Node 22.12+、24.x 或 26+（推荐 Node 24）、npm 11.19.0 和系统 `tar`。

当前使用流程面向 macOS/Linux；Windows 请在 WSL 中执行。

```sh
npm install -g @nova-cbb/hermes
nova-hm --help
```

需要固定版本时，安装 `@nova-cbb/hermes@0.1.0`。所有默认文件路径相对于运行命令时的当前目录。

## 外网：收集包

在含 `package-lock.json` 或 `npm-shrinkwrap.json`（v2/v3）的业务项目目录执行：

```sh
cd /path/to/project
nova-hm collect
```

按包列表收集时，在批次目录创建 `packages.json`，再执行 `nova-hm collect`。列表优先于当前项目锁文件：

```json
["commander@15.0.0", "semver@7.8.5"]
```

只有 `node_modules` 时，在业务项目目录执行：

```sh
nova-hm recover
```

工具自动向上查找最近的安装树，默认从 npm 官方源取得原始包。外部源码/workspace 链接会阻断恢复；恢复输出必须位于原安装树外。无法回源时的显式重打包流程见[恢复手册](https://github.com/Sinosaurus/hermes/blob/main/docs/operations.md#13-仅有-node_modules恢复与发布)。

以上方式默认生成 `./bundle`，不会覆盖已有目录。新批次可换工作目录，或传入 `--out ./bundle-batch-b`。当前目录已有 `resources.json` 时会自动读取资源与审查记录；缺少记录时资源审查保持待完成状态，正式提升 tag 前须完成审查并重新收集新批次。

## 内网：导入私服

先将 Hermes 及其全部运行依赖准备到内网私服，再在内网安装与外网相同版本的工具。以下以 `0.1.0` 为例：

```sh
npm install -g @nova-cbb/hermes@0.1.0 \
  --registry=https://npm.intranet.example/group/
```

业务 `bundle/` 不包含工具自身的依赖；仅带入 Hermes 的 `.tgz` 不能保证断网安装。

带入 `bundle/` 后，在它的父目录按私服要求配置发布凭证，并设置可写托管仓库地址：

```sh
npm config set registry https://npm.intranet.example/hosted/ --location=project
nova-hm import
```

`import` 自动校验、预检并上传。失败后使用同一命令续跑，保持 bundle、私服端点和 run 不变。工具安装可走聚合读端点，导入目标须为可写端点；业务实际读端点不同时另传 `--read-registry`。

导入完成表示精确版本就绪。完成真实业务验收并准备 `acceptance.json` 后，再提升正式 tag；需要恢复 tag 时执行回滚：

```sh
# 实际验收通过后提升正式 tag。
nova-hm promote

# 需要回滚时再执行。
nova-hm rollback
```

已有正式 tag 指向不同版本时，覆盖需要显式 `--overwrite-tags`；回滚保留已上传版本。资源审查和[验收记录](https://github.com/Sinosaurus/hermes/blob/main/docs/architecture.md#7-验收契约)必须与实际批次一致。

## 常用默认值

| 参数                           | 默认行为                                                   |
| ------------------------------ | ---------------------------------------------------------- |
| `--out` / `--bundle`           | `./bundle`；`inventory` 默认只输出结果                     |
| `--run`                        | `./runs/default`；同批次续跑复用，新批次换目录或指定新 run |
| `--node-modules`               | 从当前目录向上查找最近的安装树                             |
| 收集/恢复 `--registry`         | `https://registry.npmjs.org/`                              |
| 发布 `--registry`              | 当前 npm 配置；隐式默认公网源会被阻断                      |
| `--read-registry`              | 同写端点                                                   |
| `--resources` / `--acceptance` | 当前目录已有的 `resources.json` / `./acceptance.json`      |

终端默认显示中文摘要和进度；重定向自动输出完整 JSON，`--json` 可强制 JSON，`--progress none` 关闭进度：

```sh
nova-hm inventory --json
nova-hm import > import-result.json
nova-hm recover --help
```

退出码 `0` 表示完成，`1` 表示失败，`2` 表示有盘点问题或未完成的清理/回滚。

## 详细说明

- [完整参数、资源配置与验收](https://github.com/Sinosaurus/hermes/blob/main/docs/architecture.md)
- [运维与恢复手册](https://github.com/Sinosaurus/hermes/blob/main/docs/operations.md)
- [源码开发与发布](https://github.com/Sinosaurus/hermes/blob/main/docs/development.md)
- [问题反馈](https://github.com/Sinosaurus/hermes/issues)

[MIT License](https://github.com/Sinosaurus/hermes/blob/main/LICENSE)
