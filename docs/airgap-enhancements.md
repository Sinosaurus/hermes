# 跨隔离网采集增强

这一版保留原有 `collect → verify → plan → import → 验收 → promote`，新增跨平台可选依赖补齐、显式远程资源下载和离线静态资源导出。**不自动执行安装脚本，不自动上传静态服务，不修改项目锁文件。**

## 1. 联网采集 npm 包

```sh
nova-hm collect --package oxlint@1.90.0 --all-platforms --resources ./resources.json --out ./bundle-20261101
# 或使用现有项目的 npm v2/v3 锁文件
nova-hm collect --project ./my-project --all-platforms --resources ./resources.json --out ./project-bundle
nova-hm verify --bundle ./bundle-20261101
```

`--all-platforms` 明确遍历每个已选版本的 registry 元数据，补齐 `optionalDependencies`，不按采集机器的 OS/CPU 过滤。保留原锁中已选精确版本；缺失项在临时目录用禁脚本的 npm 锁解析，保存额外输入和精确版本。新增平台包的必需依赖缺失、可选包无法解析、身份/范围不符都会失败，不能静默给出“全平台完成”。

`inputs/platform-closure.json` 记录父包、请求范围、锁中/补充解析来源、补充上下文，以及上游声明的 OS/CPU/libc。原项目锁保持原样。**此报告是采集证据，不是所有目标平台的运行验收证书。** 保持 `manifest.targets` 原有采集目标语义，不把上游平台声明冒充实测。

默认不加该选项时仍只收锁中条目，兼容原行为。非精确范围在采集时解析并冻结，换时间重采可能选中不同版本，请保留 bundle 和 report。不同上下文的同名不同版本均保留；相同包版本仍走既有 tarball 完整性去重/冲突校验。

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

## 3. 搬运后离线入库

将完整 bundle、Hermes 自身运行环境一起搬入内网。不要只拷贝 node_modules 中某一平台的可选包。

```sh
nova-hm verify --bundle ./bundle-20261101
nova-hm plan --bundle ./bundle-20261101 --registry https://npm.intranet.example/
nova-hm import --bundle ./bundle-20261101 --registry https://npm.intranet.example/ --run ./runs/batch-20261101
nova-hm export-resources --bundle ./bundle-20261101 --out ./static-stage --base-url http://static.intranet.example/vendor/
```

`export-resources` 完全离线运行，先校验冻结批次，复制 `resources/<id>/...` 到新暂存目录，生成 `resource-map.json`（每文件 SHA/URL、版本、平台及环境提示）。保持该相对目录部署到 `base-url`，或在服务端显式映射路径。它不会联系该 URL，也不会上传、覆盖现有服务或运行 shell 配置。输出目录已存在就拒绝；要重试请指定新目录。导出失败清理本次新建输出，不触碰原 bundle。

npm registry 示例使用 HTTPS，沿用既有安全策略：仅回环测试允许 HTTP。若实际私服只有 HTTP，需先明确单独的内网端点安全方案，本次没有默默放宽协议校验。

npm 导入仍使用已有可续跑 run 状态、精确版本内容检查与临时 tag；同名同版本不同字节阻断，不能覆盖私服。正式 tag 在真实验收后按原流程 `promote`。资源服务的冲突/原子发布由既有部署工具负责，不能把本地导出称为部署成功。

## 4. 验收必须按目标环境进行

1. 用空 npm 缓存，在隔离/断外网机器安装项目。保留 npm 锁和工具版本；检查锁中的私有 URL 是否仍指向外部自定义源，必要时走可审查迁移，不能只改 registry 假设全部重定向。
2. 观察 DNS/网络出口与静态服务日志。安装成功不等于运行不外联，需要启动工具及关键功能。
3. 分别验证 Windows x64、实际使用的 Linux x64/ARM64、glibc/musl；Node ABI 相关包按项目 Node 版本验收。没有上游发行的目标包，不会凭空生成。
4. 生命周期脚本在采集和导入阶段禁用；目标环境安装时如需要脚本，先审查并配置内网源，不能永久 `--ignore-scripts` 后就宣称应用可用。
5. Electron 首次运行下载/缓存布局、Playwright 浏览器 revision 与系统动态库、Puppeteer/core 差异都需版本专用配置。这里提供显式清单接口，**还没有全自动厂商适配器**。参考 [Electron 安装](https://www.electronjs.org/docs/latest/tutorial/installation)、[Playwright 浏览器](https://playwright.dev/docs/browsers)、[Puppeteer 配置](https://pptr.dev/guides/configuration)。

## 5. 当前支持边界

- Git/工作区/file/alias 等非 registry 根规格或元数据边仍显式阻断；没有擅自重写第三方 package.json、执行 Git prepare 或把 Git 仓库冒充 npm 原始制品。URL 锁条目沿用已有回源身份核验，不等于任意私有 URL 包迁移。
- 可选 peer 未选中的不自动添加；已解析 peer 跟随 npm 锁。`--legacy-peer-deps` 等受控参数仍显式记录。
- 当前实现不新增原生 Windows 工具支持，按原项目要求在 WSL/Linux/macOS 使用；采集 Windows 平台文件不等于工具自身在 Windows 原生运行已通过。
- Hermes 本身仍需 Node、已验证 npm 11.19.0、系统 tar 和自身 dependencies。联网环境 `npm ci --ignore-scripts`、`npm run build` 后应另备其生产依赖/运行工具，内网不得用联网 `npx` 临时获取。跨系统不要直接搬某一机器的开发 node_modules。此更新不包含系统 Node/npm/tar 安装器。
- SHA 校验保证内容一致，不代替供应商信任和漏洞/许可证审查。
