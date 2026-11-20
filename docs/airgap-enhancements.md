# 跨隔离网采集增强

> HTTP 私服现可通过精确端点显式授权、匿名隔离模式接入；默认仍为 HTTPS。本文历史 HTTPS-only 描述以 [HTTP 接入与验收](./http-registry.md) 为准。认证发布请使用 HTTPS。
> 这一版保留原有 `collect → verify → plan → import → 验收 → promote`，新增跨平台可选依赖补齐、显式远程资源下载和离线静态资源导出。**不自动执行安装脚本，不自动上传静态服务，不修改项目锁文件。**

## 1. 联网采集 npm 包

```sh
nova-hm collect --package oxlint@1.90.0 --all-platforms --resources ./resources.json --out ./bundle-20261101
# 或使用现有项目的 npm v2/v3 锁文件
nova-hm collect --project ./my-project --all-platforms --resources ./resources.json --out ./project-bundle
nova-hm verify --bundle ./bundle-20261101
```

`--all-platforms` 明确遍历每个已选版本的 registry 元数据，补齐 `optionalDependencies`，不按采集机器的 OS/CPU 过滤。保留原锁中已选精确版本；缺失项在临时目录用禁脚本的 npm 锁解析，保存额外输入和精确版本。新增平台包的必需依赖缺失、可选包无法解析、身份/范围不符都会失败，不能静默给出“全平台完成”。

`inputs/platform-closure.json` 记录父包、请求范围、锁中/补充解析来源、补充上下文，以及上游声明的 OS/CPU/libc。原项目锁保持原样。**此报告是采集证据，不是所有目标平台的运行验收证书。** 保持 `manifest.targets` 原有采集目标语义，不把上游平台声明冒充实测。

**常用环境一次采：** 使用 `--all-platforms`，无需在每台机器重复收集。摘要按 Windows、macOS 的 x64/ARM64，以及 Linux 的 x64/ARM64 × glibc/musl，列出已收录制品中匹配元数据声明的数量。数量为零只是没有相应声明，不代表缺包或覆盖完整；纯 JS 包本就可能不声明平台。普通锁文件模式不做此项评估。`--json` 保留原有字段，并新增 `coverage.npm`；`manifest.targets` 不变。Windows 是采集目标，不代表 Hermes 可在 Windows 原生命令行运行（目前用 WSL）。

默认不加该选项时仍只收锁中条目，兼容原行为。非精确范围在采集时解析并冻结，换时间重采可能选中不同版本，请保留 bundle 和 report。不同上下文的同名不同版本均保留；相同包版本仍走既有 tarball 完整性去重/冲突校验。

### 项目锁包含 workspace 或本地 TGZ

`nova-hm collect --project ./my-project --out ./bundle` 支持 npm v2/v3 项目锁中的两类本地条目：

- **npm workspace：** 只接受根清单明确声明的项目内目录，支持字面路径和整个路径段的 `*`（例如 `packages/*`）。目录、清单、链接位置、包名及精确版本必须与锁一致；新增或缺失 workspace 需要先更新 npm 锁。不归档也不发布 workspace 源码。
- **本地 TGZ：** `file:artifacts/pkg.tgz` 等项目内相对路径必须在根或已验证的 workspace 清单中有对应依赖，且原文件的 SRI、包名和版本与 lock 一致。拒绝绝对路径、路径穿越、符号链接、百分号编码和任意脱离项目目录的输入。不会重打包、改 `private` 或通过 registry 发布这个 TGZ。

Hermes 在临时目录只摆放验证所需的清单和本地 TGZ，禁用安装脚本，不复用项目 .npmrc，不改工作目录和原锁。交付包附带 `inputs/project/local-inputs.json` 记录本地工作区及 TGZ（后者含 SHA-256/SRI），这些本地项不会进入 registry 发布表。内网使用原项目源码与原 TGZ（相同路径、相同字节）配合私服安装；不能只带 Hermes bundle。需要路径迁移时，应在安装工作副本仅改必要的 registry 条目，保留锁里的版本、完整性与本地引用。

不支持任意 directory link、Git/外部 URL 型依赖、`workspace:` 等非 npm 锁协议（npm 项目应使用锁中的本地 link 记录）；`--package` 规格仍只接受 registry 输入。这个能力以原 npm 锁已有的 registry 依赖为准，不会推断本地包在其它系统上的额外依赖或生命周期行为。

### 原始 npm tarball 兼容边界

校验原始 tarball 的内容与锁中 SRI，不解包执行或重打包。允许仅有一个安全目录根，根名可不是 `package/`（部分 `@types/*` 正是这样）；项目清单仍须是该根下唯一的普通 `package.json`。兼容普通 ustar（含 ustar prefix 长路径）和普通 GNU tar 头。GNU longname、PAX 扩展头和其他特殊条目暂不接收；遇到这些格式会明确失败，不会跳过安全校验。路径穿越、链接、文件目录冲突以及歧义重复记录仍会被拦截。源码只允许严格界定的点段别名：只有普通文件的元数据和内容逐字节完全相同才接受，原压缩字节不变。

## 2. 安装脚本之外的资源

GitHub Releases、厂商二进制、浏览器和运行时文件不是普通 npm tarball。通过显式清单下载，不能推断“scripts 字段为空就不外联”。示例中的 URL、版本和 SHA 必须换成你实际核验过的上游版本：

```json
{
  "resources": [
    {
      "id": "vendor-win32-x64",
      "version": "1.2.3",
      "targets": [{ "os": "win32", "cpu": "x64", "node": "24" }],
      "download": {
        "url": "https://github.com/OWNER/PROJECT/releases/download/v1.2.3/tool-win32-x64.zip",
        "filename": "tool-win32-x64.zip",
        "sha256": "REPLACE_WITH_64_HEX_SHA256_FROM_A_TRUSTED_SOURCE",
        "allowHosts": ["release-assets.githubusercontent.com"],
        "maxBytes": 1073741824,
        "timeoutMs": 300000
      },
      "instructions": "将对应文件部署到既有静态服务，并按该工具版本文档设置下载地址；在 Windows x64 上实际断网安装及运行验收。",
      "environment": {
        "VENDOR_DOWNLOAD_URL": "{{baseUrl}}/resources/vendor-win32-x64/tool-win32-x64.zip"
      }
    }
  ]
}
```

- 上例 `VENDOR_DOWNLOAD_URL` 是示意变量，**不是通用有效变量**。需换成具体工具真实支持的配置；本工具不执行 environment 值。
- `source`（本地文件/目录）与 `download` 二选一。原有本地清单继续可用，拒绝根路径及目录内符号链接。
- URL 初始地址必须 HTTPS（测试仅允许回环 HTTP），禁止凭据、查询、fragment。跳转逐次验证协议和主机，跨 host 要明确 `allowHosts`，不允许 HTTPS 降级。GitHub 公共资源短期签名跳转的查询只用于请求，不写 manifest 或错误文本。
- SHA-256 必填，在落盘前流式校验。默认 1 GiB/300 秒上限，可显式调整，上限 16 GiB/1 小时；错误、超时和校验失败清除临时文件，不覆盖既有文件。
- 不自动下载并执行上游脚本，不自动解压二进制，不支持私密 URL/token。需要认证的资源先通过授权方式下载为本地 `source`。
- `version`、`targets`、`environment`、来源与 SHA 一起冻结。审查仍默认 pending，只有人工有证据才能填 `review.status: reviewed`。

**如何读资源状态：**

- **已收录：** 来自显式清单且通过批次校验的资源，摘要和 `coverage.static.entries` 给出记录；这不代表外部资源齐全。
- **明确缺失或校验失败：** 已声明文件缺失、下载失败或 SHA-256 不匹配时，采集失败；不会生成一份把该项当作已收录的成功结果。
- **未配置／未检测：** 没有资源条目时不能判断不需要静态文件。Hermes 不执行安装脚本，也不会穷举未声明的访问；`coverage.static.missing` 显示未评估。看到 Electron / Playwright 包名只是复核提醒，不会自动取得安装器、浏览器 revision 或系统依赖。
- **何时需要静态服务：** npm tarball（包括按 OS/CPU/libc 分发的平台包）放 npm 私服即可。Electron 二进制、Playwright 浏览器等非 npm 文件，若使用内网镜像 URL，就部署至已有静态服务；若按厂商文档预置目标本机缓存，则不必新增静态主机。`export-resources` 只校验、整理和生成映射，不负责上传或自动配置厂商工具。

## 3. 搬运后离线入库

将完整 bundle、Hermes 自身运行环境一起搬入内网。不要只拷贝 node_modules 中某一平台的可选包。

```sh
nova-hm verify --bundle ./bundle-20261101
nova-hm plan --bundle ./bundle-20261101 --registry https://npm.intranet.example/
nova-hm import --bundle ./bundle-20261101 --registry https://npm.intranet.example/ --run ./runs/batch-20261101
nova-hm export-resources --bundle ./bundle-20261101 --out ./static-stage --base-url http://static.intranet.example/vendor/
```

`export-resources` 完全离线运行，先校验冻结批次，复制 `resources/<id>/...` 到新暂存目录，生成 `resource-map.json`（每文件 SHA/URL、版本、平台及环境提示）。保持该相对目录部署到 `base-url`，或在服务端显式映射路径。它不会联系该 URL，也不会上传、覆盖现有服务或运行 shell 配置。输出目录已存在就拒绝；要重试请指定新目录。导出失败清理本次新建输出，不触碰原 bundle。

npm registry 示例使用 HTTPS。回环测试允许 HTTP；非回环 HTTP 仅在精确地址显式授权时匿名使用，不传凭据。认证发布应走可信 HTTPS。

npm 导入仍使用已有可续跑 run 状态、精确版本内容检查与临时 tag；同名同版本不同字节阻断，不能覆盖私服。正式 tag 在真实验收后按原流程 `promote`。资源服务的冲突/原子发布由既有部署工具负责，不能把本地导出称为部署成功。

## 4. 验收必须按目标环境进行

1. 用空 npm 缓存，在隔离/断外网机器安装项目。保留 npm 锁和工具版本；检查锁中的私有 URL 是否仍指向外部自定义源，必要时走可审查迁移，不能只改 registry 假设全部重定向。
2. 观察 DNS/网络出口与静态服务日志。安装成功不等于运行不外联，需要启动工具及关键功能。
3. 分别验证 Windows x64、实际使用的 Linux x64/ARM64、glibc/musl；Node ABI 相关包按项目 Node 版本验收。没有上游发行的目标包，不会凭空生成。
4. 生命周期脚本在采集和导入阶段禁用；目标环境安装时如需要脚本，先审查并配置内网源，不能永久 `--ignore-scripts` 后就宣称应用可用。
5. Electron 首次运行下载/缓存布局、Playwright 浏览器 revision 与系统动态库、Puppeteer/core 差异都需版本专用配置。这里提供显式清单接口，**还没有全自动厂商适配器**。参考 [Electron 安装](https://www.electronjs.org/docs/latest/tutorial/installation)、[Playwright 浏览器](https://playwright.dev/docs/browsers)、[Puppeteer 配置](https://pptr.dev/guides/configuration)。

## 5. 当前支持边界

- Git、任意 file/alias 等非 registry 根规格或元数据边仍显式阻断；项目锁的受控 workspace/本地 TGZ 例外见上文；没有擅自重写第三方 package.json、执行 Git prepare 或把 Git 仓库冒充 npm 原始制品。URL 锁条目沿用已有回源身份核验，不等于任意私有 URL 包迁移。
- 可选 peer 未选中的不自动添加；已解析 peer 跟随 npm 锁。`--legacy-peer-deps` 等受控参数仍显式记录。
- 当前实现不新增原生 Windows 工具支持，按原项目要求在 WSL/Linux/macOS 使用；采集 Windows 平台文件不等于工具自身在 Windows 原生运行已通过。
- Hermes 本身仍需 Node、已验证 npm 11.19.0、系统 tar 和自身 dependencies。联网环境 `npm ci --ignore-scripts`、`npm run build` 后应另备其生产依赖/运行工具，内网不得用联网 `npx` 临时获取。跨系统不要直接搬某一机器的开发 node_modules。此更新不包含系统 Node/npm/tar 安装器。
- SHA 校验保证内容一致，不代替供应商信任和漏洞/许可证审查。
