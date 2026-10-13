// 文件职责：扫描嵌套、scope 和 pnpm/Yarn store，按真实路径去重并保留 peer 上下文。
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { InventoryIssue, InstalledInstance } from '../types.js';
import { inside, inModules } from './paths.js';
import { readIdentity, packageContent } from './content.js';
export interface Scan {
  sourceRoot: string;
  allowed: string[];
  issues: InventoryIssue[];
  byPath: Map<string, InstalledInstance>;
  seenModules: Set<string>;
  stores: Set<string>;
}
const segment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;

export function reportIssue(
  scan: Scan,
  code: string,
  filename: string,
  message: string,
  extra: Partial<InventoryIssue> = {},
) {
  scan.issues.push({ code, path: filename, message, ...extra });
}

async function entries(scan: Scan, directory: string) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    reportIssue(scan, 'unreadable-directory', directory, error.message);
    return [];
  }
}

async function controlledDirectory(scan: Scan, filename: string) {
  const { allowed } = scan;
  try {
    const actual = await fs.realpath(filename);
    if (!inModules(actual) || !allowed.some((root) => inside(root, actual))) {
      reportIssue(
        scan,
        'external-link',
        filename,
        'Link target is outside the source tree and allowLinkRoots',
        { target: actual },
      );
      return;
    }
    if (!(await fs.stat(actual)).isDirectory()) {
      reportIssue(
        scan,
        'invalid-package-directory',
        filename,
        'Expected a package or layout directory',
      );
      return;
    }
    return actual;
  } catch (error) {
    reportIssue(
      scan,
      error.code === 'ENOENT' || error.code === 'ELOOP' ? 'broken-link' : 'unreadable-directory',
      filename,
      error.message,
    );
  }
}

// 按真实路径去重，但保留所有安装位置及可取得的 peer 上下文。
async function scanPackage(scan: Scan, location: string, context?: string) {
  const { byPath, sourceRoot } = scan;
  const actual = await controlledDirectory(scan, location);
  if (!actual) return;
  const previous = byPath.get(actual);
  if (previous) {
    if (!previous.locations.includes(location)) previous.locations.push(location);
    if (context && !previous.peerContext) previous.peerContext = context;
    return;
  }
  let packageJson;
  try {
    packageJson = await readIdentity(actual);
  } catch (error) {
    reportIssue(
      scan,
      error.code === 'ENOENT' ? 'missing-package-json' : error.code || 'invalid-package-json',
      location,
      error.message,
    );
    return;
  }
  const instance: InstalledInstance = {
    id: `instance-${createHash('sha256').update(actual).digest('hex').slice(0, 24)}`,
    path: actual,
    sourceRoot,
    locations: [location],
    name: packageJson.name,
    version: packageJson.version,
    packageJson,
    contentHash: null,
    ...(context ? { peerContext: context } : {}),
  };
  byPath.set(actual, instance);
  try {
    instance.contentHash = await packageContent(actual);
  } catch (error) {
    reportIssue(scan, error.code || 'unreadable-package-content', actual, error.message, {
      instanceId: instance.id,
    });
  }
  const nested = path.join(actual, 'node_modules');
  try {
    await fs.lstat(nested);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    reportIssue(scan, 'unreadable-directory', nested, error.message);
    return;
  }
  await scanModules(scan, nested, context);
}

// store 文件夹名只作为上下文；包身份始终读取实体 package.json。
async function scanStore(scan: Scan, location: string, kind: string) {
  const { stores } = scan;
  const actual = await controlledDirectory(scan, location);
  if (!actual) return;
  stores.add(kind);
  for (const entry of await entries(scan, actual)) {
    if (entry.name === 'node_modules') await scanModules(scan, path.join(actual, entry.name));
    else if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
      const group = await controlledDirectory(scan, path.join(actual, entry.name));
      if (!group) continue;
      const nested = path.join(group, 'node_modules');
      try {
        await fs.lstat(nested);
      } catch (error) {
        if (error.code === 'ENOENT') continue; // store 元数据目录不作为包实例。
        reportIssue(scan, 'unreadable-directory', nested, error.message);
        continue;
      }
      await scanModules(scan, nested, `${kind}:${entry.name}`);
    }
  }
}

export async function scanModules(scan: Scan, location: string, context?: string) {
  const { seenModules } = scan;
  const actual = await controlledDirectory(scan, location);
  if (!actual || seenModules.has(actual)) return;
  seenModules.add(actual);
  for (const entry of await entries(scan, actual)) {
    const filename = path.join(location, entry.name);
    if (entry.name === '.pnpm' || entry.name === '.store') {
      await scanStore(scan, filename, entry.name === '.pnpm' ? 'pnpm' : 'yarn-store');
    } else if (entry.name.startsWith('@') && segment.test(entry.name.slice(1))) {
      const scope = await controlledDirectory(scan, filename);
      if (!scope) continue;
      for (const child of await entries(scan, scope)) {
        if (segment.test(child.name) && (child.isDirectory() || child.isSymbolicLink()))
          await scanPackage(scan, path.join(filename, child.name), context);
      }
    } else if (segment.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
      await scanPackage(scan, filename, context);
    }
  }
}
