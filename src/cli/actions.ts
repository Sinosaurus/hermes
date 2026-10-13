// 文件职责：命令适配层：映射参数、调用业务、管理进度并输出 JSON。
import type { CliAction, CliOptions } from './types.js';
import type { OnProgress, VerifiedBundle } from '../core/types.js';
import { DEFAULT_SOURCE_REGISTRY } from '../config.js';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { collect, recover } from '../core/collect.js';
import { inventoryModules } from '../core/recovery.js';
import { planImport, importBundle, promoteRun, rollbackRun } from '../core/publish.js';
import { readJson, verifyBundle, writeJson, npmCommand, normalizeRegistry } from '../lib/index.js';
import { createProgress } from './progress.js';
import { writeResult } from './output.js';

function bundleSummary(directory: string, verified: VerifiedBundle) {
  const { manifest, manifestDigest, stats } = verified;
  return {
    bundle: path.resolve(directory),
    batchId: manifest.batchId,
    manifestDigest,
    packages: manifest.packages.length,
    resources: manifest.resources.length,
    resourceReview: manifest.resourceReview,
    targets: manifest.targets,
    stats,
  };
}

/** 合并文件和重复参数；只去重根规格，依赖身份去重仍由收集流程负责。 */
export async function packageInputs(options: CliOptions) {
  const repeated = options.package ?? [];
  if (!options.packagesFile) return repeated;
  const list = await readJson(path.resolve(options.packagesFile));
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error('--packages-file must contain a nonempty JSON array of package specifications');
  }
  return [...new Set([...list, ...repeated])];
}

async function exists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 显式输入优先；无输入时使用当前目录包列表，其次使用项目 npm 锁。 */
export async function collectDefaults(options: CliOptions, cwd = process.cwd()) {
  if (options.project || options.package?.length || options.packagesFile) return options;
  if (await exists(path.join(cwd, 'packages.json')))
    return { ...options, packagesFile: path.join(cwd, 'packages.json') };
  if (
    (await exists(path.join(cwd, 'npm-shrinkwrap.json'))) ||
    (await exists(path.join(cwd, 'package-lock.json')))
  )
    return { ...options, project: cwd };
  throw new Error(
    'No input found: create packages.json, use --package/--project, or use recover for node_modules',
  );
}

export async function collectAction(options: CliOptions, onProgress: OnProgress) {
  options = await collectDefaults(options);
  const verified = await collect({
    out: options.out ?? './bundle',
    project: options.project,
    specs: await packageInputs(options),
    registry: options.registry,
    allowHosts: options.allowHost,
    resourcesFile: options.resources,
    installFlags: options.installFlag,
    onProgress,
  });
  return bundleSummary(options.out ?? './bundle', verified);
}

export async function inventoryAction(options: CliOptions, onProgress: OnProgress) {
  onProgress({ phase: 'inventory', completed: 0, total: 0 });
  const report = await inventoryModules(options.nodeModules, {
    allowLinkRoots: options.allowLinkRoot,
  });
  onProgress({
    phase: 'inventory',
    completed: report.instances.length,
    total: report.instances.length,
  });
  if (options.out) await writeJson(path.resolve(options.out), report, { exclusive: true });
  return report;
}

export async function recoverAction(options: CliOptions, onProgress: OnProgress) {
  const verified = await recover({
    modules: options.nodeModules,
    out: options.out ?? './bundle',
    registry: options.repack ? undefined : (options.registry ?? DEFAULT_SOURCE_REGISTRY),
    repack: options.repack,
    allowHosts: options.allowHost,
    allowLinkRoots: options.allowLinkRoot,
    resourcesFile: options.resources,
    onProgress,
  });
  return bundleSummary(options.out ?? './bundle', verified);
}

export async function verifyAction(options: CliOptions) {
  return bundleSummary(
    options.bundle ?? './bundle',
    await verifyBundle(options.bundle ?? './bundle'),
  );
}

/** 省略发布端点时读取 npm 配置，但拒绝把默认公网源当作写入目标。 */
export async function targetRegistry(
  value?: string,
  readConfig = () => npmCommand(['config', 'get', 'registry']),
) {
  if (value) return normalizeRegistry(value);
  const registry = normalizeRegistry((await readConfig()).trim());
  if (new URL(registry).hostname === 'registry.npmjs.org') {
    throw new Error(
      'Configure an intranet npm registry or pass --registry; the default public registry is not a publish target',
    );
  }
  return registry;
}

async function registryOptions(options: CliOptions, onProgress: OnProgress) {
  return {
    registry: await targetRegistry(options.registry),
    readRegistry: options.readRegistry,
    runDir: options.run,
    recovery: options.recovery,
    onProgress,
  };
}

export const planAction = async (options: CliOptions, onProgress: OnProgress) =>
  planImport(options.bundle ?? './bundle', await registryOptions(options, onProgress));
export const importAction = async (options: CliOptions, onProgress: OnProgress) =>
  importBundle(options.bundle ?? './bundle', await registryOptions(options, onProgress));
export const promoteAction = (options: CliOptions, onProgress: OnProgress) =>
  promoteRun(options.run ?? './runs/default', {
    acceptanceFile: options.acceptance,
    overwriteTags: options.overwriteTags,
    onProgress,
  });
export const rollbackAction = (options: CliOptions, onProgress: OnProgress) =>
  rollbackRun(options.run ?? './runs/default', { onProgress });

/** 统一输出边界：进度走 stderr，结果走 stdout，异常也必须恢复终端状态。 */
export async function runAction(action: CliAction, options: CliOptions, name: string) {
  const progress = createProgress({ mode: options.progress });
  try {
    const output = await action(options, (event) => progress.update(event));
    if (
      ('issues' in output && output.issues.length) ||
      ('cleanupPending' in output && output.cleanupPending?.length) ||
      ('rollbackPending' in output && output.rollbackPending?.length)
    )
      process.exitCode = 2;
    writeResult(name, output, options);
  } finally {
    progress.stop();
  }
}
