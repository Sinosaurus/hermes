// 文件职责：编排只读安装树盘点、内容冲突检查和独立 staging 副本。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { InventoryIssue, InstalledInstance } from './types.js';
import { canonicalPath } from '../lib/index.js';
import { findModulesDirectory, inside, inModules, failure } from './installed/paths.js';
import { readIdentity, packageContent } from './installed/content.js';
import { scanModules, reportIssue } from './installed/scan.js';
export { findModulesDirectory } from './installed/paths.js';

/** 只读盘点已安装实例，不执行包代码，也不修改安装树。 */
export async function inventoryModules(
  modulesDir?: string,
  { allowLinkRoots = [] }: { allowLinkRoots?: string[] } = {},
) {
  const sourceRoot = await findModulesDirectory(modulesDir);
  if (!(await fs.stat(sourceRoot)).isDirectory())
    throw failure('invalid-modules-directory', 'node_modules must be a directory');
  const allowed = [sourceRoot];
  for (const root of allowLinkRoots) {
    const actual = await fs.realpath(path.resolve(root));
    if (!inModules(actual))
      throw failure('invalid-link-root', 'Link roots must be inside node_modules');
    if (!(await fs.stat(actual)).isDirectory())
      throw failure('invalid-link-root', `${root} must be a directory`);
    allowed.push(actual);
  }
  const issues: InventoryIssue[] = [];
  const byPath = new Map<string, InstalledInstance>();
  const seenModules = new Set<string>();
  const stores = new Set<string>();
  const scan = { sourceRoot, allowed, issues, byPath, seenModules, stores };

  await scanModules(scan, sourceRoot);
  const instances = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const variants = new Map<string, InstalledInstance[]>();
  for (const instance of instances) {
    instance.locations.sort();
    const key = `${instance.name}@${instance.version}`;
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key)!.push(instance);
  }
  for (const [key, values] of variants) {
    if (new Set(values.map((value) => value.contentHash).filter(Boolean)).size > 1) {
      reportIssue(
        scan,
        'content-conflict',
        values[0].path,
        `Different installed content for ${key}`,
        { instances: values.map((value) => value.id) },
      );
    }
  }
  return {
    sourceRoot,
    layout: stores.size > 1 ? 'mixed' : [...stores][0] || 'node-modules',
    instances,
    issues,
  };
}

/** 创建独立实体副本供禁钩子打包，始终保留原安装树。 */
export async function stageInstance(instance: InstalledInstance, destination: string) {
  const source = await fs.realpath(instance.path);
  // 盘点后目录可能被替换为链接；内容一致也不能放宽实体路径边界。
  if (source !== instance.path || !inModules(source))
    throw failure(
      'changed-package-path',
      'Source package path changed since inventory or is outside node_modules',
    );
  const packageJson = await readIdentity(source);
  if (packageJson.name !== instance.name || packageJson.version !== instance.version) {
    throw failure('changed-package-identity', 'Source package identity changed since inventory');
  }
  for (const field of ['bundledDependencies', 'bundleDependencies'] as const) {
    if (
      packageJson[field] !== undefined &&
      packageJson[field] !== false &&
      !(Array.isArray(packageJson[field]) && packageJson[field].length === 0)
    ) {
      throw failure(
        'unsupported-bundled-repack',
        'Bundled dependencies require the original tarball; installed bundle recovery is not implemented',
      );
    }
  }
  const target = await canonicalPath(destination);
  const protectedRoots = [
    source,
    ...(instance.sourceRoot ? [await fs.realpath(instance.sourceRoot)] : []),
  ];
  if (protectedRoots.some((root) => inside(root, target) || inside(target, root)))
    throw failure('unsafe-staging-path', 'Staging must be separate from the installed tree');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target); // 已有 staging 目录不覆盖。
  try {
    const hash = await packageContent(source, target);
    if (!instance.contentHash || hash !== instance.contentHash)
      throw failure('changed-package-content', 'Source package content changed since inventory');
    return target;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}
