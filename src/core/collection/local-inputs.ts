// 文件职责：保留项目内的本地引用，生成只含 npm dry-run 所需文件的隔离副本。
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import npa from 'npm-package-arg';
import type { LockEntry, NpmLock, PackageIdentity, PackageJson } from '../types.js';
import {
  assertIntegrity,
  fileHash,
  readArtifact,
  readJson,
  validateIdentity,
  writeJson,
} from '../../lib/index.js';

export type LocalInput = PackageIdentity &
  (
    | {
        kind: 'workspace';
        path: string;
        locations: string[];
      }
    | {
        kind: 'file-tarball';
        path: string;
        locations: string[];
        sha256: string;
        integrity: string;
      }
  );
export interface LocalLockInputs {
  workspaces: { location: string; target: string }[];
  tarballs: { location: string; target: string; name: string; entry: LockEntry }[];
}

export function localPath(value: unknown, kind: string) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9@_./-]+$/.test(value) ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === 'node_modules' ||
          part.startsWith('.'),
      )
  )
    throw new Error(`Unsafe project local ${kind} path`);
  return value;
}

export function fileSpec(value: string) {
  return localPath(value.slice('file:'.length).replace(/^\.\//, ''), 'file');
}

async function confined(root: string, relative: string, type: 'directory' | 'file') {
  let current = root;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const item = await lstat(current);
    if (
      item.isSymbolicLink() ||
      (index !== relative.split('/').length - 1 || type === 'directory'
        ? !item.isDirectory()
        : !item.isFile())
    )
      throw new Error(`Project local input must be a confined regular ${type}: ${relative}`);
  }
  if (!(await realpath(current)).startsWith(root.endsWith(path.sep) ? root : root + path.sep))
    throw new Error(`Project local input escapes root: ${relative}`);
  return current;
}

function workspacePatterns(workspaces: unknown): string[] {
  if (workspaces === undefined) return [];
  const patterns =
    !Array.isArray(workspaces) &&
    workspaces &&
    typeof workspaces === 'object' &&
    'packages' in workspaces
      ? workspaces.packages
      : workspaces;
  if (
    !Array.isArray(patterns) ||
    patterns.some((p) => {
      if (typeof p !== 'string') return true;
      try {
        localPath(
          p
            .split('/')
            .map((s: string) => (s === '*' ? 'hermes-workspace-part' : s))
            .join('/'),
          'workspace declaration',
        );
        return false;
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      'Only project-relative literal workspace paths and whole-segment * patterns are supported',
    );
  return patterns;
}

async function expandWorkspaces(root: string, patterns: string[]) {
  const directories = new Set<string>();
  let visits = 0;
  async function visit(parent: string, parts: string[]) {
    if (++visits > 10_000) throw new Error('Workspace discovery limit exceeded');
    if (!parts.length) {
      try {
        await confined(root, `${parent}/package.json`, 'file');
        directories.add(parent);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return;
    }
    const [segment, ...rest] = parts;
    const prefixed = (name: string) => (parent ? `${parent}/${name}` : name);
    if (segment === '*') {
      const folder = parent ? await confined(root, parent, 'directory') : root;
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.name.toLowerCase() === 'node_modules') continue;
        if (item.isSymbolicLink())
          throw new Error(`Symlink under project workspace pattern: ${prefixed(item.name)}`);
        if (item.isDirectory()) await visit(localPath(prefixed(item.name), 'workspace'), rest);
      }
    } else {
      const next = prefixed(segment);
      try {
        await confined(root, next, 'directory');
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      await visit(next, rest);
    }
  }
  for (const pattern of patterns) await visit('', pattern.split('/'));
  return directories;
}

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
function checkDependencies(
  data: object,
  parent: string,
  locals: Map<string, PackageIdentity>,
  { prefix = '', uses = undefined }: { prefix?: string; uses?: Set<string> } = {},
) {
  const record = data as Record<string, unknown>;
  if (record.overrides !== undefined && localOverrides(record.overrides))
    throw new Error('Non-registry override is not supported for project collection');
  for (const field of dependencyFields) {
    const group = record[field];
    if (group === undefined) continue;
    if (!group || typeof group !== 'object' || Array.isArray(group))
      throw new Error(`Invalid ${field} in ${parent}`);
    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec !== 'string') throw new Error(`Invalid dependency specification: ${name}`);
      if (spec.startsWith('file:')) {
        const source = fileSpec(spec);
        const target = prefix ? `${prefix}/${source}` : source;
        const identity = locals.get(target);
        if (!identity || identity.name !== name)
          throw new Error(`Dependency ${name} is not a validated project-local input: ${parent}`);
        uses?.add(target);
        continue;
      }
      assertRegistryDependency(name, spec);
    }
  }
}

function assertRegistryDependency(name: string, value: string) {
  const parsed = npa.resolve(name, value);
  if (!(parsed.type === 'alias' ? parsed.subSpec?.registry : parsed.registry))
    throw new Error(`Unsupported non-registry dependency ${name}`);
}

function localOverrides(value: unknown, depth = 0): boolean {
  if (depth > 100) return true;
  if (typeof value === 'string') {
    if (value.startsWith('$')) return false; // 对项目依赖的引用；其原值仍会独立校验。
    try {
      assertRegistryDependency('offline-validation', value);
      return false;
    } catch {
      return true;
    }
  }
  return (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((x) => localOverrides(x, depth + 1))
  );
}

export async function stageLocalInputs(
  project: string,
  work: string,
  packageJson: PackageJson,
  lock: NpmLock,
  parsed: LocalLockInputs,
) {
  const locales = new Map<string, PackageIdentity>();
  const localInputs = new Map<string, LocalInput>();
  const workspaceJson = new Map<string, PackageJson>();
  const vendorJson: PackageJson[] = [];
  const workspaces = await expandWorkspaces(project, workspacePatterns(packageJson.workspaces));
  for (const { location, target } of parsed.workspaces) {
    if (!workspaces.has(target))
      throw new Error(`Workspace link is not a declared project workspace: ${location}`);
    const locked = lock.packages[target];
    const manifest =
      workspaceJson.get(target) ??
      (await readJson<PackageJson>(await confined(project, `${target}/package.json`, 'file')));
    validateIdentity(manifest);
    if (
      manifest.workspaces !== undefined ||
      !locked ||
      locked.link ||
      locked.resolved !== undefined ||
      locked.version !== manifest.version ||
      (locked.name ?? location.slice('node_modules/'.length)) !== manifest.name ||
      location !== `node_modules/${manifest.name}`
    )
      throw new Error(`Workspace manifest does not match lock: ${location}`);
    workspaceJson.set(target, manifest);
    locales.set(target, manifest);
    localInputs.set(target, {
      kind: 'workspace',
      path: target,
      locations: [location],
      name: manifest.name,
      version: manifest.version,
    });
  }
  if (workspaceJson.size !== workspaces.size)
    throw new Error(
      'Project workspace declarations differ from the lock; update the lock before collection',
    );

  for (const { location, target, name, entry } of parsed.tarballs) {
    const existing = localInputs.get(target);
    if (existing) {
      if (
        existing.kind !== 'file-tarball' ||
        existing.integrity !== entry.integrity ||
        existing.name !== name ||
        existing.version !== entry.version
      )
        throw new Error(`Conflicting project-local tarball lock entries: ${location}`);
      existing.locations.push(location);
      continue;
    }
    const source = await confined(project, target, 'file');
    const staged = path.join(work, target);
    await mkdir(path.dirname(staged), { recursive: true });
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await assertIntegrity(staged, entry.integrity);
    const { packageJson: manifest } = await readArtifact(staged);
    if (manifest.name !== name || manifest.version !== entry.version)
      throw new Error(`Project-local tarball identity differs from lock: ${location}`);
    locales.set(target, manifest);
    vendorJson.push(manifest);
    localInputs.set(target, {
      kind: 'file-tarball',
      path: target,
      locations: [location],
      name: manifest.name,
      version: manifest.version,
      sha256: await fileHash(staged),
      integrity: entry.integrity!,
    });
  }

  const uses = new Set<string>();
  checkDependencies(packageJson, 'root package.json', locales, { uses });
  for (const [workspace, manifest] of workspaceJson) {
    checkDependencies(manifest, workspace, locales, { prefix: workspace, uses });
    await writeJson(path.join(work, workspace, 'package.json'), manifest, { exclusive: true });
  }
  for (const manifest of vendorJson) checkDependencies(manifest, 'vendored tarball', new Map());
  for (const [location, entry] of Object.entries(lock.packages))
    checkDependencies(
      entry,
      location || 'lock root',
      !location || workspaceJson.has(location) ? locales : new Map(),
      { prefix: workspaceJson.has(location) ? location : '' },
    );
  for (const [target, entry] of localInputs)
    if (entry.kind === 'file-tarball' && !uses.has(target))
      throw new Error(`File tarball is not referenced in a checked project manifest: ${target}`);
  return [...localInputs.values()];
}
