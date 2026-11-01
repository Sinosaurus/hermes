// 文件职责：显式补齐 registry 元数据声明的可选依赖；保留原锁，记录补充解析证据。
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import type { PackageJson, SourceEntry, NpmLock } from '../types.js';
import type { Bundle } from './bundle.js';
import type { ResolvedInput } from './resolution.js';
import { entriesFromLock, validateInstallFlags } from './resolution.js';
import {
  npmJson,
  npmCommand,
  packageSpec,
  registrySpec,
  validateIdentity,
  readJson,
  writeJson,
} from '../../lib/index.js';

type Metadata = PackageJson & { os?: string[]; cpu?: string[]; libc?: string[] };
export interface PlatformClosureReport {
  mode: 'all-optional-dependencies';
  scope: string;
  edges: {
    context: string;
    parent: string;
    requested: string;
    status: 'locked' | 'bundled' | 'supplemental';
    resolved?: string;
    supplementalContext?: string;
  }[];
  platformMetadata: {
    name: string;
    version: string;
    os?: string[];
    cpu?: string[];
    libc?: string[];
  }[];
}
export interface PlatformResolver {
  metadata(entry: SourceEntry): Promise<Metadata>;
  resolve(spec: string, context: string): Promise<ResolvedInput>;
}

function findLocked(input: ResolvedInput, location: string, name: string) {
  let base = location;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    const entry = input.lock.packages[candidate];
    if (entry) return { entry, location: candidate };
    if (!base) return undefined;
    const boundary = base.lastIndexOf('/node_modules/');
    base = boundary < 0 ? '' : base.slice(0, boundary);
  }
}

function dependencySpec(name: string, range: unknown) {
  if (typeof range !== 'string' || !range.trim())
    throw new Error(`Invalid dependency range: ${name}`);
  const spec = `${name}@${range}`;
  if (registrySpec(spec) !== name) throw new Error(`Invalid dependency name: ${name}`);
  return spec;
}

/** 测试可注入只读解析器；生产路径仍使用受控 npm，不执行生命周期脚本。 */
export async function expandPlatformInputs(
  originals: ResolvedInput[],
  work: string,
  registry: string,
  installFlags: string[],
  bundle: Bundle,
  injected?: PlatformResolver,
): Promise<{ inputs: ResolvedInput[]; report: PlatformClosureReport }> {
  const flags = validateInstallFlags(installFlags);
  const resolver: PlatformResolver = injected ?? {
    metadata: (entry) =>
      npmJson<Metadata>(['view', packageSpec(entry)], { registry, packageName: entry.name }),
    resolve: async (spec, context) => {
      const name = registrySpec(spec);
      const cwd = path.join(work, context);
      await mkdir(cwd);
      // 放入 optionalDependencies，避免当前宿主平台排斥其它 OS/CPU 的根包。
      await writeJson(path.join(cwd, 'package.json'), {
        name: 'hermes-platform-resolution',
        version: '1.0.0',
        private: true,
        optionalDependencies: { [name]: spec.slice(name.length + 1) },
      });
      await npmCommand(
        [
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--include=optional',
          '--no-audit',
          '--no-fund',
          ...flags,
        ],
        { cwd, registry, packageName: name },
      );
      const packageJson = await readJson<PackageJson>(path.join(cwd, 'package.json'));
      const lock = await readJson<NpmLock>(path.join(cwd, 'package-lock.json'));
      const parsed = entriesFromLock(lock);
      if (
        !parsed.entries.some(
          (entry) => entry.name === name && entry.location === `node_modules/${name}`,
        )
      )
        throw new Error(
          `Optional dependency was not resolved; all-platform collection is incomplete: ${spec}`,
        );
      return { packageJson, lock, lockName: 'package-lock.json', parsed, context };
    },
  };
  const report: PlatformClosureReport = {
    mode: 'all-optional-dependencies',
    scope:
      'Registry-declared optional dependency closure; excludes install-script downloads and does not certify target runtime support.',
    edges: [],
    platformMetadata: [],
  };
  const inputs: ResolvedInput[] = [];
  const queue = [...originals];
  const metadataCache = new Map<string, Metadata>();
  const resolvedSpecs = new Map<string, ResolvedInput>();
  let count = 0;
  for (let index = 0; index < queue.length; index++) {
    const input = queue[index];
    for (const entry of input.parsed.entries) {
      if (++count > 100_000) throw new Error('Platform dependency traversal limit exceeded');
      const identity = packageSpec(entry);
      let metadata = metadataCache.get(identity);
      if (!metadata) {
        metadata = await resolver.metadata(entry);
        validateIdentity(metadata);
        if (packageSpec(metadata) !== identity)
          throw new Error(`Registry identity mismatch: ${identity}`);
        for (const field of ['os', 'cpu', 'libc'] as const)
          if (
            metadata[field] !== undefined &&
            (!Array.isArray(metadata[field]) ||
              metadata[field]!.some((value) => typeof value !== 'string'))
          )
            throw new Error(`Invalid ${field} metadata: ${identity}`);
        metadataCache.set(identity, metadata);
        report.platformMetadata.push({
          name: entry.name,
          version: entry.version,
          os: metadata.os,
          cpu: metadata.cpu,
          libc: metadata.libc,
        });
      }
      const optional = metadata.optionalDependencies ?? {};
      if (typeof optional !== 'object' || Array.isArray(optional))
        throw new Error(`Invalid optionalDependencies: ${identity}`);
      const bundled = metadata.bundledDependencies ?? metadata.bundleDependencies;
      for (const [name, range] of Object.entries(optional).sort(([a], [b]) => a.localeCompare(b))) {
        const requested = dependencySpec(name, range);
        const locked = findLocked(input, entry.location ?? '', name);
        const edge = { context: input.context, parent: identity, requested };
        if (
          bundled === true ||
          (Array.isArray(bundled) && bundled.includes(name)) ||
          locked?.entry.inBundle
        ) {
          report.edges.push({ ...edge, status: 'bundled' });
          continue;
        }
        if (locked) {
          validateIdentity({ name: locked.entry.name ?? name, version: locked.entry.version });
          if (semver.validRange(range) && !semver.satisfies(locked.entry.version, range))
            throw new Error(
              `Locked optional dependency does not satisfy metadata: ${identity} -> ${requested}`,
            );
          report.edges.push({
            ...edge,
            status: 'locked',
            resolved: `${name}@${locked.entry.version}`,
          });
          continue;
        }
        let supplemental = resolvedSpecs.get(requested);
        if (!supplemental) {
          const context = `platform-${inputs.length + 1}`;
          bundle.report({ phase: 'resolve-platforms', name, completed: inputs.length });
          supplemental = await resolver.resolve(requested, context);
          const root = supplemental.parsed.entries.find(
            (item) => item.location === `node_modules/${name}` && item.name === name,
          );
          if (!root || (semver.validRange(range) && !semver.satisfies(root.version, range)))
            throw new Error(`Missing or incompatible supplemental root: ${requested}`);
          resolvedSpecs.set(requested, supplemental);
          inputs.push(supplemental);
          queue.push(supplemental);
        }
        const root = supplemental.parsed.entries.find(
          (item) => item.location === `node_modules/${name}`,
        )!;
        report.edges.push({
          ...edge,
          status: 'supplemental',
          resolved: packageSpec(root),
          supplementalContext: supplemental.context,
        });
      }
      // npm 可能静默省略不可获取的 optional 子树；其已选根的必需依赖不能遗漏。
      for (const [name, range] of Object.entries(metadata.dependencies ?? {})) {
        if (
          name in optional ||
          bundled === true ||
          (Array.isArray(bundled) && bundled.includes(name))
        )
          continue;
        dependencySpec(name, range);
        const locked = findLocked(input, entry.location ?? '', name);
        if (!locked)
          throw new Error(`Required dependency missing from lock: ${identity} -> ${name}`);
      }
    }
  }
  return { inputs, report };
}
