// 文件职责：cac 命令定义：注册参数、帮助、默认值及互斥约束。
import { readFileSync } from 'node:fs';
import { cac, type CAC } from 'cac';
import type { CliAction, CliOptions } from './types.js';
import { DEFAULT_SOURCE_REGISTRY } from '../config.js';
import * as actions from './actions.js';
import { writeFailure } from './output.js';

const usageHints: Record<string, string> = {
  collect: '输入优先 packages.json，其次项目 npm 锁。',
  inventory: '自动向上查找最近的 node_modules；包实体必须在 node_modules 内。',
  recover: '自动向上查找最近的 node_modules；包实体必须在 node_modules 内。',
  plan: '发布地址读取当前 npm 配置，先配置可写私服。',
  import: '发布地址读取当前 npm 配置，先配置可写私服。',
};

const repeatedOptions = new Set(['package', 'allowHost', 'allowLinkRoot', 'installFlag']);
const booleanOptions = new Set(['json', 'repack', 'recovery', 'overwriteTags']);

/** 参考 Vite：单值选项取最后一次；本工具的批量选项保留全部值。 */
function normalizeOptions(options: CliOptions): CliOptions {
  const result: Record<string, unknown> = { ...options };
  for (const [key, value] of Object.entries(result)) {
    if (key === '--') {
      if (Array.isArray(value) && value.length) throw new Error('Unused args after --');
      delete result[key];
    } else if (repeatedOptions.has(key)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`--${key} requires a nonempty value for each occurrence`);
      }
    } else {
      const last = Array.isArray(value) ? value.at(-1) : value;
      if (booleanOptions.has(key)) {
        if (typeof last !== 'boolean') throw new Error(`--${key} must be a boolean flag`);
      } else if (typeof last !== 'string' || !last.trim()) {
        // shortcut: cac 会自动把纯数字转成 number；数字目录请写 ./123，升级支持保留原值的解析器后移除此限制。
        throw new Error(`--${key} must be a nonempty string; use ./123 for numeric paths`);
      }
      result[key] = last;
    }
  }
  return result;
}

/** 保留业务互斥规则；通用命令和参数检查交给 cac。 */
function validateOptions(name: string, options: CliOptions) {
  if (!['auto', 'plain', 'none'].includes(options.progress ?? 'auto'))
    throw new Error('--progress must be auto, plain or none');
  if (name === 'collect' && options.project && (options.package?.length || options.packagesFile)) {
    throw new Error('--project cannot be used with --package or --packages-file');
  }
  if (name === 'recover' && options.repack && options.registry)
    throw new Error('--registry cannot be used with --repack');
}

/** cac.parse 直接触发异步 action；在 action 内处理失败，避免遗漏 Promise 拒绝。 */
async function executeAction(name: string, action: CliAction, raw: CliOptions) {
  let options = raw;
  try {
    options = normalizeOptions(raw);
    validateOptions(name, options);
    await actions.runAction(action, options, name);
  } catch (error) {
    writeFailure(error, options);
    process.exitCode = 1;
  }
}

function registerCollectionCommands(cli: CAC) {
  cli
    .command('collect', '按项目锁文件或批量根包收集原始制品')
    .option('--project <dir>', '含 npm v2/v3 锁文件的项目')
    .option('--package <spec>', 'registry 根规格，可重复', { type: [] })
    .option('--packages-file <json>', '根规格 JSON 数组')
    .option('--out <dir>', '不存在的输出目录', { default: './bundle' })
    .option('--registry <url>', '源 registry', { default: DEFAULT_SOURCE_REGISTRY })
    .option('--resources <json>', '本地资源与审查记录')
    .option('--allow-host <host>', '额外 tarball 主机，可重复', { type: [] })
    .option(
      '--install-flag <flag>',
      '受控解析参数，可重复；使用 --install-flag=--legacy-peer-deps',
      { type: [] },
    )
    .action((options: CliOptions) => executeAction('collect', actions.collectAction, options));

  cli
    .command('inventory', '只读盘点嵌套 npm/Yarn/pnpm 安装树')
    .option('--node-modules <dir>', '安装树入口，默认从当前目录向上查找')
    .option('--out <json>', '不存在的盘点文件')
    .option('--allow-link-root <dir>', '其他 node_modules 内的链接实体目录，可重复', {
      type: [],
    })
    .action((options: CliOptions) => executeAction('inventory', actions.inventoryAction, options));

  cli
    .command('recover', '回源取原制品，或显式从安装树重打包')
    .option('--node-modules <dir>', '安装树入口，默认从当前目录向上查找')
    .option('--out <dir>', '不存在的输出目录', { default: './bundle' })
    .option('--registry <url>', '原始制品源 registry，默认 https://registry.npmjs.org/')
    .option('--repack', '独立副本禁钩子打包，使用专用恢复仓库')
    .option('--resources <json>', '本地资源与审查记录')
    .option('--allow-host <host>', '额外 tarball 主机，可重复', { type: [] })
    .option('--allow-link-root <dir>', '其他 node_modules 内的链接实体目录，可重复', {
      type: [],
    })
    .action((options: CliOptions) => executeAction('recover', actions.recoverAction, options));

  cli
    .command('verify', '校验冻结 bundle 的文件、摘要和包身份')
    .option('--bundle <dir>', '冻结交付目录', { default: './bundle' })
    .action((options: CliOptions) => executeAction('verify', actions.verifyAction, options));
}

function registerPublishingCommands(cli: CAC) {
  for (const [name, action] of [
    ['plan', actions.planAction],
    ['import', actions.importAction],
  ] as const) {
    const cmd = cli
      .command(
        name,
        name === 'plan' ? '只读检查目标内容和 tag 差异' : '临时 tag 导入精确版本，支持续跑',
      )
      .option('--bundle <dir>', '冻结交付目录', { default: './bundle' })
      .option('--registry <url>', '托管写端点，默认读取 npm registry 配置')
      .option('--read-registry <url>', '业务实际读端点，默认同写端点')
      .option('--recovery', '明确接受恢复制品及隔离恢复仓库');
    if (name === 'import')
      cmd.option('--run <dir>', 'bundle 外的运行状态目录', { default: './runs/default' });
    cmd.action((options: CliOptions) => executeAction(name, action, options));
  }

  cli
    .command('promote', '实际验收后提升正式 tag，清理本 run 临时 tag')
    .option('--run <dir>', '已有运行状态目录', { default: './runs/default' })
    .option('--acceptance <json>', '与批次和端点绑定的验收记录', { default: './acceptance.json' })
    .option('--overwrite-tags', '允许覆盖原有不同的正式 tag')
    .action((options: CliOptions) => executeAction('promote', actions.promoteAction, options));

  cli
    .command('rollback', '条件恢复 tag，保留已上传版本')
    .option('--run <dir>', '已有运行状态目录', { default: './runs/default' })
    .action((options: CliOptions) => executeAction('rollback', actions.rollbackAction, options));
}

/** 使用与 Vite 一致的 cac，所有命令共享全局帮助和结果输出选项。 */
export function createProgram() {
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const cli = cac('nova-hm')
    .option('--json', '始终输出完整 JSON，默认终端摘要、重定向 JSON')
    .option('--progress <mode>', 'stderr 进度：auto/plain/none', { default: 'auto' });

  registerCollectionCommands(cli);
  registerPublishingCommands(cli);
  for (const command of cli.commands) {
    command.example(`nova-hm ${command.name}`);
    command.example(usageHints[command.name] ?? '默认路径相对当前工作目录。');
  }
  cli.command('[command]', '显示帮助').action((command?: string) => {
    if (command) throw new Error(`Unknown command: ${command}`);
    cli.outputHelp();
  });
  cli.help((sections) => {
    sections.push({
      title: '使用说明',
      body: '默认路径相对当前工作目录。打包要求 Node >=22.12、npm 11.19.0、系统 tar。\n外网 collect/recover → 带入 bundle 和工具 → 内网 import → 实际验收后 promote。\n退出码：1 失败；2 有盘点问题或未完成的清理/回滚。',
    });
    return sections;
  });
  cli.version(version);
  return cli;
}
