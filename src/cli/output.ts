// 文件职责：终端中文结果摘要、机器可读 JSON 及常见错误的操作提示。
import type { CliOptions, CommandResult, OutputStream } from './types.js';
import type { TransferStats } from '../core/types.js';
import { stripVTControlCharacters } from 'node:util';
import { PACK_NPM_VERSION, DEFAULT_RUN_DIR } from '../config.js';
import { formatBytes } from './progress.js';
import { redact } from '../lib/security.js';

const states: Record<string, string> = {
  'versions-ready': '版本已上传就绪，正式 tag 尚未提升',
  promoted: '正式 tag 已提升',
  'rolled-back': 'tag 已回滚，已上传版本保留',
  'rollback-pending': '回滚尚未完成，请处理待恢复项后重试',
};

function transferSummary(stats?: TransferStats) {
  if (!stats) return [];
  return [
    `本次下载/校验 ${stats.downloaded ?? 0} 个 (${formatBytes(stats.downloadBytes)})；上传 ${stats.uploaded ?? 0} 个 (${formatBytes(stats.uploadBytes)})；复用 ${stats.reused ?? 0} 个${stats.repacked ? `；重打包 ${stats.repacked} 个` : ''}`,
  ];
}

export function resultSummary(action: string, result: CommandResult, options: CliOptions = {}) {
  let lines;
  if ('exportDirectory' in result) {
    lines = [
      `资源导出完成：${result.resources} 项资源，${result.files} 个文件`,
      `暂存目录：${result.exportDirectory}`,
      '未上传到静态服务；请按 resource-map.json 配置并实际断网验收。',
      '静态主机仅在安装器需要 URL 下载时必需；也可按厂商规范预置本地缓存。',
      '下一步：部署暂存目录或分发缓存，配置安装器镜像地址，再在目标 OS 上验收。',
    ];
  } else if ('bundle' in result) {
    lines = [
      `${action === 'verify' ? '校验通过' : '收集完成'}：${result.packages} 个包，${result.resources} 项资源`,
      `交付目录：${result.bundle}`,
      `资源审查：${result.resourceReview?.status === 'reviewed' ? '已完成（人工声明，不等于自动检测完整）' : '待审查 / 未配置，不能推断没有额外资源'}`,
      '下一步：nova-hm plan --bundle <交付目录> --registry <可写私服地址>',
      '跨平台采集：collect --all-platforms 补齐 npm 声明的 optional 包；不执行安装脚本。',
      '静态资源：Electron/Playwright 等安装器下载不自动包含；需 resources.json 或厂商缓存方案。',
    ];
    if (result.coverage) {
      const { npm, static: resources } = result.coverage;
      lines.push(
        `npm 平台采集：${npm.mode === 'registry-expanded' ? '已启用 --all-platforms' : '未扩展平台闭包；如需多平台请使用 --all-platforms'}`,
      );
      if (npm.status === 'metadata-only-not-runtime-tested') {
        lines.push('常用目标（仅元数据匹配包数，不代表安装通过；0 不等于缺包）：');
        lines.push(
          ...npm.profiles.map(
            (profile) =>
              `  ${profile.os}/${profile.cpu}${profile.libc ? `/${profile.libc}` : ''}：${profile.matchingPlatformPackages ?? '未评估'}`,
          ),
        );
      }
      lines.push(
        `静态资源已收录：${resources.entries.length} 项；缺失：未评估；自动检测：未执行。`,
      );
      if (resources.entries.length)
        lines.push(`已收录标识：${resources.entries.map((entry) => entry.id).join('、')}`);
      if (resources.knownRuntimePackages.length)
        lines.push(
          `需核对安装器资源：${resources.knownRuntimePackages.join('、')}（版本、目标平台、缓存/镜像配置需单独验收）。`,
        );
      lines.push('已声明文件缺失或校验不符会阻断；未声明的下载不能自动判定完整。');
    }
  } else if ('instances' in result) {
    lines = [
      `盘点完成：${result.instances.length} 个包实例；布局 ${result.layout}；${result.issues.length} 个问题`,
      `安装树：${result.sourceRoot}`,
    ];
    lines.push(...result.issues.slice(0, 5).map((issue) => `${issue.path}：${issue.message}`));
    if (result.issues.length > 5) lines.push('更多问题请加 --json 查看完整记录。');
  } else if ('tagChanges' in result) {
    const pending = result.packages.filter((pkg) => pkg.action === 'publish').length;
    lines = [
      `预检完成：待上传 ${pending} 个；可复用 ${result.packages.length - pending} 个；tag 覆盖冲突 ${result.tagChanges.filter((tag) => tag.conflict).length} 个`,
      `目标仓库：${result.registry}`,
      '只读预检，不代表已发布。下一步：nova-hm import --bundle <交付目录> --registry <可写私服地址>',
    ];
  } else {
    lines = [
      states[result.phase] || result.phase,
      `目标仓库：${result.registry}`,
      `运行记录：${options.run ?? DEFAULT_RUN_DIR}`,
    ];
    if (result.phase === 'versions-ready')
      lines.push(
        '下一步：新目录 + 空缓存安装精确版本并运行验证；记录 acceptance 后再执行 nova-hm promote。',
      );
    if (result.cleanupPending?.length)
      lines.push(`待清理临时 tag：${result.cleanupPending.length} 项，请使用同一 run 重试。`);
    if (result.rollbackPending?.length)
      lines.push(
        `待恢复 tag：${result.rollbackPending.length} 项，请检查外部变更后重试 rollback。`,
      );
  }
  return [...lines, ...transferSummary('stats' in result ? result.stats : undefined)].join('\n');
}

/** 管道保留原 JSON 契约；人工终端只显示摘要，--json 可显式取得完整记录。 */
export function writeResult(
  action: string,
  result: CommandResult,
  options: CliOptions = {},
  stream: OutputStream = process.stdout,
) {
  const text =
    options.json || !stream.isTTY
      ? JSON.stringify(result, null, 2)
      : stripVTControlCharacters(resultSummary(action, result, options));
  stream.write(`${text}\n`);
}

function errorHint(error: Error & { code?: string; npmCode?: string }) {
  if (
    error.name === 'CACError' ||
    /Unknown (command|option)|--.*(?:cannot be used|must be|requires)|too many arguments|Unused args/i.test(
      error.message,
    )
  )
    return '执行对应命令的 --help 查看参数与示例。';
  if (error.code === 'EEXIST')
    return '已有文件或目录不会覆盖，请通过 --out 指定新输出路径；上传续跑保留原 --run。';
  if (error.code === 'ENOENT')
    return '检查报错路径；先用 collect 或 recover 生成 bundle，验收文件需另行准备。';
  if (error.code === 'unsafe-output-path')
    return '通过 --out 指定原 node_modules 和许可链接实体目录之外的输出路径。';
  if (
    [
      'missing-node-modules',
      'invalid-modules-directory',
      'invalid-link-root',
      'changed-package-path',
    ].includes(error.code ?? '')
  )
    return '在业务目录执行 recover/inventory，或指定真实的 --node-modules；包实体必须位于 node_modules 内。';
  if (error.message.includes('No input found'))
    return '在业务目录准备 packages.json 或 npm 锁文件；只有 node_modules 时执行 recover。';
  if (error.message.includes('default public registry'))
    return '配置私服 npm registry，或通过 --registry 指定可写私服地址。';
  if (/\b(ENEEDAUTH|E401|E403)\b/.test(error.npmCode ?? error.message))
    return '检查私服登录与发布权限；公网 HTTP 模式不发送凭据，请改用可信 HTTPS 或安全回环隧道。';
  if (error.message.includes('verified npm'))
    return `打包机需使用已验证的 npm ${PACK_NPM_VERSION}，请检查当前 npm --version。`;
  if (error.message.includes('Recovery blocked'))
    return '按每项报错路径处理断链、外部源码链接或内容冲突，然后重试 recover。';
  return '保留现有交付包和 run 记录，按报错原因修复后重试；参数说明见 --help。';
}

export function writeFailure(
  cause: unknown,
  options: CliOptions = {},
  stream: OutputStream = process.stderr,
  terminal = process.stdout.isTTY,
) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const record = { status: 'failed', message: redact(error.message), hint: errorHint(error) };
  stream.write(
    options.json || !terminal
      ? `${JSON.stringify(record)}\n`
      : `失败：${stripVTControlCharacters(record.message)}\n处理建议：${record.hint}\n`,
  );
}
