// 文件职责：校验恢复许可与 tag 目标，生成只读发布计划和原始 tag 快照。
import type { Manifest, Tags } from '../types.js';
import { adapters, failure, valueAt, type Api, type PublishOptions } from './context.js';
import { remoteArtifact, tagsFor } from './registry.js';
import * as common from '../../lib/index.js';

export function validate(manifest: Manifest, recovery: boolean) {
  if (manifest.packages.some((pkg) => pkg.artifactKind === 'installed-repack') && !recovery)
    throw failure('Recovered artifacts require --recovery and a dedicated recovery registry');
  const names = new Map<string, Set<string>>();
  for (const pkg of manifest.packages) {
    if (!names.has(pkg.name)) names.set(pkg.name, new Set());
    names.get(pkg.name)!.add(pkg.version);
  }
  const seen = new Set();
  for (const plan of manifest.tagPlan ?? []) {
    for (const [tag, version] of Object.entries(plan.set ?? {})) {
      common.validateDistTag(tag);
      if (!names.get(plan.name)?.has(version))
        throw failure(`Tag target is outside the bundle: ${plan.name}@${version}`);
      const key = `${plan.name}:${tag}`;
      if (seen.has(key)) throw failure(`Duplicate tag plan: ${key}`);
      seen.add(key);
    }
  }
}

/** 只读预检，下载目标现有制品仅用于字节比对。 */
export async function inspectBundle(bundle: string, options: PublishOptions, api: Api) {
  const registry = common.normalizeRegistry(options.registry ?? '');
  const readRegistry = common.normalizeRegistry(options.readRegistry ?? registry);
  const { manifest, manifestDigest } = await common.verifyBundle(bundle);
  validate(manifest, options.recovery === true);
  api.stats.total = manifest.packages.length;
  api.progress({
    phase: 'plan',
    completed: 0,
    total: manifest.packages.length,
    name: undefined,
    version: undefined,
  });
  const packages = [];
  const existing = new Map();
  for (const pkg of manifest.packages) {
    api.progress({ name: pkg.name, version: pkg.version });
    const exists = await remoteArtifact(api, pkg, registry);
    packages.push({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      action: exists ? 'reuse' : 'publish',
    });
    if (exists) {
      existing.set(pkg.name, pkg.version);
      if (api.operation === 'plan') api.stats.reused++;
    }
    api.progress({ completed: packages.length });
  }
  const tagSnapshot: Record<string, Tags> = {};
  for (const name of new Set(manifest.packages.map((pkg) => pkg.name)))
    tagSnapshot[name] = await tagsFor(api, name, registry, existing.get(name));
  const tagChanges = (manifest.tagPlan ?? []).flatMap((plan) =>
    Object.entries(plan.set ?? {}).map(([tag, version]) => {
      const before = valueAt(tagSnapshot[plan.name], tag);
      return {
        name: plan.name,
        tag,
        before,
        after: version,
        conflict: before !== null && before !== version,
      };
    }),
  );
  return {
    schemaVersion: 1,
    registry,
    readRegistry,
    recovery: options.recovery === true,
    manifestDigest,
    manifest,
    packages,
    tagSnapshot,
    tagChanges,
  };
}

export async function planImport(bundle: string, options: PublishOptions = {}) {
  const api = adapters(options, 'plan');
  return { ...(await inspectBundle(bundle, options, api)), stats: { ...api.stats } };
}
