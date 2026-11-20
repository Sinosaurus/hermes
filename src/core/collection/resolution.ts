// 文件职责：校验 npm 锁文件与受控参数，在临时目录解析项目或批量根包。
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceEntry, PackageJson, NpmLock, LockEntry } from '../types.js';
import type { Bundle } from './bundle.js';
import { fileSpec, localPath, stageLocalInputs } from './local-inputs.js';
import type { LocalInput, LocalLockInputs } from './local-inputs.js';
import {
  registrySpec,
  validateIdentity,
  readJson,
  safePath,
  writeJson,
  npmCommand,
} from '../../lib/index.js';
export interface ResolvedInput {
  packageJson: PackageJson;
  lock: NpmLock;
  lockName: string;
  parsed: ReturnType<typeof entriesFromLock>;
  context: string;
  localInputs?: LocalInput[];
}

export function validateInstallFlags(flags: string[]) {
  const allowed = new Set([
    '--legacy-peer-deps',
    '--strict-peer-deps',
    '--install-links=true',
    '--install-links=false',
  ]);
  if (!Array.isArray(flags) || flags.some((flag) => !allowed.has(flag)))
    throw new Error(
      'Supported install flags: --legacy-peer-deps, --strict-peer-deps, --install-links=true/false',
    );
  if (flags.includes('--legacy-peer-deps') && flags.includes('--strict-peer-deps'))
    throw new Error('Conflicting peer dependency flags');
  if (flags.includes('--install-links=true') && flags.includes('--install-links=false'))
    throw new Error('Conflicting install-links flags');
  return [...new Set(flags)];
}

function packageAt(location: string, entry: LockEntry) {
  return entry.name || location.split('node_modules/').at(-1)!;
}

export function entriesFromLock(lock: NpmLock, { project = false } = {}) {
  if (
    ![2, 3].includes(lock.lockfileVersion) ||
    !lock.packages ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  )
    throw new Error('Only npm lockfile v2/v3 is supported');
  for (const location of Object.keys(lock.packages)) {
    if (
      location &&
      (!/^[a-zA-Z0-9@_./-]+$/.test(location) ||
        location.split('/').some((part) => !part || part === '.' || part === '..'))
    )
      throw new Error('Unsafe lockfile package location');
  }
  const entries: SourceEntry[] = [],
    skipped: { location: string; reason: string }[] = [];
  const local: LocalLockInputs = { workspaces: [], tarballs: [] };
  const workspaces = new Set<string>();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || !entry.link) continue;
    if (!project)
      throw new Error(`Workspace/file/link input needs an explicit migration: ${location}`);
    const target = localPath(entry.resolved, 'workspace');
    if (workspaces.has(target) || !Object.hasOwn(lock.packages, target))
      throw new Error(`Missing or ambiguous project workspace lock entry: ${location}`);
    workspaces.add(target);
    local.workspaces.push({ location, target });
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry.link || workspaces.has(location)) continue;
    const boundary = location.startsWith('node_modules/') ? 0 : location.indexOf('/node_modules/');
    if (boundary < 0 || (boundary > 0 && !workspaces.has(location.slice(0, boundary))))
      throw new Error(`Non-registry lock entry: ${location}`);
    if (entry.inBundle) {
      skipped.push({ location, reason: 'included-in-parent-tarball' });
      continue;
    }
    if (!entry.version && entry.optional && entry.peer) {
      skipped.push({ location, reason: 'optional-peer-not-selected' });
      continue;
    }
    const item = {
      name: packageAt(location, entry),
      version: entry.version,
      location,
      resolved: entry.resolved,
      integrity: entry.integrity,
    };
    validateIdentity(item);
    if (project && item.resolved?.startsWith('file:')) {
      const target = fileSpec(item.resolved);
      if (!target.endsWith('.tgz') || !item.integrity)
        throw new Error(`Project file input must be a .tgz with locked integrity: ${location}`);
      local.tarballs.push({ location, target, name: item.name, entry });
      continue;
    }
    if (item.resolved && !/^https?:\/\//.test(item.resolved))
      throw new Error(`Git/file/other source requires explicit migration: ${location}`);
    if (item.resolved) {
      const source = new URL(item.resolved);
      if (source.username || source.password || source.search || source.hash)
        throw new Error(
          `Lockfile resolved URL must not contain credentials, query or fragment: ${location}`,
        );
    }
    entries.push(item);
  }
  return { entries, skipped, local };
}

// 在隔离目录验证原锁；只复制校验后的本地清单/制品，不复制项目 npm 配置或业务源码。
export async function resolveProject(
  project: string,
  work: string,
  registry: string,
  installFlags: string[],
  bundle: Bundle,
): Promise<ResolvedInput> {
  project = await realpath(path.resolve(project));
  const packageJson = await readJson<PackageJson>(await safePath(project, 'package.json'));
  let lockName = 'npm-shrinkwrap.json';
  try {
    await stat(path.join(project, lockName));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    lockName = 'package-lock.json';
  }
  const lock = await readJson<NpmLock>(await safePath(project, lockName));
  const parsed = entriesFromLock(lock, { project: true });
  const localInputs = await stageLocalInputs(project, work, packageJson, lock, parsed.local);
  await writeJson(path.join(work, 'package.json'), packageJson);
  await writeJson(path.join(work, lockName), lock);
  await npmCommand(
    [
      'ci',
      '--dry-run',
      '--ignore-scripts',
      '--allow-git=none',
      '--no-audit',
      '--no-fund',
      ...installFlags,
    ],
    { cwd: work, registry },
  );
  bundle.manifest.roots.push({
    context: 'project',
    name: packageJson.name,
    version: packageJson.version,
  });
  return { packageJson, lock, lockName, parsed, localInputs, context: 'project' };
}

export async function resolveRoots(
  specs: string[],
  work: string,
  registry: string,
  installFlags: string[],
  bundle: Bundle,
): Promise<ResolvedInput[]> {
  const inputs = [];
  for (let i = 0; i < specs.length; i++) {
    bundle.report({
      phase: 'resolve',
      completed: i,
      total: specs.length,
      name: registrySpec(specs[i]),
    });
    const cwd = path.join(work, String(i));
    await mkdir(cwd);
    await writeJson(path.join(cwd, 'package.json'), {
      name: 'offline-npm-resolution',
      version: '1.0.0',
      private: true,
    });
    await npmCommand(
      [
        'install',
        specs[i],
        '--package-lock-only',
        '--save-exact',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...installFlags,
      ],
      { cwd, registry, packageName: registrySpec(specs[i]) },
    );
    const packageJson = await readJson<PackageJson>(path.join(cwd, 'package.json'));
    const lock = await readJson<NpmLock>(path.join(cwd, 'package-lock.json'));
    inputs.push({
      packageJson,
      lock,
      lockName: 'package-lock.json',
      parsed: entriesFromLock(lock),
      context: `root-${i + 1}`,
    });
    bundle.manifest.roots.push({ requested: specs[i], resolved: packageJson.dependencies });
    bundle.report({ phase: 'resolve', completed: i + 1, total: specs.length });
  }
  return inputs;
}
